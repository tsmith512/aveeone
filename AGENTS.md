# Aveeone — Agent Guide

This file documents the architecture, code standards, and development practices
for the Aveeone codebase. It is intended for AI agents and new contributors.

---

## What this project is

Aveeone (pronounced like "AV1", the codec) is a Cloudflare Worker that accepts
a URL to an MP4 video and returns it transcoded to AV1/AAC. It follows the URL
convention of [Cloudflare Media Transformations]:

```
https://aveeone.tsmith.net/<OPTIONS>/<SOURCE_URL>
```

- `<OPTIONS>` — first path segment. Currently opaque; it is part of the R2
  cache key (so changing it busts the cache). Future: ffmpeg edit parameters.
- `<SOURCE_URL>` — full `https://` URL to the source MP4. If absent, the
  default test footage (`assets.tsmith.net/aus-mobile.mp4`) is used.

Responses are served from an R2 cache keyed by
`sha256(options + "\n" + sourceUrl)`. Only the first request per
(options, source) pair triggers a container encode; all subsequent requests —
including browser seek/range requests — are served from R2.

---

## File map

| Path | Role |
|---|---|
| `src/index.ts` | Worker: URL parsing, R2 cache hit/miss, Range serving, preflight, container dispatch, R2 multipart upload, `aveeone.timing` log |
| `container_src/server.mjs` | Container HTTP server: download source, run ffmpeg, stream output back |
| `Dockerfile` | `node:22-alpine` + static ffmpeg from `mwader/static-ffmpeg:7.1` |
| `wrangler.jsonc` | Cloudflare config: Worker, Container, R2, DO, observability |
| `package.json` | Scripts and deps (Worker side only; container has none) |
| `tsconfig.json` | Strict TypeScript for `src/` only; `container_src/` is excluded |

---

## Architecture

```
Client
  │
  ▼
Worker (src/index.ts)
  ├─ parseRequestPath()         → options, sourceUrl
  ├─ outputKey()                → sha256(options + "\n" + sourceUrl)
  ├─ serveFromR2()              → 200/206 on cache hit (Range supported)
  └─ generateAndStore()         → on cache miss:
       ├─ HEAD preflight        → confirm reachable, check ≤1GiB
       ├─ container.fetch()     → GET /transcode + x-source-url header
       │                          (dispatches to pooled Transcoder DO)
       ├─ R2 multipart upload   → streams container response into R2
       │                          in exactly 8MiB parts
       └─ log aveeone.timing    → single structured timing event

Transcoder Container (container_src/server.mjs)
  ├─ downloadSource()           → Node fetch → temp file (Phase 1)
  ├─ ffmpeg -i <inPath>         → encode to outPath (Phase 2)
  └─ createReadStream(outPath)  → stream back to Worker (Phase 3)
       with headers: x-container-start-ms, x-download-elapsed-ms,
                     x-encode-elapsed-ms, x-input-size, x-nproc

R2 (aveeone-prod)
  └─ key: gen1/av1-unedited/<sha256>
```

### Job-descriptor pattern

The container is a **job worker**: the Worker sends it a URL and encode
parameters; the container fetches its own input, encodes, and returns the
output. This is the standard model for transcoding services (Zencoder, AWS
Elemental, etc.) and the right pattern to extend as `<OPTIONS>` becomes real
ffmpeg parameters. It also means the container can potentially be triggered
from a Queue message in future without the Worker in the path.

Do not revert to piping source bytes through the Worker into container stdin.
That approach was evaluated and abandoned — see git history
(`8597865`, `369d5eb`) for the rationale. Performance is equivalent (the
container network interface is the bottleneck in both directions), but the
job-descriptor model is cleaner to document, extend to multiple inputs, and
reason about.

---

## Code standards

### Worker (`src/index.ts`)

- **TypeScript, strict mode.** All types explicit; no `any` unless unavoidable.
- **Single file** per CLOUDFLARE.md guidance. Do not split unless clearly
  justified.
