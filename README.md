# Aveeone

> Pronounced like **AV1**, the codec.

A Cloudflare Worker that takes a URL to an MP4 video and transcodes it to
**AV1 / AAC** on the fly using a Workers Container running `ffmpeg`
(`libsvtav1`). The result is streamed back as an MP4 HTTP response.

The URL scheme mirrors
[Cloudflare Media Transformations](https://developers.cloudflare.com/stream/transform-videos/#transform-a-video-by-url):

```
https://<host>/<OPTIONS>/<SOURCE_URL>
```

- `<OPTIONS>` is the first path segment. It's always used **verbatim, as-is**
  (no normalization) as part of the R2 cache key — a different string always
  forces a fresh transcode.
  - If it contains an **`=`** (e.g. `width=640,height=360`), it's treated as
    real [Media Transformations](https://developers.cloudflare.com/stream/transform-videos/)
    options: the *entire* `<OPTIONS>` string is forwarded, unmodified, to this
    Worker's own `/cdn-cgi/media/<OPTIONS>/<SOURCE_URL>` endpoint first, and
    the **edited variant** that comes back — not the original source — is what
    gets fed into the AV1 transcoder.
  - If it doesn't contain `=`, it's just an opaque cache buster, same as
    before — no Media Transformations request is made.
- `<SOURCE_URL>` is the full `http(s)` URL of the source MP4. If omitted, a
  default test clip (`https://assets.tsmith.net/aus-mobile.mp4`) is used.

Deployed at **https://aveeone.tsmith.net** (custom domain).

### Example

```
# Plain cache buster, no Media Transformations edit:
https://aveeone.tsmith.net/transform/https://example.com/video.mp4

# Media Transformations edit (resized + trimmed) applied before AV1 encode:
https://aveeone.tsmith.net/width=640,height=360/https://example.com/video.mp4

# No source URL -> transcodes the default test footage:
https://aveeone.tsmith.net/
```

## How it works

```
client ──▶ Worker (src/index.ts)
                │  parse + validate options + source URL from the path
                │  key = OUTPUT_PREFIX/av1-unedited/sha256(options + sourceUrl)
                ▼
           R2 "OUTPUTS"  ──hit──▶  serve object (Content-Length, Range/206)
                │
               miss (GET)
                ▼
           options contains "="?
                │                                    │
               yes                                   no
                ▼                                    │
           encodeUrl = /cdn-cgi/media/<options>/<sourceUrl>   │
           (Media Transformations edited variant)             │
                │                                    │
                └───────────────────┬────────────────┘
                                     ▼  encodeUrl (edited or original)
           Container DO "Transcoder"  (one ffmpeg per instance)
                │  container_src/server.mjs receives X-Source-Url = encodeUrl
                │  Worker preflight: reachable? size <= 1 GiB?  (else 500)
                ▼
           ffmpeg -i <encodeUrl>
                   -c:v libsvtav1 -preset 6 -crf 26
                   -c:a aac
                   -dn -map_chapters -1
                   -movflags +faststart
                   -f mp4 /tmp/<id>.mp4        (encode to disk)
                │  responds 200 + Content-Length ONLY on ffmpeg exit 0
                ▼
           Worker streams it into R2 via multipart upload (~8 MiB parts),
           then serves the first client from R2 (full Range support).
```

- **Outputs are cached in R2.** The Worker keys each result by
  `sha256(options + sourceUrl)` under `OUTPUT_PREFIX/av1-unedited/`, so the
  `<OPTIONS>` segment participates in the cache identity. Repeat requests
  (including browser **Range**/seek requests) are served straight from R2 with
  `Content-Length`, `Accept-Ranges`, and `206 Partial Content` — no container,
  no re-encode.
- **Media Transformations edits happen before the AV1 encode.** If `<OPTIONS>`
  contains an `=`, the Worker first requests
  `https://<host>/cdn-cgi/media/<OPTIONS>/<SOURCE_URL>` — a path Cloudflare
  intercepts at the edge — and hands the *edited* result to the container as
  its encode input, instead of `<SOURCE_URL>` directly. The container is
  unaware this happened; it just fetches whatever URL it's given (the
  job-descriptor pattern still holds). If `<OPTIONS>` has no `=`, this step is
  skipped entirely and the container encodes `<SOURCE_URL>` as before.
- **First request blocks.** On a miss the first caller waits for the full
  encode, then is served from R2, so even the first response is seekable. The
  R2 upload runs under `ctx.waitUntil`, so the object still lands even if that
  caller disconnects mid-encode.
- **No truncated caches.** The container encodes to a temp file and only
  responds `200` (with `Content-Length`) on `ffmpeg` exit `0`; any failure is a
  non-200, so a partial object is never stored. The Worker `abort()`s the
  multipart upload on any stream error.
- Before encoding, the container runs a **`curl` preflight** (`HEAD`, following
  redirects) to confirm the source is reachable and reject inputs whose
  `Content-Length` exceeds **1 GiB** — both return a `500` JSON with context.
- `-dn -map_chapters -1` keeps output to video + audio only (the source's
  chapter markers would otherwise be muxed in as a stray `bin_data` text track).
- Output is a standard **faststart MP4** (`moov` atom at the front) for clean
  in-browser seeking — possible because the container writes to a seekable file
  rather than a pipe.

## Project layout

| Path                      | What it is                                            |
| ------------------------- | ----------------------------------------------------- |
| `src/index.ts`            | Worker: R2 cache + Range serving + `Transcoder` class |
| `container_src/server.mjs`| HTTP server inside the container that drives ffmpeg   |
| `Dockerfile`              | `node:22-alpine` + static `ffmpeg` (`libsvtav1`)        |
| `wrangler.jsonc`          | Worker / container / DO / R2 config                   |

## Develop & deploy

```bash
npm install
npm run typecheck        # tsc --noEmit on the Worker

# Local dev (requires Docker running, since the container is built locally):
npm run dev

# Deploy (builds & pushes the container image, then the Worker):
npm run deploy
```

> Deploying containers requires Docker available locally for the image build,
> and a Cloudflare account with Containers (beta) enabled.

### Container image cache gotcha

`wrangler deploy` detects whether the container image needs a rebuild by
hashing the **Dockerfile** — it does not hash the files `COPY`'d into the
image. This means changes to `container_src/server.mjs` (the only file copied
in) are **silently ignored** and the old container code keeps running.

Whenever you change `container_src/server.mjs`, force a fresh image before
deploying:

```bash
docker build --no-cache .   # rebuild without layer cache
npm run deploy              # push the new image + deploy the Worker
```

If `wrangler deploy` shows `Image already exists remotely, skipping push` when
you expected a container change to take effect, this is why.

### Try it

```bash
# Transcode a specific source (options has no "=", so it's just a cache buster):
curl -L \
  "https://aveeone.tsmith.net/x/https://example.com/video.mp4" \
  -o out.mp4

# Apply a Media Transformations edit (resize) before the AV1 encode:
curl -L \
  "https://aveeone.tsmith.net/width=640,height=360/https://example.com/video.mp4" \
  -o out-640x360.mp4

# Or just hit the root to transcode the default test footage:
curl -L "https://aveeone.tsmith.net/" -o out.mp4

# Inspect the result (should report av1 video + aac audio, no data track):
ffprobe out.mp4

# Second request for the same source is served from R2 (x-cache: hit).
# Range requests are satisfied from R2 with 206 Partial Content:
curl -s -D - -r 0-99999 -o /dev/null "https://aveeone.tsmith.net/x/https://example.com/video.mp4"
```

Responses carry an `x-cache: hit|miss` header so you can tell whether the
object came from R2 or was freshly encoded.

## Failure behaviour

Per spec, **any failure returns HTTP 500 with a JSON body** containing as much
context as possible, e.g.:

```json
{
  "error": "ffmpeg exited with a non-zero status",
  "stage": "ffmpeg-exit",
  "requestId": "1f0c...",
  "sourceUrl": "https://example.com/video.mp4",
  "exitCode": 1,
  "stderr": "..."
}
```

Stages you may see: `request-validation`, `validate-source-url`,
`container-dispatch`, `generate-store`, `post-store-read` (Worker side) and
`container-validate`, `preflight`, `spawn`, `ffmpeg-error`, `ffmpeg-exit`,
`post-encode-stat`, `container-unhandled` (container side). The `preflight`
stage covers unreachable sources and the >1 GiB size cap.

All failures are also logged, and Workers **observability is enabled with 100%
sampling for both logs and traces** (`wrangler.jsonc`).

## Known trade-offs & limitations

These were deliberate choices for a first version — worth understanding before
relying on it:

1. **First request is synchronous + slow.** `libsvtav1 -preset 6` is much slower
   than realtime, so the first caller for a given source waits for the full
   encode before any bytes arrive. Subsequent requests are served instantly from
   R2. There's no queue/async job model — the first request blocks.

2. **No single-flight.** Two simultaneous misses for the same source trigger two
   encodes (last write into R2 wins). Fine for a single-user POC; a production
   build would coordinate with a lock (e.g. a Durable Object) so concurrent
   misses share one encode.

3. **Cache is never invalidated.** Objects are immutable per
   `OUTPUT_PREFIX`/`sha256(url)` and served with a 1-year `immutable`
   `Cache-Control`. Changing encode behaviour requires bumping `OUTPUT_PREFIX`;
   stale objects under old prefixes are not cleaned up automatically.

4. **Open transcoder / SSRF.** The Worker will fetch any `http(s)` URL it's
   given. There's no allowlist, auth, or rate limiting. Add those before
   exposing this publicly. (The 1 GiB preflight cap only limits size, not
   destination.)

5. **No input verification.** We assume the source is a video ffmpeg can read.
   We don't probe container/codecs first.

6. **`OPTIONS` is not normalized for the cache key.** The Worker hashes the
   `<OPTIONS>` path segment exactly as received — no key sorting, no
   canonicalization. Two requests with semantically-identical but
   differently-formatted options (e.g. `width=640,height=360` vs
   `height=360,width=640`, or extra whitespace/casing differences) hash to
   different R2 keys and each trigger their own Media Transformations request
   + AV1 encode, even though they'd produce the same edited video. Callers
   should format `<OPTIONS>` consistently to get cache reuse.

7. **A finished encode is not durable against a broken connection.** Cloudflare
   places no hard duration limit on an HTTP-triggered Worker (CPU-time limits
   don't count time spent awaiting `fetch()`, and container/DO calls have
   unlimited wall time while the call is in flight), so long encodes are not a
   Cloudflare *platform* timeout risk. The real risks are (a) intermediary/
   client idle-response timeouts unrelated to Cloudflare — our response sends
   zero bytes until the entire pipeline finishes, which is the worst case for
   surviving a proxy or browser idle timeout — and (b) `ctx.waitUntil()`'s
   documented **30-second** grace period, which only starts counting once a
   disconnect is detected and would not be enough to finish a long in-progress
   encode if triggered partway through. Separately, if the connection between
   Worker and container (or the Worker's R2 upload) drops for any reason after
   ffmpeg has already produced a file, that finished output is currently
   **discarded, not salvaged** — the container has no way to persist a result
   except by streaming it back over the same connection that requested it.
   Closing this gap would mean having the container upload directly to R2
   (independent of the Worker/client connection), which was considered and
   deferred for this POC. See `AGENTS.md` for the full analysis.

## Version History and Observations:

**v0.3.0:** Wired up Cloudflare Media Transformations

- Renamed the first path segment from `ARBITRARY_TEXT` to `OPTIONS` throughout
  the code and docs.
- On a cache miss, if `OPTIONS` contains an `=`, the Worker now first requests
  `https://<host>/cdn-cgi/media/<OPTIONS>/<SOURCE_URL>` and feeds the resulting
  edited variant into the AV1 transcoder, instead of `<SOURCE_URL>` directly.
  If `OPTIONS` has no `=`, behavior is unchanged (opaque cache buster only).
- The R2 cache key is still `sha256(OPTIONS + "\n" + SOURCE_URL)` — unaffected
  by whether a Media Transformations request happens — so `OPTIONS` continues
  to double as the cache identity in both modes.
- `OPTIONS` is still hashed verbatim, with no normalization; see "Known
  trade-offs & limitations" above.

**v0.2.2:** Request duration / disconnect durability investigation (no code
changes — documentation only)

- Question: given preset/CRF changes have pushed encode times well past a
  minute, at what point does the first (blocking) request risk timing out?
- Findings (see `AGENTS.md` for full detail and sources):
  - Cloudflare imposes no hard wall-clock duration limit on an HTTP-triggered
    Worker, and none on a container/DO call while it's in flight, as long as
    the requesting connection stays open. CPU-time limits (30s default / 300s
    max) don't apply either, since `fetch()` await time isn't CPU time.
  - The real ceiling is `ctx.waitUntil()`'s documented 30-second grace period
    after a disconnect is detected — already relied on in `src/index.ts` as an
    insurance policy, but only covers ~30s of remaining work, not a full
    long-running encode if the client leaves early.
  - `enable_request_signal` is not set, so disconnect-driven cancellation of
    our own outbound `fetch()` calls is likely not happening automatically
    today — this is undocumented default behavior, not a guarantee.
  - Checked the container code directly: nothing listens for a dropped
    connection during download/encode, so ffmpeg runs to completion regardless
    (matches intuition) — but the finished file can only be delivered back over
    the same connection that requested it, so a broken connection after a
    successful encode currently **wastes** the work rather than salvaging it
    into the cache.
- Practical takeaway: no Cloudflare-imposed number to worry about, but
  intermediary/client idle timeouts (unrelated to Cloudflare) are a real risk
  now that cold-cache requests can run into the 100-300s+ range.

**v0.2.1:** Performance investigation

- Problem: 15s sample input routinely took 1.5-2 minutes to return when cold
- Hypothesis: vCPU count misreported to ffmpeg, incorrect parallelization
- Observations:
  - vCPU count was correct within the container
    - Encoding time on sample still ~20s before and after `lp` change
  - Network IO on input and output are unexpectedly high
    - Network IO appeared constrained to 0.75MB/s
    - ~40s original fetch, ~30s derivative put
- Mitigations attempted:
  - Hardcoding `lp=4` (vCPU count) did not change encoding performance.
  - Attempted having Worker fetch the input then pipe to Container via HTTP POST,
    instead of having ffmpeg fetch. No change to input-side timing.
- Worker-side
  - Preflight HEAD check now happens in the Worker
- Container details:
  - Reverted input fetch back to the container for more standard workload
  - Retained the `lp=4` hardcoded parallelization flag
- User experience notes:
  - No changes

**v0.2.0:** Added R2 output caching, fixed the range-request re-encode problem

- Worker-side:
  - Added a "cache" bucket with R2 (`OUTPUTS`), based on hash of request (text +
    URL).
  - Cache hits served directly from R2, with `Content-Length` and `Range` support.
  - On a miss, the encode is streamed into R2 via multipart upload, then served
    from R2 directly.
    - `x-cache: hit|miss` header added for visibility.
- Container details:
  - FFMPEG now encodes to a local temp file and only responds `200` (with
    `Content-Length`) on a clean exit — eliminating the truncated-output and
    "can't downgrade a 200" problems from v0.1.0.
  - Output switched from fMP4 to a **faststart MP4** (`moov` at the front),
    now possible because output is a seekable file rather than a pipe.
- User experience notes:
  - First request for a given source still blocks for the full encode, which is
    slower. But every request after that is instant from R2 and fully seekable.
  - In a browser, this means any followup range requests are served near-instantly.
- Measured changes:
  - Cache hit: Download of the encoded sample took 1.3 seconds (21MB)
  - Cache miss on a container cold start: 1:50 - 1:55 (with a max of 17:45!)
  - Cache miss on a running container: 1:25 - 1:45

**v0.1.0:** Initial prototype for uncached, straight AV1 encodes with minimal safeguards

- Worker-side:
  - Used a pool size of 2 containers
  - Only 1GB input size check
- Container details:
  - FFMPEG streamed out an fMP4 to the Worker, which streamed it directly to users
  - On a `standard-4`, realtime factor was ~3.5x.
    [A 15 second input](https://assets.tsmith.net/aus-mobile.mp4) would return
    in about 40 seconds.
    - **NB: This may have been TTFB, not time to completion.**
- User experience notes:
  - Because the result was uncached, and previewing in a browser like Chrome
    makes shorter range requests over a video, playback was essentially broken
    until after first _watch_.
  - Because ffmpeg output is streamed directly, if ffmpeg _starts,_ the HTTP
    status is 200 because we have to commit to begin the response. So if ffmpeg
    errors after the initial stream starts, we'll have no way to know the video
    didn't complete.
  - fMP4 should be as broadly compatible as AV1, but a faststart MP4 would be
    moderately better from a technical perspective.
