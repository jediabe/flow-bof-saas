# Tiny cron sidecar for the BOF Dashboard auto-refresh.
#
# One job for the whole SaaS: hit the app's /api/cron/{task}
# endpoints on a schedule. Uses busybox crond (bundled in Alpine)
# so the image stays small — final size is a few MB.
#
# Container start:
#   1. entrypoint.sh writes a crontab that inlines the current
#      CRON_SECRET (busybox crond doesn't inherit env vars into
#      scheduled commands, so we have to bake them in at boot).
#   2. crond runs in the foreground.
#   3. Its output tees to /var/log/cron.log which we tail so
#      `docker compose logs cron` shows what happened.
#
# Zero secrets committed to this image. The entire configuration
# comes from env_file at run time.

FROM alpine:3.19

RUN apk add --no-cache curl bash tzdata

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Default timezone. Override with TZ in .env.production if you
# want the "once a day" job to land at a different local hour.
ENV TZ=UTC

ENTRYPOINT ["/entrypoint.sh"]
