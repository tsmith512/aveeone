# --- ffmpeg stage -----------------------------------------------------------
# mwader/static-ffmpeg ships a fully static ffmpeg built with libsvtav1 (AV1)
# and AAC support, so we just copy the binaries into our runtime image.
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

# --- runtime stage ----------------------------------------------------------
FROM node:22-slim

# Bring in the static ffmpeg/ffprobe binaries (no extra system libs needed).
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

WORKDIR /app

# The server has zero npm dependencies (pure Node builtins), so just copy it.
COPY container_src/server.mjs ./server.mjs

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
