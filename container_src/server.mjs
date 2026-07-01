// Aveeone container server.
//
// A tiny HTTP server that the Worker talks to. For each /transcode request the
// Worker fetches the source on its own fast network and POSTs the body here.
// The container pipes it straight into ffmpeg stdin — no network download
// inside the container. Output is written to a temp file then streamed back.
//
// Written as plain ESM JS so the container image needs only Node + ffmpeg
// (no TypeScript build step).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT) || 8080;

// Log the visible CPU count once at startup so we can confirm what SVT-AV1
// sees inside the CF container.
import { execSync } from "node:child_process";
try {
  const nproc = execSync("nproc", { encoding: "utf8" }).trim();
  console.log("aveeone.container.startup", JSON.stringify({ nproc }));
} catch { /* non-fatal */ }

// ffmpeg encode settings. Source arrives via stdin (pipe:0) — the Worker
// fetches the source on its fast network and POSTs the body to us, which we
// pipe straight into ffmpeg. No reconnect args needed; no URL required.
// Output is written to a seekable temp file so we can use +faststart.
function buildFfmpegArgs(outPath) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y", // overwrite the (pre-generated unique) temp path if it exists
    "-i",
    "pipe:0", // read source from stdin
    // Video: AV1 via SVT-AV1. lp=4 pins SVT-AV1's logical-processor count to
    // the standard-4 instance's vCPU allocation. Without this, SVT-AV1 reads
    // nproc (which reflects the host's physical core count inside a CF
    // container, not the 4-vCPU quota) and spawns far too many threads,
    // causing heavy scheduler contention and ~4x slower encodes.
    "-c:v",
    "libsvtav1",
    "-preset",
    "6",
    "-crf",
    "26",
    "-svtav1-params",
    "lp=4",
    // Audio: AAC
    "-c:a",
    "aac",
    // Drop data streams, and drop chapters. Chapters from the source are
    // otherwise written by the MP4 muxer as a "text"/bin_data track (which -dn
    // does not remove), so we strip them explicitly to keep output to v+a only.
    "-dn",
    "-map_chapters",
    "-1",
    // Standard (non-fragmented) MP4 with the moov atom relocated to the front
    // for fast start / seeking. Requires a seekable output, hence the temp file.
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

async function handleTranscode(req, res) {
  const sourceUrl = req.headers["x-source-url"] || "(unknown)";
  const requestId = req.headers["x-request-id"] || "unknown";

  // HEAD: report the content type without doing any work.
  if (req.method === "HEAD") {
    res.writeHead(200, { "content-type": "video/mp4" });
    return res.end();
  }

  if (req.method !== "POST") {
    return sendJsonError(res, 500, {
      error: "Expected POST with source body",
      stage: "container-validate",
      requestId,
    });
  }

  // Encode to a unique temp file. We only respond once ffmpeg has fully and
  // successfully written the file, so the Worker gets a clean 200-on-success
  // contract (with Content-Length) and never caches a truncated object.
  const outPath = join(tmpdir(), `aveeone-${randomUUID()}.mp4`);
  const args = buildFfmpegArgs(outPath);
  const spawnedAt = Date.now();
  console.log(
    "aveeone.container.spawn",
    JSON.stringify({ requestId, sourceUrl, outPath }),
  );

  let ffmpeg;
  try {
    // stdin=pipe so we can feed it the source body from the request.
    ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  } catch (err) {
    await unlink(outPath).catch(() => {});
    return sendJsonError(res, 500, {
      error: "Failed to spawn ffmpeg",
      stage: "spawn",
      requestId,
      sourceUrl,
      details: err instanceof Error ? err.message : String(err),
    });
  }

  // Pipe the POST body (the source file) into ffmpeg stdin. Errors on stdin
  // (e.g. upstream body truncated) will cause ffmpeg to exit non-zero, which
  // we handle below. Destroy stdin explicitly when the request body ends so
  // ffmpeg knows input is complete.
  req.pipe(ffmpeg.stdin);
  req.on("error", () => ffmpeg.stdin.destroy());
  ffmpeg.stdin.on("error", () => {}); // suppress EPIPE if ffmpeg exits early

  // Ring-ish buffer of the most recent stderr output, for error reporting.
  let stderrTail = "";
  ffmpeg.stderr.on("data", (chunk) => {
    stderrTail += chunk.toString();
    if (stderrTail.length > MAX_STDERR_BYTES) {
      stderrTail = stderrTail.slice(stderrTail.length - MAX_STDERR_BYTES);
    }
  });

  // Wait for ffmpeg to finish (resolve with exit code, or reject on spawn error).
  const exitCode = await new Promise((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => resolve(code));
  }).catch((err) => {
    return { spawnError: err };
  });

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

  // Success: stream the finished file with a known Content-Length, then clean up.
  let size;
  try {
    ({ size } = await stat(outPath));
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

  const ffmpegElapsedMs = Date.now() - spawnedAt;
  console.log(
    "aveeone.container.done",
    JSON.stringify({ requestId, sourceUrl, size, ffmpegElapsedMs }),
  );

  res.writeHead(200, {
    "content-type": "video/mp4",
    "content-length": String(size),
    "x-request-id": String(requestId),
    "x-ffmpeg-elapsed-ms": String(ffmpegElapsedMs),
    "x-nproc": String(execSync("nproc", { encoding: "utf8" }).trim()),
    "cache-control": "no-store",
  });

  const fileStream = createReadStream(outPath);
  const cleanup = () => {
    unlink(outPath).catch(() => {});
  };
  fileStream.on("error", (err) => {
    console.error(
      "aveeone.container.stream-error",
      JSON.stringify({ requestId, details: String(err) }),
    );
    res.destroy(err);
    cleanup();
  });
  fileStream.on("close", cleanup);
  res.on("close", () => fileStream.destroy());
  fileStream.pipe(res);
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
