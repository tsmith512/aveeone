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
- `<SOURCE_URL>` is the full `http(s)` URL of the source MP4. If omitted, a
  default test clip (`https://assets.tsmith.net/aus-mobile.mp4`) is used.

Deployed at **https://aveeone.tsmith.net** (custom domain).

### Example

```
https://aveeone.tsmith.net/transform/https://example.com/video.mp4

# No source URL -> transcodes the default test footage:
https://aveeone.tsmith.net/
```

## How it works

```
client ──▶ Worker (src/index.ts)
                │  parses source URL from the path
                │  validates it's http(s)
                ▼
           Container DO "Transcoder"  (one ffmpeg per instance)
                │  container_src/server.mjs receives X-Source-Url
                │  curl preflight: reachable? size <= 1 GiB?  (else 500)
                ▼
           ffmpeg -i <SOURCE_URL>
                   -c:v libsvtav1 -preset 6 -crf 26
                   -c:a aac
                   -dn -map_chapters -1
                   -movflags +frag_keyframe+empty_moov+default_base_moof
                   -f mp4 pipe:1
                │  stdout (fragmented MP4)
                ▼
           streamed back through the Worker to the client
```

- Before encoding, the container runs a **`curl` preflight** (`HEAD`, following
  redirects) to confirm the source is reachable and to reject inputs whose
  `Content-Length` exceeds **1 GiB** — both return a `500` JSON with context.
- `-dn -map_chapters -1` keeps the output to video + audio only (the source's
  chapter markers would otherwise be muxed in as a stray `bin_data` text track).
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
| `Dockerfile`              | `node:22-alpine` + static `ffmpeg` (`libsvtav1`) + curl |
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
# Transcode a specific source:
curl -L \
  "https://aveeone.tsmith.net/x/https://example.com/video.mp4" \
  -o out.mp4

# Or just hit the root to transcode the default test footage:
curl -L "https://aveeone.tsmith.net/" -o out.mp4

# Inspect the result (should report av1 video + aac audio, no data track):
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

Stages you may see: `request-validation`, `validate-source-url`,
`container-dispatch` (Worker side) and `container-validate`, `preflight`,
`spawn`, `ffmpeg-error`, `ffmpeg-exit`, `container-unhandled` (container side).
The `preflight` stage covers unreachable sources and the >1 GiB size cap.

All failures are also logged, and Workers **observability is enabled with 100%
sampling for both logs and traces** (`wrangler.jsonc`).

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
   exposing this publicly. (The 1 GiB preflight cap only limits size, not
   destination.)

5. **No input verification.** We assume the source is a video ffmpeg can read.
   We don't probe container/codecs first.
