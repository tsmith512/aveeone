import { Container, getRandom } from "@cloudflare/containers";

/**
 * Aveeone — a Cloudflare Worker that transcodes a source MP4 to AV1/AAC on the
 * fly using a Workers Container running ffmpeg (libsvtav1).
 *
 * URL shape (mirrors Cloudflare Media Transformations):
 *
 *   https://<host>/<OPTIONS>/<SOURCE_URL>
 *
 * The first path segment (<OPTIONS>) is used verbatim (unnormalized) as part
 * of the R2 cache key, so it always at least acts as a manual cache buster.
 * If it contains an "=" (i.e. it looks like real Media Transformations
 * options, e.g. "width=640,height=360"), it is ALSO forwarded to Cloudflare
 * Media Transformations first (`/cdn-cgi/media/<OPTIONS>/<SOURCE_URL>`), and
 * the resulting edited variant — not the original source — is what gets fed
 * into the AV1 transcoder. See `resolveEncodeUrl()` below.
 */

export interface Env {
  TRANSCODER: DurableObjectNamespace<Transcoder>;
  OUTPUTS: R2Bucket;
}

/**
 * Fallback source used when the request path doesn't include a source URL.
 * Doubles as the default test footage.
 */
const DEFAULT_SOURCE_URL = "https://assets.tsmith.net/aus-mobile.mp4";

/**
 * Number of long-lived container instances to maintain. getRandom() spreads
 * requests across "transcoder-0" … "transcoder-N-1".
 */
const POOL_SIZE = 2;

/**
 * R2 key namespace for cached outputs by project generation.
 *
 * gen1 - produces UNEDITED assets only, only in AV1/AAC
 * gen2 - transcodes CF Media Transformations results to AV1/AAC
 * gen3 - CRF bumped 30 -> 36 (VMAF-informed; see README v0.3.1 findings)
 */
const OUTPUT_PREFIX = "gen3";

/** Multipart part size while streaming the encode into R2 (>= 5 MiB required). */
const R2_PART_SIZE = 8 * 1024 * 1024;

/** Maximum accepted source file size (enforced in the Worker before the container sees it). */
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Derive the R2 object key for a request. The hash covers BOTH the options
 * segment (OPTIONS) and the source URL, so changing the options changes
 * the key — either a manual cache bust, or the cache identity for a distinct
 * set of Media Transformations edit parameters. SHA-256 is virtually
 * collision-free and keeps keys fixed-length and opaque. The "\n" separator is
 * unambiguous because a path segment can't contain a newline.
 *
 * NOTE: `options` is hashed exactly as received — it is NOT normalized. Two
 * requests with semantically-identical but differently-formatted options
 * strings (e.g. differing key order, or `a=1,b=2` vs `b=2,a=1`) are treated
 * as distinct cache entries and each trigger their own encode. See the
 * "Known trade-offs & limitations" section of README.md.
 */
async function outputKey(options: string, sourceUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${options}\n${sourceUrl}`),
  );
  const hash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${OUTPUT_PREFIX}/av1/${hash}`;
}

/**
 * Decide what URL the transcoder container should actually fetch and encode.
 *
 * - If `options` contains an "=" it's treated as real Media Transformations
 *   parameters (e.g. "width=640,height=360"). The entire options string is
 *   forwarded, as-is, to this Worker's own Media Transformations endpoint
 *   (`/cdn-cgi/media/<options>/<sourceUrl>`) — a path Cloudflare intercepts at
 *   the edge, ahead of Worker routing — and the resulting *edited* variant
 *   becomes the input to the AV1 encode. In this mode, `options` doubles as
 *   the cache buster (a different edit produces a different R2 key, per
 *   `outputKey()`) AND drives an actual transform.
 * - Otherwise, `options` is opaque and only participates in the cache key —
 *   the original behaviour. The container encodes `sourceUrl` directly.
 *
 * `requestOrigin` is taken from the inbound request (not hardcoded) so this
 * works under any host the Worker is served from (custom domain, preview
 * URL, etc).
 */
function resolveEncodeUrl(
  requestOrigin: string,
  options: string,
  sourceUrl: string,
): { encodeUrl: string; isMediaTransform: boolean } {
  const isMediaTransform = options.includes("=");
  if (!isMediaTransform) {
    return { encodeUrl: sourceUrl, isMediaTransform };
  }
  const encodeUrl = `${requestOrigin}/cdn-cgi/media/${options}/${sourceUrl}`;
  return { encodeUrl, isMediaTransform };
}

