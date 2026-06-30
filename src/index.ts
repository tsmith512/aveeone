import { Container } from "@cloudflare/containers";

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
}

/**
 * Fallback source used when the request path doesn't include a source URL.
 * Doubles as the default test footage.
 */
const DEFAULT_SOURCE_URL = "https://assets.tsmith.net/aus-mobile.mp4";

/**
 * The Container-backed Durable Object. One ffmpeg process runs per instance.
 * `enableInternet` is required so ffmpeg can fetch the source video directly.
 */
export class Transcoder extends Container<Env> {
  // The HTTP server inside the container listens here (see container_src/server.mjs).
  defaultPort = 8080;
  // ffmpeg can run far longer than realtime for AV1; keep the instance warm a
  // while, but the per-request keepalive in the container guards long encodes.
  sleepAfter = "10m";
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
 * Extract the source URL from the request path.
 *
 * `URL.pathname` preserves the literal `https://...` (it does not collapse the
 * `//`), and any query string on the source lives in `url.search`, so we
 * reconstruct the full source URL from both.
 */
function extractSourceUrl(requestUrl: string): string | null {
  const url = new URL(requestUrl);

  // Drop the leading "/", then split off the first segment (ARBITRARY_TEXT).
  const afterLeadingSlash = url.pathname.replace(/^\/+/, "");
  const firstSlash = afterLeadingSlash.indexOf("/");
  if (firstSlash === -1) return null; // no source URL component present

  let source = afterLeadingSlash.slice(firstSlash + 1);
  if (source.length === 0) return null;

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

  return source;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();

    if (request.method !== "GET" && request.method !== "HEAD") {
      return failure(500, {
        error: "Only GET/HEAD requests are supported",
        stage: "request-validation",
        requestId,
        method: request.method,
      });
    }

    // 1. Parse the source URL out of the path. If none is present, fall back
    //    to the default test footage.
    const sourceUrl = extractSourceUrl(request.url) ?? DEFAULT_SOURCE_URL;

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

    console.log(
      "aveeone.request",
      JSON.stringify({ requestId, sourceUrl: parsedSource.toString() }),
    );

    // 3. Hand the job to a fresh container instance (one ffmpeg per instance).
    //    A unique id gives us per-job isolation up to `max_instances`.
    try {
      const container = env.TRANSCODER.getByName(requestId);

      // The container's HTTP server reads the source URL from this header.
      const containerRequest = new Request("http://container/transcode", {
        method: request.method,
        headers: {
          "x-source-url": parsedSource.toString(),
          "x-request-id": requestId,
        },
      });

      // The @cloudflare/containers base class handles start + port readiness
      // and proxies to `defaultPort`. The container returns either a streaming
      // 200 (video/mp4) or a 500 JSON error, which we pass straight through.
      const response = await container.fetch(containerRequest);

      // Surface the request id for tracing/debugging on the way out.
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      return failure(500, {
        error: "Failed to dispatch the transcode job to a container",
        stage: "container-dispatch",
        requestId,
        sourceUrl: parsedSource.toString(),
        details: err instanceof Error ? err.message : String(err),
      });
    }
  },
} satisfies ExportedHandler<Env>;
