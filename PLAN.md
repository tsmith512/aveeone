# Aveeone — Implementation Plan / Spec

> Pronounced like **AV1**, the codec.

A Cloudflare Worker that accepts a URL to an MP4 video and transcodes it to
**AV1 / AAC** on the fly using a Workers Container running `ffmpeg`
(`libsvtav1`), streaming the result back as an MP4 HTTP response.

## 1. Goal & scope

- **In scope:** URL in → transcoded AV1/AAC MP4 out, via a single Worker that
  delegates the encode to a Workers Container.
- **Out of scope (by spec):** options/flags, caching, auth, queueing/async jobs,
  root-relative source URLs (full `http(s)` URLs only).

## 2. URL contract

Mirrors [Cloudflare Media Transformations](https://developers.cloudflare.com/stream/transform-videos/#transform-a-video-by-url):

```
https://<host>/<ARBITRARY_TEXT>/<SOURCE_URL>
```

- `<ARBITRARY_TEXT>` — where transform options would live; **ignored**.
- `<SOURCE_URL>` — full `http(s)` URL of the source MP4.

Example:

```
https://aveeone.<account>.workers.dev/transform/https://example.com/video.mp4
```

Parsing rules:

- `URL.pathname` preserves the literal `https://...` (does not collapse `//`),
  so the source is everything after the first path segment.
- The source's own query string is taken from `url.search` and re-appended.
- Both literal and percent-encoded source forms are accepted.

## 3. Architecture

```
client ──▶ Worker (src/index.ts)
                │  parse source URL from path (drop first segment)
                │  validate http(s)
                ▼
          Container DO "Transcoder"  (one ffmpeg per instance)
                │  container_src/server.mjs receives X-Source-Url header
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

- **ffmpeg fetches the source itself** (container has `enableInternet: true`),
  so source bytes never round-trip through the Worker on the way in.
- Output is **fragmented MP4** so it can be streamed straight out of an ffmpeg
  pipe — a normal MP4 needs a seekable output to write its `moov` atom.

## 4. Components

| Path                       | Responsibility                                                  |
| -------------------------- | --------------------------------------------------------------- |
| `src/index.ts`             | Worker entrypoint + `Transcoder` Container class                |
| `container_src/server.mjs` | HTTP server inside the container; drives ffmpeg                 |
| `Dockerfile`               | `node:22-slim` + static `ffmpeg` (with `libsvtav1`)             |
| `wrangler.jsonc`           | Worker / container / Durable Object config                      |
| `package.json`             | Scripts + deps (`@cloudflare/containers`, wrangler, TS)         |
| `tsconfig.json`            | Strict TS, Worker-only (`container_src` excluded)               |

### 4.1 Worker (`src/index.ts`)

- Accepts `GET`/`HEAD` only.
- `extractSourceUrl()` parses the source from the path (per §2).
- Validates the source is an absolute `http:`/`https:` URL.
- Dispatches to a container instance keyed by a per-request UUID
  (`env.TRANSCODER.getByName(requestId)`) → **one ffmpeg per instance**,
  isolated up to `max_instances`.
- Forwards the source via an `X-Source-Url` header (plus `X-Request-Id`).
- The `@cloudflare/containers` base `fetch()` auto-starts the container, waits
  for the port, and proxies to `defaultPort`. Worker passes the container's
  response straight through, adding `X-Request-Id`.

### 4.2 `Transcoder` Container class

```ts
export class Transcoder extends Container<Env> {
  defaultPort = 8080;     // HTTP server inside the container
  sleepAfter = "10m";     // keep warm; live requests keep long encodes active
  enableInternet = true;  // required so ffmpeg can pull the source
}
```

### 4.3 Container server (`container_src/server.mjs`)

- Plain ESM JS (no TS build step needed in the image).
- Routes: `GET /` and `/health` → `200 ok` (lets port readiness checks pass);
  `GET|HEAD /transcode` → the encode; everything else → `404` JSON.
- `HEAD /transcode` → `200 video/mp4`, no body, no work.
- `GET /transcode`:
  1. Read `X-Source-Url` (missing → `500` JSON).
  2. `spawn("ffmpeg", args)` with stdout piped.
  3. Keep a rolling tail (≤64 KiB) of stderr for error reporting.
  4. **Delay the 200 commit until the first stdout byte**, then write
     `200 video/mp4` headers and pipe the rest.
  5. On spawn error / non-zero exit **before** first byte → `500` JSON with
     `exitCode`, `signal`, `stderr` tail.
  6. On failure **after** streaming started → `end()` (truncated) + log.
  7. If the client disconnects (`res` close) → `SIGKILL` ffmpeg.

ffmpeg argument set (fixed; no user options):

```
-hide_banner -loglevel error
-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 2   # resilient source pull
-i <SOURCE_URL>
-c:v libsvtav1 -preset 6 -crf 26
-c:a aac
-movflags +frag_keyframe+empty_moov+default_base_moof       # streamable fMP4
-f mp4 pipe:1
```

### 4.4 Dockerfile

- Stage 1: `mwader/static-ffmpeg:7.1` (static ffmpeg built with `libsvtav1` +
  AAC).
- Stage 2: `node:22-slim`; copy `ffmpeg`/`ffprobe` binaries + `server.mjs`;
  `CMD ["node", "server.mjs"]`; `EXPOSE 8080`.
- Zero npm dependencies inside the container (pure Node builtins).

### 4.5 `wrangler.jsonc`

- `compatibility_date: "2025-03-07"`, `compatibility_flags: ["nodejs_compat"]`.
- `observability: { enabled: true, head_sampling_rate: 1 }` (100% traces).
- `containers[]`: `class_name: "Transcoder"`, `image: "./Dockerfile"`,
  `instance_type: "standard-4"` (most vCPU; AV1 is CPU-heavy),
  `max_instances: 10`.
- `durable_objects.bindings[]`: `TRANSCODER` → `Transcoder`.
- `migrations[]`: `new_sqlite_classes: ["Transcoder"]`.

## 5. Failure model

Per spec, **any failure returns HTTP 500 with a JSON body** carrying maximum
context, and is also logged (observability on, 100% sampling).

Shape:

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

Stages:

- Worker: `request-validation`, `parse-source-url`, `validate-source-url`,
  `container-dispatch`.
- Container: `container-validate`, `spawn`, `ffmpeg-error`, `ffmpeg-exit`,
  `container-route`.

## 6. Key decisions & trade-offs

1. **Streaming vs. "always 500 JSON".** These conflict. Resolved by delaying the
   `200` commit until ffmpeg's first output byte, so most failures (bad URL,
   unsupported/corrupt input, decode errors) still return clean `500` JSON.
   **Limitation:** a mid-stream ffmpeg failure yields a *truncated* MP4 — we can
   only `end()` and log (`mid-stream-exit`).
2. **Fragmented MP4, not faststart.** Necessary to pipe MP4 out without a
   seekable output. Plays in browsers/most players. A faststart single-`moov`
   MP4 would require buffering to container disk (higher time-to-first-byte).
3. **Synchronous + slow.** `libsvtav1 -preset 6` is far slower than realtime;
   the client connection stays open for the whole encode. No caching/queue/async
   job model.
4. **One ffmpeg per container instance** via per-request UUID for isolation.
5. **Container pulls the source directly** to avoid double-proxying bytes.

## 7. Known gaps / not addressed (by spec)

- **SSRF / open transcoder:** any `http(s)` URL is fetched; no allowlist, auth,
  or rate limiting.
- **No input verification:** source is assumed to be ffmpeg-readable; no
  `ffprobe` pre-check.
- **No root-relative source URLs** (full URLs only).
- **Beta dependency:** `@cloudflare/containers` (v0.0.18) API may change.

## 8. Build / deploy

```bash
npm install
npm run typecheck     # tsc --noEmit (Worker)
npm run dev           # local dev (needs Docker for the container build)
npm run deploy        # builds & pushes image, then the Worker
```

Requires Docker locally for image builds and a Cloudflare account with
Containers (beta) enabled.

### Smoke test

```bash
curl -L \
  "https://aveeone.<account>.workers.dev/x/https://test-videos.co.uk/sample.mp4" \
  -o out.mp4
ffprobe out.mp4   # expect: av1 video + aac audio
```

## 9. Verification status

- `tsc --noEmit` — passes.
- `wrangler types` — config parses; types generated.
- `node --check container_src/server.mjs` — syntax OK.
- **Not** verified: real Docker image build and an end-to-end transcode (Docker
  unavailable in the authoring environment).
