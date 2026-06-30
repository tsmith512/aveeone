// Aveeone container server.
//
// A tiny HTTP server that the Worker talks to. For each /transcode request it
// spawns ffmpeg, which fetches the source URL itself and transcodes to
// AV1 (libsvtav1) / AAC, emitting a *fragmented* MP4 to stdout so it can be
// streamed straight back through the Worker as the HTTP response body.
//
// Written as plain ESM JS so the container image needs only Node + ffmpeg
// (no TypeScript build step).

import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";

const PORT = Number(process.env.PORT) || 8080;

// Reject sources larger than this before we bother spawning ffmpeg.
const MAX_INPUT_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Preflight the source URL with curl before transcoding:
 *  - confirm it's reachable (final HTTP status is 2xx after following redirects)
 *  - reject inputs whose Content-Length exceeds MAX_INPUT_BYTES
 *
 * Resolves with { httpCode, contentLength } on success, or rejects with an
 * Error carrying a `.info` payload describing the failure.
 */
function preflightSource(sourceUrl) {
  return new Promise((resolve, reject) => {
    // -s silent, -I HEAD, -L follow redirects. We capture the final status and
    // downloaded content-length via curl's -w template so we don't have to
    // parse multiple redirect header blocks ourselves.
    const args = [
      "-sIL",
      "--max-time",
      "20",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code} %{size_download} %{header_json}",
      sourceUrl,
    ];

    execFile("curl", args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const e = new Error("Source URL is not accessible");
        e.info = {
          error: "Source URL is not accessible (curl preflight failed)",
          stage: "preflight",
          details: err.message,
        };
        return reject(e);
      }

      // stdout: "<http_code> <size_download> <header_json>"
      const firstSpace = stdout.indexOf(" ");
      const secondSpace = stdout.indexOf(" ", firstSpace + 1);
      const httpCode = Number(stdout.slice(0, firstSpace));
      const headerJsonRaw = stdout.slice(secondSpace + 1).trim();

      if (!Number.isFinite(httpCode) || httpCode < 200 || httpCode >= 400) {
        const e = new Error("Source URL not reachable");
        e.info = {
          error: "Source URL did not return a successful status",
          stage: "preflight",
          httpCode,
        };
        return reject(e);
      }

      // Pull Content-Length out of the (case-insensitive) header JSON map.
      // curl's header_json values are arrays of strings.
      let contentLength = null;
      try {
        const headers = JSON.parse(headerJsonRaw);
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === "content-length") {
            const raw = Array.isArray(value) ? value[value.length - 1] : value;
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) contentLength = parsed;
            break;
          }
        }
      } catch {
        // No usable header JSON; we proceed but can't enforce the size cap.
      }

      if (contentLength !== null && contentLength > MAX_INPUT_BYTES) {
        const e = new Error("Source too large");
        e.info = {
          error: "Source exceeds the maximum allowed input size",
          stage: "preflight",
          httpCode,
          contentLength,
          maxInputBytes: MAX_INPUT_BYTES,
        };
        return reject(e);
      }

      resolve({ httpCode, contentLength });
    });
  });
}

// ffmpeg encode settings are fixed per the project spec (no options/flags).
// Input options go *before* -i. We add reconnect options for resilience when
// pulling the source over http(s).
function buildFfmpegArgs(sourceUrl) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    // Resilience for the network source:
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "2",
    "-i",
    sourceUrl,
    // Video: AV1 via SVT-AV1
    "-c:v",
    "libsvtav1",
    "-preset",
    "6",
    "-crf",
    "26",
    // Audio: AAC
    "-c:a",
    "aac",
    // Drop data streams, and drop chapters. Chapters from the source are
    // otherwise written by the MP4 muxer as a "text"/bin_data track (which -dn
    // does not remove), so we strip them explicitly to keep output to v+a only.
    "-dn",
    "-map_chapters",
    "-1",
    // Fragmented MP4 so the moov atom isn't required at the end -> streamable
    // out of a pipe (no seekable output / faststart needed).
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1",
  ];
}

const MAX_STDERR_BYTES = 64 * 1024; // keep the tail of ffmpeg stderr for errors

function sendJsonError(res, status, info) {
  const body = JSON.stringify(info, null, 2);
  // Only set headers if we haven't already started streaming a 200.
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  }
  res.end(body);
  console.error("aveeone.container.failure", JSON.stringify(info));
}

