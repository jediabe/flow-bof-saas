#!/bin/sh
#
# Boot script for the BOF Dashboard cron sidecar.
#
# Writes a crontab that inlines CRON_SECRET + APP_INTERNAL_URL
# so busybox crond doesn't need to forward env vars (which it
# doesn't do by default). Then starts crond in the foreground and
# tails the log so `docker compose logs cron` shows the schedule
# firing.

set -e

if [ -z "$CRON_SECRET" ]; then
  echo "❌ CRON_SECRET is not set. Refusing to start cron." >&2
  echo "   Set it in .env.production alongside the other app secrets." >&2
  exit 1
fi

APP_URL="${APP_INTERNAL_URL:-http://app:3000}"
CRON_LOG="/var/log/cron.log"

echo "▶ cron sidecar starting"
echo "   target:   $APP_URL"
echo "   log:      $CRON_LOG"
echo "   TZ:       ${TZ:-UTC}"

# curl flags:
#   -sS   silent + show errors on failure
#   -f    fail on 4xx/5xx so cron logs actually reflect problems
#   -m 300  cap at 5 min per call — the health-and-revenue task
#           iterates every account and can be slow when the workspace
#           has many. Products can be even slower, but 5 min is a
#           hard ceiling; anything longer is a signal to page.
CURL="curl -sS -f -m 300 -X POST -H \"Authorization: Bearer $CRON_SECRET\""

mkdir -p /var/spool/cron/crontabs
cat > /var/spool/cron/crontabs/root <<CRONTAB
# BOF Dashboard auto-refresh schedule
# Times in ${TZ:-UTC}.
#
# Every 6 hours (00:00, 06:00, 12:00, 18:00): health + revenue.
# Cheap TikHub calls; keeps the analytics dashboard fresh 4x/day.
0 */6 * * * $CURL "$APP_URL/api/cron/health-and-revenue" >> $CRON_LOG 2>&1 || echo "\$(date -Iseconds) health-and-revenue FAILED" >> $CRON_LOG

# Once a day at 03:15 UTC: full product pull. Heavier — walks
# every account's product list plus attribution chains. Staggered
# off the top of the hour so it doesn't collide with the 6-hourly
# health job at 03:00.
15 3 * * * $CURL "$APP_URL/api/cron/products" >> $CRON_LOG 2>&1 || echo "\$(date -Iseconds) products FAILED" >> $CRON_LOG
CRONTAB

# Make sure the log file exists so tail -f works immediately even
# before the first job fires.
touch "$CRON_LOG"

# Boot line into the log for a clean audit trail.
echo "$(date -Iseconds) cron sidecar booted (TZ=${TZ:-UTC})" >> "$CRON_LOG"

# Run crond in foreground. -l 8 = max verbosity so scheduled
# command output ends up in the container's stdout via the tail.
crond -f -l 8 &
CROND_PID=$!

# Tail the log so `docker compose logs cron` sees every fired
# request. When crond dies we exit so Docker's restart policy
# can bring the container back cleanly.
tail -F "$CRON_LOG" &
TAIL_PID=$!

# Propagate signals to crond so `docker compose down` shuts us
# down promptly rather than waiting for tail's grace period.
trap 'kill -TERM "$CROND_PID" "$TAIL_PID" 2>/dev/null; wait' TERM INT

wait "$CROND_PID"
