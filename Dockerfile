# Χριστιανισμός - Επιστήμη -- local podcast archive player.
#
# The image ships ONLY the site and server. The 20 GB of audio stays on the
# host and is bind-mounted read-only at /archive; the episode index is rebuilt
# from that mount every time the container starts.
#
#   docker build -t christianity-science-pwa _site/
#   docker run -p 8080:8080 -v "$PWD:/archive:ro" christianity-science-pwa

FROM python:3.13-alpine

# Standard OCI metadata -- org.opencontainers.image.source is what registries,
# Renovate, and GitHub use to tie this image back to its source repository.
LABEL org.opencontainers.image.title="Χριστιανισμός - Επιστήμη" \
      org.opencontainers.image.description="Installable offline-capable player for the Greek podcast Χριστιανισμός - Επιστήμη. Audio stays on the host and is mounted read-only." \
      org.opencontainers.image.source="https://github.com/GiorgosPap777/christianity-science-pwa" \
      org.opencontainers.image.url="https://hub.docker.com/r/giorgospap777/christianity-science-pwa" \
      org.opencontainers.image.documentation="https://github.com/GiorgosPap777/christianity-science-pwa#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="1.0.3"

# ffprobe supplies the per-part durations the episode progress bar needs.
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY . /app/_site/

RUN chmod +x /app/_site/entrypoint.sh \
 && adduser -D -u 10001 app \
 && chown -R app:app /app

# The index is generated at runtime, so it must be writable no matter which
# uid the container is told to run as (people override this to match their
# archive's ownership). /app stays read-only; only /data is written.
RUN install -d -m 0777 /data

ENV ARCHIVE_ROOT=/archive \
    HOST=0.0.0.0 \
    PORT=8080 \
    REBUILD_INDEX=1 \
    INDEX_OUT=/data/index.json \
    PYTHONUNBUFFERED=1

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python3 -c "import os,sys,urllib.request; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/_site/',timeout=4).status==200 else 1)"

ENTRYPOINT ["/app/_site/entrypoint.sh"]