async function handleTranscode(req, res) {
  const sourceUrl = req.headers["x-source-url"];
  const requestId = req.headers["x-request-id"] || "unknown";

  if (!sourceUrl || typeof sourceUrl !== "string") {
    return sendJsonError(res, 500, {
      error: "Missing X-Source-Url header",
      stage: "container-validate",
      requestId,
    });
  }

  // HEAD: report the content type without doing any work.
  if (req.method === "HEAD") {
    res.writeHead(200, { "content-type": "video/mp4" });
    return res.end();
  }

  // Preflight: confirm the source is reachable and not too large *before* we
  // commit to spawning ffmpeg and streaming a response.
  try {
    const { httpCode, contentLength } = await preflightSource(sourceUrl);
    console.log(
      "aveeone.container.preflight",
      JSON.stringify({ requestId, sourceUrl, httpCode, contentLength }),
    );
  } catch (err) {
    return sendJsonError(res, 500, {
      ...(err && err.info ? err.info : { error: String(err), stage: "preflight" }),
      requestId,
      sourceUrl,
    });
  }

  const args = buildFfmpegArgs(sourceUrl);
  console.log(
    "aveeone.container.spawn",
    JSON.stringify({ requestId, sourceUrl }),
  );

  let ffmpeg;
  try {
    ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return sendJsonError(res, 500, {
      error: "Failed to spawn ffmpeg",
      stage: "spawn",
      requestId,
      sourceUrl,
      details: err instanceof Error ? err.message : String(err),
    });
  }

  // Ring-ish buffer of the most recent stderr output, for error reporting.
  let stderrTail = "";
  ffmpeg.stderr.on("data", (chunk) => {
    stderrTail += chunk.toString();
    if (stderrTail.length > MAX_STDERR_BYTES) {
      stderrTail = stderrTail.slice(stderrTail.length - MAX_STDERR_BYTES);
    }
  });

  let streaming = false; // true once we've committed a 200 + started piping
  let settled = false; // guards against double-responding

  // If the client/Worker goes away, kill ffmpeg so we don't leak the process.
  const onClientGone = () => {
    if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
  };
  res.on("close", onClientGone);

  // Only commit to a 200 once ffmpeg actually produces output. This lets us
  // still return a clean 500 JSON for early failures (bad URL, decode error,
  // unsupported input, etc.) before any bytes are sent.
  ffmpeg.stdout.once("data", (firstChunk) => {
    if (settled) return;
    streaming = true;
    res.writeHead(200, {
      "content-type": "video/mp4",
      "x-request-id": String(requestId),
      "cache-control": "no-store",
    });
    res.write(firstChunk);
    ffmpeg.stdout.pipe(res);
  });

  ffmpeg.on("error", (err) => {
    if (settled) return;
    settled = true;
    if (!streaming) {
      sendJsonError(res, 500, {
        error: "ffmpeg process error",
        stage: "ffmpeg-error",
        requestId,
        sourceUrl,
        details: err instanceof Error ? err.message : String(err),
        stderr: stderrTail.trim() || undefined,
      });
    } else {
      // Already streaming; can't change status. Truncate the response.
      res.end();
      console.error(
        "aveeone.container.mid-stream-error",
        JSON.stringify({ requestId, details: String(err) }),
      );
    }
  });

  ffmpeg.on("close", (code, signal) => {
    if (settled) return;
    settled = true;

    if (code === 0) {
      // Success path: piping already ends the response when stdout closes,
      // but end() is safe/idempotent if there was zero output.
      if (!res.writableEnded) res.end();
      console.log(
        "aveeone.container.done",
        JSON.stringify({ requestId, sourceUrl }),
      );
      return;
    }

    // Non-zero exit.
    if (!streaming) {
      sendJsonError(res, 500, {
        error: "ffmpeg exited with a non-zero status before producing output",
        stage: "ffmpeg-exit",
        requestId,
        sourceUrl,
        exitCode: code,
        signal: signal || undefined,
        stderr: stderrTail.trim() || undefined,
      });
    } else {
      // Failure after we already sent a 200; the stream is necessarily
      // truncated. Best we can do is end and log full context.
      if (!res.writableEnded) res.end();
      console.error(
        "aveeone.container.mid-stream-exit",
        JSON.stringify({
          requestId,
          sourceUrl,
          exitCode: code,
          signal,
          stderr: stderrTail.trim(),
        }),
      );
    }
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://container");

  // Health/readiness: any GET to "/" returns 200 so port checks succeed.
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }

  if (url.pathname === "/transcode") {
    handleTranscode(req, res).catch((err) => {
      // Last-resort guard; handleTranscode handles its own errors, but never
      // let a rejection go unhandled.
      sendJsonError(res, 500, {
        error: "Unhandled transcode error",
        stage: "container-unhandled",
        details: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Not found", stage: "container-route", path: url.pathname }));
});

server.listen(PORT, () => {
  console.log("aveeone.container.listening", JSON.stringify({ port: PORT }));
});