/**
 * The Container-backed Durable Object. One ffmpeg process runs per instance.
 * `enableInternet` is required so ffmpeg can fetch the source video directly.
 */
export class Transcoder extends Container<Env> {
  // The HTTP server inside the container listens here (see container_src/server.mjs).
  defaultPort = 8080;
  sleepAfter = "5m";
  // Required: the container must reach the public internet to pull the source.
  enableInternet = true;
}

/** A failure that should surface to the client as an HTTP 500 JSON payload. */
interface FailureInfo {
  error: string;
  stage: string;
  [key: string]: unknown;
}

function failure(status: number, info: FailureInfo): Response {
  // Per the project spec, all failures return JSON with as much context as
  // possible. We log it too so it shows up in Workers traces/observability.
  console.error("aveeone.failure", JSON.stringify(info));
  return new Response(JSON.stringify(info, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Parse the request path into its two components:
 *
 *   /<options>/<source-url>
 *
 * - `options` is the first path segment (OPTIONS), used verbatim as a cache
 *   key input. If it contains an "=" it is also forwarded to Cloudflare Media
 *   Transformations (see `resolveEncodeUrl()`); otherwise it's just a manual
 *   cache buster, same as before.
 * - `sourceUrl` is everything after it, or null if absent (caller substitutes
 *   the default footage).
 *
 * `URL.pathname` preserves the literal `https://...` (it does not collapse the
 * `//`), and any query string on the source lives in `url.search`, so we
 * reconstruct the full source URL from both.
 */
function parseRequestPath(requestUrl: string): {
  options: string;
  sourceUrl: string | null;
} {
  const url = new URL(requestUrl);

  // Drop the leading "/", then split off the first segment (the options).
  const afterLeadingSlash = url.pathname.replace(/^\/+/, "");
  const firstSlash = afterLeadingSlash.indexOf("/");

  if (firstSlash === -1) {
    // Only a single segment (or none): treat it as options with no source URL.
    return { options: afterLeadingSlash, sourceUrl: null };
  }

  const options = afterLeadingSlash.slice(0, firstSlash);
  let source = afterLeadingSlash.slice(firstSlash + 1);
  if (source.length === 0) return { options, sourceUrl: null };

  // Re-attach the source's own query string, if any.
  source += url.search;

  // Support both literal (".../https://e.com/v.mp4") and percent-encoded forms.
  if (!/^https?:\/\//i.test(source)) {
    try {
      const decoded = decodeURIComponent(source);
      if (/^https?:\/\//i.test(decoded)) source = decoded;
    } catch {
      // fall through; validation below will reject it
    }
  }

  return { options, sourceUrl: source };
}

/**
 * Serve a cached object from R2, honouring a Range request if present.
 * Returns null if the object isn't in R2 yet.
 */
async function serveFromR2(
  env: Env,
  key: string,
  request: Request,
  requestId: string,
): Promise<Response | null> {
  // HEAD: metadata only, no body / no range slicing.
  if (request.method === "HEAD") {
    const meta = await env.OUTPUTS.head(key);
    if (!meta) return null;
    const headers = new Headers();
    meta.writeHttpMetadata(headers);
    headers.set("content-type", "video/mp4");
    headers.set("content-length", String(meta.size));
    headers.set("accept-ranges", "bytes");
    headers.set("etag", meta.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("x-request-id", requestId);
    headers.set("x-cache", "hit");
    return new Response(null, { status: 200, headers });
  }

  // GET: pass the request headers so R2 parses any Range for us.
  const object = await env.OUTPUTS.get(key, { range: request.headers });
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "video/mp4");
  headers.set("accept-ranges", "bytes");
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-request-id", requestId);
  headers.set("x-cache", "hit");

  // If the client sent a satisfiable Range, R2 populates object.range.
  const range = object.range as { offset?: number; length?: number } | undefined;
  const hasRange = request.headers.has("range") && range !== undefined;

  if (hasRange) {
    const offset = range!.offset ?? 0;
    const length = range!.length ?? object.size - offset;
    const end = offset + length - 1;
    headers.set("content-range", `bytes ${offset}-${end}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("content-length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/**
 * Cache miss: ask a container to transcode the source, then stream the result
 * into R2 via a multipart upload. Resolves once the object is fully committed
 * to R2 (or throws/returns the container's error response).
 *
 * Memory stays bounded by R2_PART_SIZE regardless of output size, and we only
 * `complete()` the upload on a clean end-of-stream — a mid-encode failure
 * surfaces as a non-200 from the container (it writes to disk and only responds
 * on ffmpeg exit 0), so a truncated object is never cached.
 */
async function generateAndStore(
  env: Env,
  key: string,
  encodeUrl: string,
  requestId: string,
  originalSourceUrl: string,
  isMediaTransform: boolean,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  // Preflight: confirm the encode input is reachable (and, where possible,
  // within the size limit) before committing a container to the job. This
  // targets `encodeUrl` — for a Media Transformations request that's the
  // `/cdn-cgi/media/...` edited-variant URL, not the original source — since
  // that's what the container actually downloads.
  //
  // The two cases need different strategies:
  //
  // - Plain source (`isMediaTransform` false): a cheap HEAD, as before.
  // - Media Transformations (`isMediaTransform` true): `/cdn-cgi/media/...`
  //   does not support HEAD or Range — Cloudflare intercepts it as an edge
  //   transform, not a static file server, so a HEAD here would always look
  //   like a failure even on success. Media Transformations already validates
  //   the source and edit parameters itself (reachability, size, etc.), so we
  //   do a real GET and trust its response: a video/* response means the edit
  //   succeeded and is safe to hand to the container. Anything else — a
  //   non-2xx status, or a non-video content-type on a 200 — is surfaced
  //   directly as a preflight error, since Media Transformations' own status/
  //   body IS the real error (bad params, unreachable/oversized source, etc).
  //   We never read the body on success; the container fetches its own copy,
  //   so we cancel the stream to avoid buffering the whole video here.
  const fetchStart = Date.now();
  try {
    if (isMediaTransform) {
      const preflight = await fetch(encodeUrl, { method: "GET" });
      const fetchElapsedMs = Date.now() - fetchStart;
      const contentType = preflight.headers.get("content-type") ?? "";

      if (!preflight.ok || !contentType.startsWith("video/")) {
        const bodyText = await preflight.text().catch(() => "");
        return {
          ok: false,
          response: failure(500, {
            error: "Media Transformations request failed",
            stage: "preflight",
            requestId,
            sourceUrl: originalSourceUrl,
            encodeUrl,
            httpStatus: preflight.status,
            contentType: contentType || null,
            details: bodyText.slice(0, 4000) || undefined,
          }),
        };
      }

      await preflight.body?.cancel().catch(() => {});
      console.log("aveeone.preflight.ok", JSON.stringify({
        requestId, encodeUrl, originalSourceUrl, mediaTransform: true, contentType, fetchElapsedMs,
      }));
    } else {
      // @TODO: some origins return 405 for HEAD or omit Content-Length. Currently
      // we skip the checks that can't be satisfied and proceed to transcode. A
      // future improvement could try a Range: bytes=0-0 GET as a fallback to at
      // least confirm reachability when HEAD is not supported.
      const preflight = await fetch(encodeUrl, { method: "HEAD" });
      const fetchElapsedMs = Date.now() - fetchStart;

      if (preflight.status === 405) {
        // Origin doesn't support HEAD — skip checks and let ffmpeg try directly.
        console.log("aveeone.preflight.skip", JSON.stringify({
          requestId, encodeUrl, originalSourceUrl, reason: "HEAD 405", fetchElapsedMs,
        }));
      } else if (!preflight.ok) {
        return {
          ok: false,
          response: failure(500, {
            error: "Source URL returned a non-2xx status",
            stage: "preflight",
            requestId,
            sourceUrl: originalSourceUrl,
            encodeUrl,
            httpStatus: preflight.status,
          }),
        };
      } else {
        const contentLength = Number(preflight.headers.get("content-length") ?? 0);
        if (contentLength > 0 && contentLength > MAX_SOURCE_BYTES) {
          return {
            ok: false,
            response: failure(500, {
              error: "Source exceeds the maximum allowed input size",
              stage: "preflight",
              requestId,
              sourceUrl: originalSourceUrl,
              encodeUrl,
              contentLength,
              maxInputBytes: MAX_SOURCE_BYTES,
            }),
          };
        }
        // @TODO: if contentLength === 0 the origin didn't send Content-Length;
        // size cap cannot be enforced. Could use Range: bytes=0-0 to at least
        // confirm reachability and get the true size from Content-Range.
        console.log("aveeone.preflight.ok", JSON.stringify({
          requestId, encodeUrl, originalSourceUrl, contentLength: contentLength || null, fetchElapsedMs,
        }));
      }
    }
  } catch (err) {
    return {
      ok: false,
      response: failure(500, {
        error: isMediaTransform
          ? "Media Transformations preflight request failed"
          : "Source preflight request failed",
        stage: "preflight",
        requestId,
        sourceUrl: originalSourceUrl,
        encodeUrl,
        details: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  // Dispatch the job to a pooled container instance. The container fetches
  // `encodeUrl` directly with ffmpeg — the standard job-descriptor pattern for
  // a transcoding service (URL in, encoded file out). ffmpeg's native HTTP
  // client handles reconnects and HTTP-level seeking (e.g. moov-at-end
  // recovery). For a Media Transformations request, `encodeUrl` points at the
  // `/cdn-cgi/media/...` edited variant. The container never sees the
  // original source URL, but it DOES need `isMediaTransform`: a Media
  // Transformations derivative already has its audio re-encoded to AAC by
  // Cloudflare (see `otfe`'s `-b:a 64k`), so the container copies that track
  // instead of paying for a second lossy re-encode; a raw source gets a
  // fresh AAC encode at a pinned bitrate. See `buildFfmpegArgs()` in
  // container_src/server.mjs.
  const dispatchedAt = Date.now();
  const container = await getRandom(env.TRANSCODER, POOL_SIZE);
  const containerRequest = new Request("http://container/transcode", {
    method: "GET",
    headers: {
      "x-source-url": encodeUrl,
      "x-request-id": requestId,
      "x-media-transform": String(isMediaTransform),
      // Used by the container to measure cold-start + routing latency.
      "x-dispatched-at": String(dispatchedAt),
    },
  });

  const response = await container.fetch(containerRequest);
  const uploadStart = Date.now();

  // The container only returns 200 video/mp4 on a verified-successful encode;
  // anything else is an error payload we pass straight through (nothing cached).
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !contentType.startsWith("video/mp4")) {
    return { ok: false, response };
  }

  if (!response.body) {
    return {
      ok: false,
      response: failure(500, {
        error: "Container returned a 200 with no body",
        stage: "generate",
        requestId,
        sourceUrl: originalSourceUrl,
        encodeUrl,
      }),
    };
  }

  // Read timing headers the container populated for the consolidated log below.
  const containerStartMs   = Number(response.headers.get("x-container-start-ms") || 0) || null;
  const downloadElapsedMs  = Number(response.headers.get("x-download-elapsed-ms") || 0);
  const encodeElapsedMs    = Number(response.headers.get("x-encode-elapsed-ms")   || 0);
  const inputBytes         = Number(response.headers.get("x-input-size")          || 0);
  const outputBytes        = Number(response.headers.get("content-length")        || 0);
  const nproc              = response.headers.get("x-nproc") ?? "unknown";

  const multipart = await env.OUTPUTS.createMultipartUpload(key, {
    httpMetadata: { contentType: "video/mp4" },
    customMetadata: { sourceUrl: originalSourceUrl, encodeUrl, requestId },
  });

  const parts: R2UploadedPart[] = [];
  let partNumber = 1;

  // Accumulate bytes and emit parts of EXACTLY R2_PART_SIZE. R2 requires all
  // non-trailing parts to be the same length; only the final part may differ.
  let pending = new Uint8Array(0);
  const append = (chunk: Uint8Array) => {
    const merged = new Uint8Array(pending.length + chunk.length);
    merged.set(pending, 0);
    merged.set(chunk, pending.length);
    pending = merged;
  };

  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        append(value);
        while (pending.length >= R2_PART_SIZE) {
          const part = pending.slice(0, R2_PART_SIZE);
          pending = pending.slice(R2_PART_SIZE);
          parts.push(await multipart.uploadPart(partNumber++, part));
        }
      }
    }
    if (pending.length > 0) {
      parts.push(await multipart.uploadPart(partNumber++, pending));
    }
    if (parts.length === 0) {
      throw new Error("Encode produced no output bytes");
    }
    await multipart.complete(parts);
    const uploadElapsedMs = Date.now() - uploadStart;

    // Single structured timing event covering the full encode pipeline.
    // containerStartMs is null when x-dispatched-at was not echoed (old image).
    console.log("aveeone.timing", JSON.stringify({
      requestId,
      sourceUrl: originalSourceUrl,
      encodeUrl,          // what the container actually fetched (== sourceUrl unless Media Transformations was used)
      containerStartMs,   // cold-start + routing: ~0 when warm, ~2-3s on cold start
      downloadElapsedMs,  // source fetch inside the container
      encodeElapsedMs,    // ffmpeg wall-clock time
      uploadElapsedMs,    // container→Worker stream + R2 multipart write
      inputBytes,         // source file size (bytes)
      outputBytes,        // encoded output size (bytes)
      nproc,
    }));

    return { ok: true };
  } catch (err) {
    await multipart.abort().catch(() => {});
    return {
      ok: false,
      response: failure(500, {
        error: "Failed while streaming the transcode into R2",
        stage: "generate-store",
        requestId,
        sourceUrl: originalSourceUrl,
        encodeUrl,
        details: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const requestId = crypto.randomUUID();

    if (request.method !== "GET" && request.method !== "HEAD") {
      return failure(500, {
        error: "Only GET/HEAD requests are supported",
        stage: "request-validation",
        requestId,
        method: request.method,
      });
    }

    // 1. Parse the path into its options segment + source URL. If no source URL
    //    is present, fall back to the default test footage.
    const { options, sourceUrl: parsedUrl } = parseRequestPath(request.url);
    const sourceUrl = parsedUrl ?? DEFAULT_SOURCE_URL;

    // 2. Validate it's a fetchable absolute http(s) URL.
    let parsedSource: URL;
    try {
      parsedSource = new URL(sourceUrl);
    } catch {
      return failure(500, {
        error: "Source is not a valid absolute URL",
        stage: "validate-source-url",
        requestId,
        sourceUrl,
      });
    }
    if (parsedSource.protocol !== "http:" && parsedSource.protocol !== "https:") {
      return failure(500, {
        error: "Source URL must use http or https",
        stage: "validate-source-url",
        requestId,
        sourceUrl,
        protocol: parsedSource.protocol,
      });
    }

    const sourceStr = parsedSource.toString();
    const key = await outputKey(options, sourceStr);

    // 3. If OPTIONS looks like real Media Transformations parameters (it
    //    contains "="), resolve the URL the container should actually encode
    //    to the `/cdn-cgi/media/...` edited variant. Otherwise OPTIONS is just
    //    an opaque cache buster and the container encodes sourceStr directly.
    //    Either way, the R2 key above is unaffected — it's always keyed on the
    //    literal (options, sourceStr) pair.
    const requestOrigin = new URL(request.url).origin;
    const { encodeUrl, isMediaTransform } = resolveEncodeUrl(requestOrigin, options, sourceStr);

    console.log(
      "aveeone.request",
      JSON.stringify({ requestId, options, sourceUrl: sourceStr, isMediaTransform, encodeUrl, key }),
    );

    try {
      // 4. Cache hit? Serve straight from R2 (with Range support).
      const cached = await serveFromR2(env, key, request, requestId);
      if (cached) return cached;

      // HEAD on a miss doesn't trigger an encode.
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 404,
          headers: { "x-request-id": requestId, "x-cache": "miss" },
        });
      }

      // 5. Cache miss: transcode + persist to R2, then serve from R2.
      //    waitUntil keeps the upload alive even if the client disconnects
      //    mid-encode, so the object still lands for the next request.
      const task = generateAndStore(env, key, encodeUrl, requestId, sourceStr, isMediaTransform);
      ctx.waitUntil(task.then(() => undefined).catch(() => undefined));

      const result = await task;
      if (!result.ok) return result.response;

      const served = await serveFromR2(env, key, request, requestId);
      if (served) {
        served.headers.set("x-cache", "miss");
        return served;
      }

      // Should be unreachable: we just stored it.
      return failure(500, {
        error: "Object missing from R2 immediately after store",
        stage: "post-store-read",
        requestId,
        sourceUrl: sourceStr,
        key,
      });
    } catch (err) {
      return failure(500, {
        error: "Failed to dispatch the transcode job",
        stage: "container-dispatch",
        requestId,
        sourceUrl: sourceStr,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  },
} satisfies ExportedHandler<Env>;
