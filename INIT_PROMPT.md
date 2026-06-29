We're going to build "Aveeone" (pronounced like 'AV1', the codec). I want it to be a simple Cloudflare Worker that accepts a URL to an MP4 video file and uses a Workers Container with ffmpeg to transcode it to AV1 for delivery.

Example URL format: https://<EXAMPLE>.workers.dev/<ARBITRARY_TEXT>/<URL>

- This follows the pattern described by Cloudflare Media Transformations - https://developers.cloudflare.com/stream/transform-videos/#transform-a-video-by-url
- This project will not support any options/flags, so skip over the path component ARBITRARY_TEXT
- For now, assume URL is a full URL, not a root-relative path

Disclaimer: I am familiar with ffmpeg and Workers, but not Workers Containers. Please ask clarifying questions, challenge assumptions, and offer trade-offs as appropriate.

Tech stack:

- External surface is a simple Cloudflare Worker. Refer to CLOUDFLARE.md for code standards guidance.
  - Observability on, 100% sampling, collect traces
- The Container itself will:
  - need to receive the URL
  - dynamically fetch it with ffmpeg
  - transcode as-is to av1/aac: -c:v libsvtav1 -preset 6 -crf 26 -c:a aac
  - output as an MP4 that can be delivered as a Worker response

Failure modes:

- In the event of any failure, return HTTP 500, but output as much possible information in a JSON response
