#!/usr/bin/env bash
# Is the relay answering? Prints the body and exits non-zero if it is not `ok`.
#
#   ./healthcheck.sh relay.example.com
#   HOST=relay.example.com ./healthcheck.sh
#
# Use it from cron or an uptime checker. /healthz is the ONLY endpoint that
# reports anything: there is no status page, because there is no state to show.
set -euo pipefail

HOST="${1:-${HOST:-}}"
[ -n "$HOST" ] || { echo "usage: healthcheck.sh <host>" >&2; exit 2; }

body="$(curl -fsS --max-time 10 "https://$HOST/healthz")"
if [ "$body" = "ok" ]; then
  echo "relay $HOST: ok"
else
  echo "relay $HOST: unexpected body: $body" >&2
  exit 1
fi
