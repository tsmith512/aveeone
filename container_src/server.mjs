// Aveeone container server.
//
// Implements the job-descriptor pattern: the Worker sends a GET /transcode
// request with x-source-url, and this server runs ffmpeg to fetch and encode
// that URL directly. This is the standard model for transcoding services —
// the container receives a job description (URL + encode parameters) and is
// fully responsible for fetching its inputs and producing its output.
//
// Encode pipeline:
//   1. Download source → temp file  (measured: x-download-elapsed-ms)
//   2. ffmpeg local-file → temp file  (measured: x-encode-elapsed-ms)
//   3. Stream output back to Worker, which uploads to R2
//
// Output is written to a seekable temp file (required for +faststart) and
// streamed back to the Worker once ffmpeg exits cleanly. The Worker uploads
// to R2 and serves from there; this container never touches R2 directly.
//
// Written as plain ESM JS so the container image needs only Node + ffmpeg
// (no TypeScript build step).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT) || 8080;

// Log the visible CPU count once at startup so we can confirm what SVT-AV1
// sees inside the CF container.
import { execSync } from "node:child_process";
const NPROC = (() => {
  try { return execSync("nproc", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
})();
console.log("aveeone.container.startup", JSON.stringify({ nproc: NPROC }));

// Build the ffmpeg argument list. Both input and output are local temp files:
// downloading separately gives us a clean download-vs-encode time split, and
// a local input lets ffmpeg seek freely (required for some source formats).
function buildFfmpegArgs(inPath, outPath) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inPath,
    // Video: AV1 via SVT-AV1. lp=4 pins the logical-processor count to the
    // standard-4 vCPU allocation (nproc inside CF containers may report the
    // host's physical count, causing over-threading on a 4-vCPU machine).
    "-c:v",
    "libsvtav1",
    "-preset",
    "6",
    "-crf",
    "30",
    "-svtav1-params",
    "lp=4",
    // Audio: AAC
    "-c:a",
    "aac",
    // Drop data streams and chapter markers. Chapters are otherwise muxed into
    // the output as a stray bin_data text track that -dn alone won't remove.
    "-dn",
    "-map_chapters",
    "-1",
    // Standard faststart MP4 (moov at the front). Requires seekable output,
    // hence the temp file rather than a pipe.
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outPath,
  ];
}

const MAX_STDERR_BYTES = 64 * 1024;

function sendJsonError(res, status, info) {
  const body = JSON.stringify(info, null, 2);
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  }
  res.end(body);
  console.error("aveeone.container.failure", JSON.stringify(info));
}

/**
 * Download sourceUrl to a temp file using Node's native fetch.
 * Returns { inPath, downloadElapsedMs, inputSize } or throws with an `.info`
 * property describing the failure for sendJsonError.
 */
async function downloadSource(sourceUrl, requestId) {
  const inPath = join(tmpdir(), `aveeone-in-${randomUUID()}.mp4`);
  const dlStart = Date.now();

  let srcResp;
  try {
    srcResp = await fetch(sourceUrl);
  } catch (err) {
    const e = new Error("Failed to fetch source URL");
    e.info = { error: e.message, stage: "download", requestId, sourceUrl,
               details: err instanceof Error ? err.message : String(err) };
    throw e;
  }

  if (!srcResp.ok) {
    const e = new Error("Source returned a non-2xx status");
    e.info = { error: e.message, stage: "download", requestId, sourceUrl,
               httpStatus: srcResp.status };
    throw e;
  }

  // Stream response body → temp file using Node's pipeline utility.
  // Readable.fromWeb converts the Web ReadableStream to a Node Readable.
  try {
    await pipeline(Readable.fromWeb(srcResp.body), createWriteStream(inPath));
  } catch (err) {
    await unlink(inPath).catch(() => {});
    const e = new Error("Failed to write source to disk");
    e.info = { error: e.message, stage: "download", requestId, sourceUrl,
               details: err instanceof Error ? err.message : String(err) };
    throw e;
  }

  const downloadElapsedMs = Date.now() - dlStart;
  const { size: inputSize } = await stat(inPath);

  return { inPath, downloadElapsedMs, inputSize };
}

