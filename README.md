# Aveeone

> Pronounced like **AV1**, the codec.

A Cloudflare Worker that accepts a URL to an MP4 video and transcodes it to
**AV1 / AAC** on the fly using a Workers Container running `ffmpeg`
(`libsvtav1`). The result is streamed back as an MP4 HTTP response.

The URL scheme mirrors
[Cloudflare Media Transformations](https://developers.cloudflare.com/stream/transform-videos/#transform-a-video-by-url):

```
https://<host>/<OPTIONS>/<SOURCE_URL>
```

- `<OPTIONS>` is the first path segment. It's always used **verbatim, as-is**
  (no normalization) as part of the cache key — a different string always
  forces a fresh transcode:
  - If it contains an `=` (e.g. `width=640,height=360`), it's treated as
    real [Media Transformations](https://developers.cloudflare.com/stream/transform-videos/)
    options string: the *entire* `<OPTIONS>` string is used, unmodified, on
    this Worker's own `/cdn-cgi/media/<OPTIONS>/<SOURCE_URL>` endpoint as the
    source. The **edited variant** that comes back — not the original — is what
    gets transcoded. This propagates transformations-based edits.
  - If it _does not_ contain `=`, it's just an opaque cache buster.
- `<SOURCE_URL>` is the full `http(s)` URL of the source MP4. If omitted, a
  default test clip (`https://assets.tsmith.net/aus-mobile.mp4`) is used.

### Example

```
# Plain cache buster, no Media Transformations edit:
https://example.com/x/https://example.com/video.mp4

# Media Transformations edit (resized + trimmed) applied before AV1 encode:
https://example.com/width=640,height=360/https://example.com/video.mp4

# No source URL -> transcodes the default test footage:
https://example.com/
```

## How it works

```
client ──▶ Worker (src/index.ts)
                │  parse + validate options + source URL from the path
                │  key = OUTPUT_PREFIX/av1/sha256(options + sourceUrl)
                ▼
           R2 "OUTPUTS"  ──hit──▶  serve object (Content-Length, Range/206)
                │
               miss (GET)
                ▼
           options contains "="?
                │                                             │
               yes                                            no
                ▼                                             │
           encodeUrl = /cdn-cgi/media/<options>/<sourceUrl>   │
           (Media Transformations edited variant)             │
                │                                             │
                └────────────────────┬────────────────────────┘
                                     ▼  encodeUrl (edited or original)
           Container DO "Transcoder"  (one ffmpeg per instance)
                │  container_src/server.mjs receives X-Source-Url = encodeUrl
                │  Worker preflight (else 500):
                │    plain source        → HEAD, reachable? size <= 1 GiB?
                │    Media Transforms.   → GET, video/* response? (trust CF's own checks)
                ▼
           ffmpeg -i <encodeUrl>
                   -pix_fmt yuv420p10le
                   -c:v libsvtav1 -preset 6 -crf 40 -svtav1-params lp=4
                   -c:a copy (Media Transformations input) | aac -b:a 96k (raw source)
                   -dn -map_chapters -1
                   -movflags +faststart
                   -f mp4 /tmp/<id>.mp4        (encode to disk)
                │  responds 200 + Content-Length ONLY on ffmpeg exit 0
                ▼
           Worker uploads it into R2 via multipart upload (~8 MiB parts),
           then serves the first client from R2 (full Range support).
```

- **Outputs are "cached" in R2.** The Worker keys each result by
  `sha256(options + sourceUrl)` under a hardcoded namespace. Cached outputs can
  be accessed via `Range` requests --- commonly used in browsers video elements.
- **Media Transformations edits, if requested, happen before the AV1 encode.**
  If `<OPTIONS>` is likely a transformations string, the Container uses
  `https://<host>/cdn-cgi/media/<OPTIONS>/<SOURCE_URL>` as the transcode source.
- **Audio is copied, not re-encoded, after a Media Transformations edit.**
  Cloudflare's own MP4 transform already re-encodes audio to AAC at a fixed
  bitrate. Otherwise, it is re-encoded `aac` at 96k.
- **Video is forced to 10-bit internal encoding** (`-pix_fmt yuv420p10le`),
  even for 8-bit sources. This is a well-known SVT-AV1/AV1 trick: the extra
  internal precision reduces quantization error and commonly yields smaller
  files at equal or better perceptual quality than 8-bit, independent of the
  source's own bit depth. It also pins the pixel format explicitly for
  consistent output regardless of what the input uses.
- **Media Transformations preflight is a real `GET`, not a `HEAD`** because it
  is an edge transformation, not a static file. If Media Transformations returns
  a video, it is assumed acceptable. If it returns an error, it is surfaced in
  an error payload by Aveeone.
- **First request blocks.** On a miss the first caller waits for the full
  encode and upload to R2. Prefetching alleviates this.
- **No truncated caches.** The container encodes to a temp file and only
  responds `200` (with `Content-Length`) on `ffmpeg` exit `0`; any failure is a
  non-200, so a partial object is never stored. The Worker will `abort() the
  upload.
- Before dispatching to the container, the Worker preflights `encodeUrl` to check
  the 1GB filesize cap or for a Media Transformations success. Either way, a
  failed preflight returns `500` JSON with context _before_ any container starts.
- Output is a standard **faststart MP4** for clean in-browser seeking.

## Project layout

| Path                      | What it is                                            |
| ------------------------- | ----------------------------------------------------- |
| `src/index.ts`            | Worker: R2 cache + Range serving + `Transcoder` class |
| `container_src/server.mjs`| HTTP server inside the container that drives ffmpeg   |
| `Dockerfile`              | `node:22-alpine` + static `ffmpeg` (`libsvtav1`)      |
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
  "https://example.com/x/https://example.com/video.mp4" \
  -o out.mp4

# Apply a Media Transformations edit (resize) before the AV1 encode:
curl -L \
  "https://example.com/width=640,height=360/https://example.com/video.mp4" \
  -o out-640x360.mp4

# Or just hit the root to transcode the default test footage:
curl -L "https://example.com/" -o out.mp4

# Inspect the result (should report av1 video + aac audio, no data track):
ffprobe out.mp4

# Second request for the same source is served from R2 (x-cache: hit).
# Range requests are satisfied from R2 with 206 Partial Content:
curl -s -D - -r 0-99999 -o /dev/null "https://example.com/x/https://example.com/video.mp4"
```

Responses carry an `x-cache: hit|miss` header indicating if the response came
from the R2 storage bucket.

## Failure behaviour

Any failure returns HTTP 500 with a JSON body with as much context as possible, e.g.:

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

All failures are also logged, and Workers observability is enabled with 100%
sampling for both logs and traces (`wrangler.jsonc`).

## Known trade-offs & current PoC limitations

1. **First request is synchronous + slow.** `libsvtav1 -preset 6` is much slower
   than realtime, so the _first_ caller for a given source waits for the full
   encode before any bytes arrive.

2. **No request coalescing.** Two simultaneous misses for the same source trigger
   two encodes (last write into R2 wins).

3. **Cache is never invalidated.** Objects are immutable per
   `OUTPUT_PREFIX`/`sha256(url)` and served with a 1-year `immutable`
   `Cache-Control`. Changing encode behavior requires bumping `OUTPUT_PREFIX`.

4. **No origin restrictions.** The Worker will fetch any `http(s)` URL it's
   given. There's no allowlist, auth, or rate limiting.

5. **No input verification.** We assume the source is a video ffmpeg can read.
   We don't probe container/codecs first.

6. **`OPTIONS` is _not_ normalized for the cache key.** The Worker hashes the
   `<OPTIONS>` path segment exactly as received, so two requests with
   semantically-identical but differently-formatted flags will each trigger
   their own Media Transformations request and AV1 encode.

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

**v0.3.2:** CRF bump, informed by VMAF

- Goal: Increase CRF to shoot for a VMAF closer to 90 and record any size or
  encoding time savings.
- Container changes: `-crf` raised from `30` to `36` then `40`
- Worker changes: Storage namespace incremented
- Findings:
  - Sample at `height=1080` (original height) and CRF 36:
    - (Previous reference) Media Transformations H.264: 13.87MB in 8.5s (VMAF overall 94.6, measured against original)
    - Aveeone AV1 (based on MT): 13.93MB in 69s (VMAF overall 91.02, measured against original)
    - Aveeone AV1 (based on raw input): 10.8MB in 87s (VMAF overall 93.73, measured against original)
  - Sample at `height=1080` and CRF 40:
    - (Previous reference) MT H.264: 13.87MB in 8.5s (VMAF overall 94.6)
    - Aveeone AV1 (based on MT): 7.2MB in 54s (VMAF overall 89.9)
    - Aveeone AV1 (based on raw input): 8.5MB in 66s (VMAF overall 92.2)
  - Sample at `width=640` and CRF 40:
    - MT H.264: 2.5MB in 1s
    - Aveeone AV1 (based on MT): 1.3MB in 15s (VMAF _against MT 640_ 90.9)

**v0.3.1:** Minor levers to reduce filesize and normalize consistently

- Goal: Latest test showed AV1 output filesize matched or was larger than Media
  Transformations' own H.264 for the sample. Compared ffmpeg invocations against
  Media Transformations codebase:
  - MT uses `libx264` with no explicit `-crf`/`-preset` --- so x264's own
    defaults, CRF 23 / preset medium, apply.
  - MT pins `aac` audio output at `-b:a 64k`.
- Container changes:
  - `-c:a copy` when the input is a Media Transformations edited variant —
    Cloudflare has already AAC-encoded that audio at 64k.
  - Otherwise, pin audio at 96k for a raw source, lower than default.
  - `-pix_fmt yuv420p10le` added unconditionally: forces 10-bit internal
    SVT-AV1 encoding even from 8-bit sources --- a well-established\* AV1
    compression trick — more internal precision, less quantization error, at
    equal-or-better perceptual quality.
    - _\* Citation needed; this was an unexpected Claude suggestion._
  - CRF (still 30) and preset (still 6) left alone here; need VMAF for comparison.
- Worker changes:
  - New header passed to container to indicate if source is Media Transformations.
    - _@TODO: That should be evident from the URL sent to the container..._
- Findings:
  - Fetching sample resized (`width=640`):
    - Media Transformations H.264: 2.47MB in 2.4s
    - Aveeone AV1: 2.27MB in 23.2s
  - Sample at `height=720`:
    - Media Transformations H.264: 7.16MB in 7.7s
    - Aveeone AV1: 7.28MB in 56.2s
  - Sample at `height=1080` (original height):
    - Media Transformations H.264: 13.87MB in 8.5s (VMAF overall 94.6, measured against original)
    - Aveeone AV1 (based on MT): 13.93MB in 109.4s (VMAF overall 92.39, measured against original)
    - Aveeone AV1 (based on raw input): 16.65MB in 83s (VMAF overall 95.94, measured against original)
- Next steps:
  - Now that we have VMAF scores, measure perceptual quality tradeoffs with
    filesize reduction; could probably raise CRF a lot for an even trade on quality.
  - Current prototype design using Media Transformations for editing is useful,
    but may need to propose a `quality` lever to get a better output to use in
    transcode to AV1 --- otherwise we risk "copy of a copy" degradation. However
    current VMAF score shows this is within tolerance.

**v0.3.0:** Route requests via Cloudflare Media Transformations first.

- Goal: Be able to serve transformation operations without rebuilding the entire
  product in this prototype.
- Worker changes:
  - On a cache miss, if `OPTIONS` contains an `=`, the Worker now first requests
    `https://<host>/cdn-cgi/media/<OPTIONS>/<SOURCE_URL>` and feeds the resulting
    edited variant into the AV1 transcoder. Otherwise, it's just a cache buster.
- Container changes:
  - Nothing in this version
- Findings:
  - Fetching an AV1 of the resized (`width=640`) sample asset finished in 21
    seconds. Repeating that fetch returned in 0.35s.
    - Media Transformations H.264: 2.47MB
    - Aveeone AV1: 2.42MB
  - At a larger size (`height=720`):
    - Media Transformations H.264: 7.16MB returned in 5.8 seconds.
    - Aveeone AV1: 7.50MVB returned in 52 seconds.
  - At `height=1080` (which is the original size of the asset):
    - Original:
    - Media Transformations H.264: 13.8MB in 1.09s
    - Aveeone AV1 based on MT result: 14.19MB in 88.9s
    - Aveeone AV1 based on original: 16.88MB in 109.6s

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
