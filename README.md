# Aveeone

> Pronounced like **AV1**, the codec.

A Cloudflare Worker that takes a URL to an MP4 video and transcodes it to
**AV1 / AAC** on the fly using a Workers Container running `ffmpeg`
(`libsvtav1`). The result is streamed back as an MP4 HTTP response.

The URL scheme mirrors
[Cloudflare Media Transformations](https://developers.cloudflare.com/stream/transform-videos/#transform-a-video-by-url):

```
https://<host>/<ARBITRARY_TEXT>/<SOURCE_URL>
```

- `<ARBITRARY_TEXT>` is where transform options would normally go. **This
  project ignores it** (no options/flags are supported).
- `<SOURCE_URL>` is the full `http(s)` URL of the source MP4.

### Example

```
https://aveeone.<account>.workers.dev/transform/https://example.com/video.mp4
```

## How it works

```
client ──▶ Worker (src/index.ts)
                │  parses source URL from the path
                │  validates it's http(s)
                ▼
          Container DO "Transcoder"  (one ffmpeg per instance)
                │  container_src/server.mjs receives X-Source-Url
                ▼
          ffmpeg -i <SOURCE_URL>
                  -c:v libsvtav1 -preset 6 -crf 26
                  -c:a aac
                  -movflags +frag_keyframe+empty_moov+default_base_moof
                  -f mp4 pipe:1
                │  stdout (fragmented MP4)
                ▼
          streamed back through the Worker to the client
```

- **ffmpeg fetches the source itself** (the container has `enableInternet`),
  so the bytes never round-trip through the Worker on the way in.
- Output is a **fragmented MP4** (`+frag_keyframe+empty_moov`). This is what
  lets us stream it straight out of an ffmpeg pipe — a normal MP4 needs a
  seekable output to write its `moov` atom, which a pipe is not.

## Project layout

| Path                      | What it is                                            |
| ------------------------- | ----------------------------------------------------- |
| `src/index.ts`            | The Worker + the `Transcoder` Container class         |
| `container_src/server.mjs`| HTTP server inside the container that drives ffmpeg   |
| `Dockerfile`              | Node + static `ffmpeg` (with `libsvtav1`) image       |
| `wrangler.jsonc`          | Worker / container / Durable Object config            |

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

### Try it

```bash
# Replace with your deployed host and a real source MP4 URL.
curl -L \
  "https://aveeone.<account>.workers.dev/x/https://test-videos.co.uk/sample.mp4" \
  -o out.mp4

# Inspect the result (should report av1 video + aac audio):
ffprobe out.mp4
```

## Failure behaviour

Per spec, **any failure returns HTTP 500 with a JSON body** containing as much
context as possible, e.g.:

```json
{
  "error": "ffmpeg exited with a non-zero status before producing output",
  "stage": "ffmpeg-exit",
  "requestId": "1f0c...",
  "sourceUrl": "https://example.com/video.mp4",
  "exitCode": 1,
  "stderr": "..."
}
```

Stages you may see: `request-validation`, `parse-source-url`,
`validate-source-url`, `container-dispatch` (Worker side) and
`container-validate`, `spawn`, `ffmpeg-error`, `ffmpeg-exit` (container side).

All failures are also logged, and Workers **observability is enabled with 100%
trace sampling** (`wrangler.jsonc`).

## Known trade-offs & limitations

These were deliberate choices for a first version — worth understanding before
relying on it:

1. **Synchronous + slow.** `libsvtav1 -preset 6` is much slower than realtime.
   The client connection stays open for the entire encode, so large/long
   videos can take minutes. There is no caching, queueing, or async job model.

2. **Mid-stream failures can't become a 500.** Because we stream, we commit to
   `HTTP 200` as soon as ffmpeg emits its first byte. We delay that commit until
   the first output byte so most failures (bad URL, unsupported/corrupt input,
   decode errors) still return a clean 500 JSON. But if ffmpeg dies *after*
   output has started, the response is a **truncated** MP4 — we can only `end()`
   the stream and log the full error (look for `mid-stream-exit` in logs).

3. **Fragmented MP4, not faststart.** The output uses fragmented MP4 so it can
   be piped. It plays fine in browsers and most players. If you need a classic
   single-`moov` faststart MP4, you'd buffer to disk in the container and serve
   the whole file (higher time-to-first-byte).

4. **Open transcoder / SSRF.** The Worker will fetch any `http(s)` URL it's
   given. There's no allowlist, auth, or rate limiting. Add those before
   exposing this publicly.

5. **No input verification.** We assume the source is a video ffmpeg can read.
   We don't probe container/codecs first.