- **ES modules** (`import`/`export`). Never CommonJS.
- **Errors always return HTTP 500 with a JSON body** containing `error`,
  `stage`, `requestId`, and as much context as possible. Use the `failure()`
  helper. Log with `console.error`.
- **`satisfies ExportedHandler<Env>`** on the default export — catches Env
  mismatches at compile time.
- Run `npm run typecheck` (`tsc --noEmit`) before every deploy.

### Container server (`container_src/server.mjs`)

- **Plain ESM JavaScript** (`.mjs`). No TypeScript, no build step, no npm
  dependencies. Node builtins only. This keeps the container image minimal and
  the build fast.
- **Three-phase encode pipeline, all measured:**
  1. `downloadSource()` — `fetch` + `stream/promises.pipeline` to temp file
  2. `spawn("ffmpeg", ...)` — encode local file → local file
  3. `createReadStream(outPath).pipe(res)` — stream output back
- **Respond only on success.** The container replies `200 video/mp4` with
  `Content-Length` only on `ffmpeg` exit code 0. Any failure returns `500`
  JSON. This is what prevents partial/corrupt objects from being cached.
- **Temp file cleanup.** Both the input and output temp files must be deleted
  on all code paths. Do not `unlink(inPath)` before ffmpeg exits — it races
  against ffmpeg opening the file (the directory entry is removed immediately on
  Linux; if ffmpeg hasn't opened it yet, it gets ENOENT).
- **`sendJsonError()`** for all error responses; it also `console.error`s for
  observability.

### ffmpeg settings (do not change without updating `OUTPUT_PREFIX`)

```
-c:v libsvtav1 -preset 6 -crf 26 -svtav1-params lp=4
-c:a aac
-dn -map_chapters -1
-movflags +faststart
-f mp4
```

- `lp=4` is **required** and must match the container `instance_type` vCPU
  count. CF containers expose the host's physical CPU count to `nproc`, not
  the vCPU quota; without explicit `lp`, SVT-AV1 spawns too many threads and
  encodes ~4× slower. If `instance_type` changes, update `lp` in
  `buildFfmpegArgs`.
- `+faststart` (moov at the front) requires a seekable output file — hence the
  temp file rather than a pipe. This gives browsers proper seeking from R2.
- `-dn -map_chapters -1` — source chapter markers are otherwise muxed into the
  output as a stray `bin_data` text track. `-dn` alone does not remove them;
  `-map_chapters -1` is also required.

---

## R2 caching

### Key scheme

```
{OUTPUT_PREFIX}/av1-unedited/{sha256hex}
```

where `sha256hex = sha256(options + "\n" + sourceUrl)`.

- **`OUTPUT_PREFIX`** is currently `"gen1"`. Bump it whenever the output
  semantics change (different encode settings, different output format, etc.).
  Objects under the old prefix are not cleaned up automatically.
- The `\n` separator between options and sourceUrl is unambiguous because a
  URL path segment cannot contain a newline.
- Keys are **immutable** — served with `Cache-Control: public, max-age=31536000,
  immutable`. Never overwrite a key that already exists.

### R2 multipart upload rules

- All non-trailing parts must be **exactly** `R2_PART_SIZE` (8 MiB). R2
  enforces uniform part size and returns an error if they differ. Only the
  final part may be smaller.
- Always `abort()` the multipart upload in the catch path so incomplete objects
  don't persist in R2.
- Minimum part size is 5 MiB per R2 limits; 8 MiB gives comfortable headroom.

### Range requests

R2 `get(key, { range: request.headers })` parses the `Range` header natively.
If the object has a `range` property in the response, return `206` with
`Content-Range` and the sliced `Content-Length`. Otherwise return `200` with
the full `Content-Length`.

---

## Observability

### `aveeone.timing` — the primary telemetry event

Emitted by the Worker in `generateAndStore()` after the R2 upload completes.
This is the single source of truth for encode pipeline performance.

```json
{
  "requestId":         "uuid",
  "sourceUrl":         "https://...",
  "containerStartMs":  1360,      // null if x-dispatched-at not echoed
  "downloadElapsedMs": 386,       // source fetch inside container
  "encodeElapsedMs":   55355,     // ffmpeg wall-clock
  "uploadElapsedMs":   25491,     // container → Worker stream + R2 write
  "inputBytes":        28978866,
  "outputBytes":       22850962,
  "nproc":             "4"
}
```

`containerStartMs` is derived from an `x-dispatched-at` header the Worker sets
immediately before `container.fetch()`. A value near zero means the container
was warm; 2–4 s indicates a cold start.

### Other log events

| Event | Where | Purpose |
|---|---|---|
| `aveeone.request` | Worker | Every inbound request: requestId, options, sourceUrl, key |
| `aveeone.preflight.ok` | Worker | HEAD succeeded: contentLength, fetchElapsedMs |
| `aveeone.preflight.skip` | Worker | Origin returned 405 for HEAD; proceeding anyway |
| `aveeone.failure` | Worker | Any 500 response: full error context |
| `aveeone.container.startup` | Container | nproc at container start |
| `aveeone.container.download` | Container | Phase 1 done: inputSize, downloadElapsedMs |
| `aveeone.container.encode.start` | Container | ffmpeg spawned |
| `aveeone.container.encode.done` | Container | ffmpeg exited 0: outputSize, encodeElapsedMs |
| `aveeone.container.failure` | Container | Any container 500: full error context |

### Observability config

100% sampling on logs and traces (`wrangler.jsonc`). Do not reduce sampling
without discussion — this is a low-traffic POC and full sampling is cheap.

### Tailing logs in production

`wrangler tail` connects to the Durable Object layer, not the main Worker, and
will only show DO heartbeat events. Use the WebSocket tail API directly:

```bash
# Create a tail
TAIL=$(curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/aveeone/tails" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}')
TAIL_URL=$(echo $TAIL | jq -r '.result.url')

# Connect with trace-v1 subprotocol
node -e "
const {WebSocket}=require('ws');
const ws=new WebSocket('$TAIL_URL',['trace-v1'],{headers:{Authorization:'Bearer $TOKEN'}});
ws.on('message',d=>{try{JSON.parse(d).logs.forEach(l=>{const m=(l.message||[]).map(String).join(' ');if(m.includes('aveeone'))console.log(m);})}catch{}});
"
```

---

## Container pool and Durable Objects

- The Worker maintains a **pool of 2 named container instances**
  (`"transcoder-0"`, `"transcoder-1"`) via `getRandom(env.TRANSCODER, 2)`.
- The `@cloudflare/containers` library drives a **1-second alarm heartbeat** on
  each running DO instance to manage lifecycle. With a pool of N, expect at
  most N alarm events per second in logs while containers are warm.
- `sleepAfter = "5m"` — containers stop 5 minutes after the last request.
- If `max_instances` or `POOL_SIZE` is changed, keep them consistent.
- If `instance_type` is changed, update `lp=` in `buildFfmpegArgs` to match
  the new vCPU count.

---

## Deployment

### Normal deploy

```bash
npm run typecheck          # must pass
npm run deploy             # wrangler deploy
```

### ⚠️ Container image cache gotcha

`wrangler deploy` detects image rebuild need by hashing the **Dockerfile**, not
the files it `COPY`s. Changes to `container_src/server.mjs` are **silently
skipped** and the old container code keeps running.

When `container_src/server.mjs` changes:

```bash
docker build --no-cache .   # force rebuild without layer cache
npm run deploy
```

Confirm the deploy updated the image: look for the `-` / `+` `image:` hash diff
in the wrangler output. If it says `Image already exists remotely, skipping
push`, the old image is still live.

### Local dev

```bash
npm run dev    # wrangler dev (requires Docker running)
```

`wrangler dev` has limited R2 support — multipart uploads are not available
locally. Use `wrangler dev --remote` for full R2 testing, or just deploy to
staging.

---

## Performance characteristics (measured)

Measured on a `standard-4` instance (4 vCPU, 12 GiB RAM) with a 15s 1080p
H.264 source (28 MB input, 22 MB output):

| Phase | Time |
|---|---|
| Worker HEAD preflight | ~15ms |
| Container cold start | ~1-3s |
| Source download (inside container) | ~400ms |
| ffmpeg encode (`preset 6, lp=4`) | ~55s (~3.7× realtime) |
| Container → Worker → R2 upload | ~25s |
| **Total (first request, cold start)** | **~85–100s** |
| **Subsequent requests (R2 cache hit)** | **<1s** |

The container network interface is bandwidth-limited (~0.75–0.9 MB/s) in both
directions — this affects both source download and encoded output upload. This
is a current Cloudflare Containers beta constraint, not a code issue.

The R2 cache is the primary performance strategy: encode once, serve instantly
thereafter.

---

## Request lifecycle and timeout behavior

Relevant now that preset/CRF changes can push a cold-cache encode well past a
minute. Verified against current Cloudflare docs (not assumed from memory):

| Concern | Limit | Applies here? |
|---|---|---|
| Worker CPU time | 30s default / 300s max (`limits.cpu_ms`) | No — `fetch()` await time isn't CPU time; actual Worker CPU usage is trivial regardless of encode length |
| Worker wall-clock (HTTP trigger) | **Unlimited** while the client stays connected | This is why 85–300s+ requests work at all |
| Container/DO `fetch()` wall-clock | **Unlimited** while the Worker's call is in flight | Decoupled from the original client — the container only cares whether the Worker's own call to it is still open |
| Container/DO CPU time | Same 30s/300s budget, reset per inbound request | No — `spawn("ffmpeg")` + awaiting its exit event isn't CPU time for the Node process; ffmpeg runs as a separate OS process |
| `ctx.waitUntil()` | **Exactly 30 seconds**, counted from when the response is sent or the client disconnects | **Yes — the one real cliff**, see below |

**Bottom line: no Cloudflare platform limit will kill a long encode as long as
the requesting connection stays open.** The practical risks are elsewhere:

1. **Intermediary/client idle-response timeouts, unrelated to Cloudflare.**
   The current response sends zero bytes until the entire pipeline (download →
   encode → upload → R2 read-back) completes — the worst case for surviving a
   proxy, load balancer, or browser idle timeout (60–120s is a common default
   for such intermediaries). This is a bigger practical risk than anything
   Cloudflare enforces.

2. **The `ctx.waitUntil()` 30-second grace, if a disconnect is ever detected.**
   `src/index.ts` already uses this as an insurance policy:

   ```ts
   const task = generateAndStore(env, key, sourceStr, requestId);
   ctx.waitUntil(task.then(() => undefined).catch(() => undefined));
   const result = await task;
   ```

   Registering the *same* promise with `waitUntil` tells the runtime to give
   it up to 30 more seconds if the invocation would otherwise end on
   disconnect. That 30s is counted **from the disconnect**, not from job
   start — a disconnect early in a 150s+ encode will not survive to
   completion. Whether this cliff is actually reached in practice is itself
   uncertain: Cloudflare's docs describe disconnect-driven cancellation with
   soft language ("tasks... **may** be canceled"), and the documented, opt-in
   mechanism for observing a disconnect (`request.signal`) requires the
   `enable_request_signal` compatibility flag, which **this project does not
   set**. No code here listens for a disconnect either. Practically, this
   likely means disconnect cancellation mostly isn't happening today — good
   for reliability, but it's relying on undocumented default behavior rather
   than a guarantee, and could change.

3. **A finished encode is not currently durable against a broken connection.**
   Checked directly in `container_src/server.mjs`: there is no `req.on("close")`
   (or similar) handling during the download or encode phases — only after
   encoding, wired to the final output stream. This means:
   - If the Worker↔container connection drops mid-download or mid-encode,
     **nothing tells ffmpeg to stop.** It runs to completion regardless — this
     matches the "container should finish its work" intuition.
   - But the container's *only* way to deliver that result is streaming it
     back over the same HTTP connection that requested it. If that connection
     is gone by the time ffmpeg exits, `res.pipe()` errors, `fileStream`'s
     error handler fires, and the finished output is **deleted** — the compute
     succeeded but the result is thrown away, uncached, with no retry.
   - The R2 multipart upload happens in the **Worker**, not the container. A
     disconnect during that phase hits the `catch` block in
     `generateAndStore()`, calls `multipart.abort()`, and nothing is cached.
   - **Closing this gap requires the container to persist its result
     independently of the Worker/client connection** — e.g. uploading directly
     to R2 via the S3-compatible API (Mechanism A from the original R2-caching
     design discussion, deferred at the time in favor of the simpler
     Worker-mediated multipart upload used today). Revisit this if cold-cache
     encode times continue to grow, or if dropped-connection waste becomes a
     measured problem.

---

## Known limitations and TODOs

- **`@TODO` in `src/index.ts`:** HEAD preflight skips size check when origin
  returns `405` or omits `Content-Length`. Future: `Range: bytes=0-0` GET
  fallback.
- **`OPTIONS` not yet parsed.** The first path segment is hashed into the cache
  key but not interpreted. Future: parse it into ffmpeg parameters (trim, scale,
  CRF, etc.). When this changes, bump `OUTPUT_PREFIX` and update the `av1-unedited`
  path segment to reflect the new semantics.
- **No single-flight coordination.** Concurrent misses for the same
  (options, source) pair each trigger a full encode (last write to R2 wins).
  Future: a Durable Object lock keyed by the R2 key.
- **Container network bandwidth.** The ~0.75 MB/s container I/O rate is a beta
  platform constraint. If it improves, encode throughput will increase without
  code changes.
- **`lp` is hardcoded.** If `instance_type` changes in `wrangler.jsonc`, the
  `lp=4` value in `buildFfmpegArgs` must be updated to match the new vCPU
  count.
- **Encode results aren't durable against a dropped connection.** See
  "Request lifecycle and timeout behavior" above. Fixing this means the
  container uploading directly to R2 rather than streaming through the Worker.

---

## What not to do

- **Don't use `wrangler.toml`** — use `wrangler.jsonc` for comments and IDE
  support.
- **Don't add npm dependencies to the container.** The container has zero npm
  deps by design; it uses Node builtins only. The image is already ~418 MB due
  to the static ffmpeg binary; adding a `node_modules` layer would balloon it
  further.
- **Don't pipe source bytes from Worker → container stdin** to bypass the
  container network. This was measured: the Worker→container DO pipe has the
  same ~0.75 MB/s bandwidth as the container's internet egress. Performance is
  identical, but the stdin approach breaks multi-input scenarios and is harder
  to document. See commits `8597865` and `369d5eb`.
- **Don't `unlink` the input temp file before ffmpeg exits.** Linux `unlink`
  removes the directory entry immediately. If ffmpeg hasn't opened the file yet,
  it gets `ENOENT`. See commit `1dab75e`.
- **Don't stream fMP4 from ffmpeg pipe for R2 storage.** Fragmented MP4
  (`+frag_keyframe+empty_moov`) was the original output format when streaming
  directly to clients. Serving from R2 requires a standard faststart MP4 so
  browsers can seek. The container encodes to a seekable temp file for this
  reason.
- **Don't use `R2Bucket.put(key, stream)` for large files.** R2 silently
  truncates streams of unknown length. Use multipart upload with fixed-size
  parts instead (current implementation).
