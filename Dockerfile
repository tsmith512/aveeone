# --- ffmpeg stage -----------------------------------------------------------
# mwader/static-ffmpeg ships a fully static ffmpeg built with libsvtav1 (AV1)
# and AAC support, so we just copy the binaries into our runtime image.
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

# --- runtime stage ----------------------------------------------------------
# Alpine for a small image. The static ffmpeg binary is fully self-contained,
# so it runs fine on musl/Alpine. We add curl for the source preflight check.
FROM node:22-alpine

# curl is used for the source preflight check (reachability + size cap).
# Prefer HTTPS repos; fall back to HTTP if a TLS-intercepting proxy makes the
# Alpine CDN cert untrusted (common on corporate networks / Docker Desktop).
RUN apk add --no-cache curl \
 || ( sed -i 's|https://|http://|g' /etc/apk/repositories && apk add --no-cache curl )

# Bring in the static ffmpeg binary (no extra system libs needed). ffprobe is
# intentionally omitted: the server only invokes ffmpeg, and dropping ffprobe
# removes a large (~70 MB) image layer.
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg

WORKDIR /app

# The server has zero npm dependencies (pure Node builtins), so just copy it.
COPY container_src/server.mjs ./server.mjs

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
