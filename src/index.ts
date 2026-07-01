import { Container, getRandom } from "@cloudflare/containers";

/**
 * Aveeone — a Cloudflare Worker that transcodes a source MP4 to AV1/AAC on the
 * fly using a Workers Container running ffmpeg (libsvtav1).
 *
 * URL shape (mirrors Cloudflare Media Transformations):
 *
 *   https://<host>/<ARBITRARY_TEXT>/<SOURCE_URL>
 *
 * The first path segment (<ARBITRARY_TEXT>) would normally carry transform
 * options; this project ignores it. Everything after that first segment is
 * treated as the full source URL to fetch and transcode.
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
 * gen1 - produces UNEDITED assets only, only in AC1/AAC
 */
const OUTPUT_PREFIX = "gen1";

/** Multipart part size while streaming the encode into R2 (>= 5 MiB required). */
const R2_PART_SIZE = 8 * 1024 * 1024;

/** Maximum accepted source file size (enforced in the Worker before the container sees it). */
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Derive the R2 object key for a request. The hash covers BOTH the options
 * segment (ARBITRARY_TEXT) and the source URL, so changing the options changes
 * the key — a cache bust today, and the cache identity for edit parameters once
 * ARBITRARY_TEXT is wired into ffmpeg. SHA-256 is virtually collision-free and
 * keeps keys fixed-length and opaque. The "\n" separator is unambiguous because
 * a path segment can't contain a newline.
 */
async function outputKey(options: string, sourceUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${options}\n${sourceUrl}`),
  );
  const hash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${OUTPUT_PREFIX}/av1-unedited/${hash}`;
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
 * - `options` is the first path segment (ARBITRARY_TEXT). Today it's opaque and
 *   only used as a cache key input (a cache bust); later it carries ffmpeg edit
 *   parameters.
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
  sourceUrl: string,
  requestId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  // Fetch the source here in the Worker. Worker network to CF-hosted resources
  // (R2, etc.) is fast and unthrottled; the container's network interface is
  // the bottleneck (~0.7 MB/s observed), so keeping the download in the Worker
  // and piping the body to the container cuts ~37s off a 28 MB source fetch.
  const fetchStart = Date.now();
  let sourceResponse: Response;
  try {
    sourceResponse = await fetch(sourceUrl);
  } catch (err) {
    return {
      ok: false,
      response: failure(500, {
        error: "Failed to fetch source URL",
        stage: "preflight",
        requestId,
        sourceUrl,
        details: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  if (!sourceResponse.ok) {
    await sourceResponse.body?.cancel();
    return {
      ok: false,
      response: failure(500, {
        error: "Source URL returned a non-2xx status",
        stage: "preflight",
        requestId,
        sourceUrl,
        httpStatus: sourceResponse.status,
      }),
    };
  }

  const contentLength = Number(sourceResponse.headers.get("content-length") ?? 0);
  if (contentLength > 0 && contentLength > MAX_SOURCE_BYTES) {
    await sourceResponse.body?.cancel();
    return {
      ok: false,
      response: failure(500, {
        error: "Source exceeds the maximum allowed input size",
        stage: "preflight",
        requestId,
        sourceUrl,
        contentLength,
        maxInputBytes: MAX_SOURCE_BYTES,
      }),
    };
  }

  const fetchElapsedMs = Date.now() - fetchStart;
  console.log(
    "aveeone.timing.fetch",
    JSON.stringify({ requestId, sourceUrl, contentLength, fetchElapsedMs }),
  );

  // POST the source body directly to the container. The container pipes it into
  // ffmpeg stdin — no network download needed inside the container.
  const container = await getRandom(env.TRANSCODER, POOL_SIZE);
  const containerRequest = new Request("http://container/transcode", {
    method: "POST",
    body: sourceResponse.body,
    headers: {
      "x-request-id": requestId,
      "x-source-url": sourceUrl, // kept for logging inside the container
    },
  });

  const containerStart = Date.now();
  const response = await container.fetch(containerRequest);
  const containerElapsedMs = Date.now() - containerStart;

  // The container only returns 200 video/mp4 on a verified-successful encode;
  // anything else is an error payload we pass straight through (nothing cached).
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !contentType.startsWith("video/mp4")) {
    return { ok: false, response };
  }

  // Log the phase breakdown visible from the Worker side.
  const ffmpegElapsedMs = Number(response.headers.get("x-ffmpeg-elapsed-ms") ?? 0);
  const nproc = response.headers.get("x-nproc") ?? "unknown";
  console.log(
    "aveeone.timing.container",
    JSON.stringify({ requestId, containerElapsedMs, ffmpegElapsedMs, nproc }),
  );

  if (!response.body) {
    return {
      ok: false,
      response: failure(500, {
        error: "Container returned a 200 with no body",
        stage: "generate",
        requestId,
        sourceUrl,
      }),
    };
  }

  const multipart = await env.OUTPUTS.createMultipartUpload(key, {
    httpMetadata: { contentType: "video/mp4" },
    customMetadata: { sourceUrl, requestId },
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

  const r2Start = Date.now();
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        append(value);
        // Drain as many full, fixed-size parts as we have.
        while (pending.length >= R2_PART_SIZE) {
          const part = pending.slice(0, R2_PART_SIZE);
          pending = pending.slice(R2_PART_SIZE);
          parts.push(await multipart.uploadPart(partNumber++, part));
        }
      }
    }
    // Final (trailing) part may be any size; only upload if there's data left.
    if (pending.length > 0) {
      parts.push(await multipart.uploadPart(partNumber++, pending));
    }
    if (parts.length === 0) {
      throw new Error("Encode produced no output bytes");
    }
    await multipart.complete(parts);
    const r2ElapsedMs = Date.now() - r2Start;
    console.log(
      "aveeone.cache.stored",
      JSON.stringify({ requestId, key, parts: parts.length, r2ElapsedMs }),
    );
    return { ok: true };
  } catch (err) {
    // Never leave a partial object behind.
    await multipart.abort().catch(() => {});
    return {
      ok: false,
      response: failure(500, {
        error: "Failed while streaming the transcode into R2",
        stage: "generate-store",
        requestId,
        sourceUrl,
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

    console.log(
      "aveeone.request",
      JSON.stringify({ requestId, options, sourceUrl: sourceStr, key }),
    );

    try {
      // 3. Cache hit? Serve straight from R2 (with Range support).
      const cached = await serveFromR2(env, key, request, requestId);
      if (cached) return cached;

      // HEAD on a miss doesn't trigger an encode.
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 404,
          headers: { "x-request-id": requestId, "x-cache": "miss" },
        });
      }

      // 4. Cache miss: transcode + persist to R2, then serve from R2.
      //    waitUntil keeps the upload alive even if the client disconnects
      //    mid-encode, so the object still lands for the next request.
      const task = generateAndStore(env, key, sourceStr, requestId);
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