async function handleTranscode(req, res) {
  const sourceUrl = req.headers["x-source-url"];
  const requestId = req.headers["x-request-id"] || "unknown";
  // x-dispatched-at is set by the Worker immediately before container.fetch().
  // The delta (Date.now() - dispatchedAt) captures container cold-start time
  // plus internal routing — close to 0 when warm, ~2-3s on a cold start.
  const dispatchedAt = Number(req.headers["x-dispatched-at"] ?? 0);
  const containerStartMs = dispatchedAt > 0 ? Date.now() - dispatchedAt : null;

  if (!sourceUrl || typeof sourceUrl !== "string") {
    return sendJsonError(res, 500, {
      error: "Missing x-source-url header",
      stage: "container-validate",
      requestId,
    });
  }

  // HEAD: report the content type without doing any work.
  if (req.method === "HEAD") {
    res.writeHead(200, { "content-type": "video/mp4" });
    return res.end();
  }

  // --- Phase 1: download source to temp file ---
  let inPath, downloadElapsedMs, inputSize;
  try {
    ({ inPath, downloadElapsedMs, inputSize } = await downloadSource(sourceUrl, requestId));
  } catch (err) {
    return sendJsonError(res, 500, {
      ...(err.info ?? { error: String(err), stage: "download" }),
    });
  }
  console.log(
    "aveeone.container.download",
    JSON.stringify({ requestId, sourceUrl, inputSize, downloadElapsedMs }),
  );

  // --- Phase 2: encode to output temp file ---
  const outPath = join(tmpdir(), `aveeone-out-${randomUUID()}.mp4`);
  const args = buildFfmpegArgs(inPath, outPath);
  const encodeStart = Date.now();
  console.log("aveeone.container.encode.start", JSON.stringify({ requestId, sourceUrl }));

  let ffmpeg;
  try {
    ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
    return sendJsonError(res, 500, {
      error: "Failed to spawn ffmpeg",
      stage: "spawn",
      requestId,
      sourceUrl,
      details: err instanceof Error ? err.message : String(err),
    });
  }

  let stderrTail = "";
  ffmpeg.stderr.on("data", (chunk) => {
    stderrTail += chunk.toString();
    if (stderrTail.length > MAX_STDERR_BYTES) {
      stderrTail = stderrTail.slice(stderrTail.length - MAX_STDERR_BYTES);
    }
  });

  const exitCode = await new Promise((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => resolve(code));
  }).catch((err) => ({ spawnError: err }));

  // Input file is no longer needed once ffmpeg has exited.
  await unlink(inPath).catch(() => {});

  if (exitCode && typeof exitCode === "object" && exitCode.spawnError) {
    await unlink(outPath).catch(() => {});
    return sendJsonError(res, 500, {
      error: "ffmpeg process error",
      stage: "ffmpeg-error",
      requestId,
      sourceUrl,
      details: String(exitCode.spawnError),
      stderr: stderrTail.trim() || undefined,
    });
  }

  if (exitCode !== 0) {
    await unlink(outPath).catch(() => {});
    return sendJsonError(res, 500, {
      error: "ffmpeg exited with a non-zero status",
      stage: "ffmpeg-exit",
      requestId,
      sourceUrl,
      exitCode,
      stderr: stderrTail.trim() || undefined,
    });
  }

  const encodeElapsedMs = Date.now() - encodeStart;

  // --- Phase 3: stat output, stream back to Worker ---
  let outputSize;
  try {
    ({ size: outputSize } = await stat(outPath));
  } catch (err) {
    await unlink(outPath).catch(() => {});
    return sendJsonError(res, 500, {
      error: "Encoded output missing after ffmpeg success",
      stage: "post-encode-stat",
      requestId,
      sourceUrl,
      details: err instanceof Error ? err.message : String(err),
    });
  }

  console.log(
    "aveeone.container.encode.done",
    JSON.stringify({ requestId, sourceUrl, outputSize, encodeElapsedMs }),
  );

  res.writeHead(200, {
    "content-type": "video/mp4",
    "content-length": String(outputSize),
    "x-request-id": String(requestId),
    // Timing headers read by the Worker to build the consolidated aveeone.timing log.
    "x-container-start-ms":   containerStartMs !== null ? String(containerStartMs) : "",
    "x-download-elapsed-ms":  String(downloadElapsedMs),
    "x-encode-elapsed-ms":    String(encodeElapsedMs),
    "x-input-size":           String(inputSize),
    "x-nproc":                NPROC,
    "cache-control": "no-store",
  });

  const fileStream = createReadStream(outPath);
  const cleanup = () => { unlink(outPath).catch(() => {}); };
  fileStream.on("error", (err) => {
    console.error("aveeone.container.stream-error",
      JSON.stringify({ requestId, details: String(err) }));
    res.destroy(err);
    cleanup();
  });
  fileStream.on("close", cleanup);
  res.on("close", () => fileStream.destroy());
  fileStream.pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://container");

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }

  if (url.pathname === "/transcode") {
    handleTranscode(req, res).catch((err) => {
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
