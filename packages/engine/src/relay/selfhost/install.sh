#!/usr/bin/env bash
# Install the Origami Remote relay on a Debian or Ubuntu host.
#
# The script is idempotent: run it again to upgrade the binary or the phone
# shell. It creates a system user, unpacks the release, copies the shell, writes
# the systemd unit and starts the service. It never pipes a downloaded file into
# a shell — the only thing it fetches is the release archive named below.
#
#   sudo ORIGAMI_RELEASE_URL=... ORIGAMI_RELEASE_SHA256=... APP_SRC=./remote ./install.sh
#
set -euo pipefail

# ---------------------------------------------------------------- settings --

# The release archive for THIS machine's platform. Linux assets are named
# linux-x64.tar.gz and linux-arm64.tar.gz and hold a single file, `origami`.
# Take the URL from the release page of the Origami Coder repository you use.
ORIGAMI_RELEASE_URL="${ORIGAMI_RELEASE_URL:-}"

# The SHA-256 of that archive. SHA256SUMS.txt on the same release page carries
# one line per asset. Required, unless you deliberately set
# ORIGAMI_ALLOW_UNVERIFIED=1 below.
ORIGAMI_RELEASE_SHA256="${ORIGAMI_RELEASE_SHA256:-}"

# Install without checking the archive. An unset checksum is usually a broken
# wrapper script, not a decision, so the decision has to be written down.
ORIGAMI_ALLOW_UNVERIFIED="${ORIGAMI_ALLOW_UNVERIFIED:-}"

# The phone shell: the contents of `out/remote/` from the Origami Coder
# extension (index.html, remote.js, remote.css, chat.js, the icon and the
# webmanifest). Copy that folder off a machine with the extension installed.
# Leave it empty to keep whatever is already installed.
APP_SRC="${APP_SRC:-}"

RELAY_USER="${RELAY_USER:-origami}"
PREFIX="${PREFIX:-/opt/origami}"
PORT="${PORT:-8787}"
BIND="${BIND:-127.0.0.1}"
DAILY_BUDGET_MB="${DAILY_BUDGET_MB:-2048}"
BULK_RID_MB_PER_MINUTE="${BULK_RID_MB_PER_MINUTE:-20}"

BIN_DIR="$PREFIX/bin"
APP_DIR="$PREFIX/remote-app"
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/origami-relay.service"
UNIT_DST="/etc/systemd/system/origami-relay.service"

# ------------------------------------------------------------ preflight --

die() { echo "install.sh: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
for tool in curl tar systemctl install id; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
[ -n "$ORIGAMI_RELEASE_URL" ] || die "set ORIGAMI_RELEASE_URL to the release archive for this platform"
if [ -z "$ORIGAMI_RELEASE_SHA256" ] && [ "$ORIGAMI_ALLOW_UNVERIFIED" != "1" ]; then
  die "set ORIGAMI_RELEASE_SHA256 (its line is in SHA256SUMS.txt on the release page), or set ORIGAMI_ALLOW_UNVERIFIED=1 to install without checking"
fi
[ -f "$UNIT_SRC" ] || die "origami-relay.service is not next to this script"
if [ -n "$APP_SRC" ] && [ ! -f "$APP_SRC/index.html" ]; then
  die "APP_SRC=$APP_SRC does not contain index.html — point it at the extension's out/remote/"
fi

# ---------------------------------------------------------------- user --

if id -u "$RELAY_USER" >/dev/null 2>&1; then
  echo "user $RELAY_USER already exists"
else
  echo "creating system user $RELAY_USER"
  useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$RELAY_USER"
fi

install -d -o root -g root -m 0755 "$PREFIX" "$BIN_DIR"
install -d -o root -g "$RELAY_USER" -m 0755 "$APP_DIR"

# -------------------------------------------------------------- binary --

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "downloading $ORIGAMI_RELEASE_URL"
curl -fsSL --proto '=https' --tlsv1.2 -o "$work/origami.tar.gz" "$ORIGAMI_RELEASE_URL"

# Integrity, checked BEFORE the archive is unpacked. This catches a corrupted
# or swapped download. It cannot catch a release published from a compromised
# account, because that account writes SHA256SUMS.txt too — compare the value
# out of band if that matters to you.
if [ -n "$ORIGAMI_RELEASE_SHA256" ]; then
  command -v sha256sum >/dev/null 2>&1 || die "missing required tool: sha256sum"
  # Accept the value as people really paste it: any case, stray whitespace, or
  # the whole "<hash>  <filename>" line copied out of SHA256SUMS.txt.
  want="$(printf '%s' "$ORIGAMI_RELEASE_SHA256" | tr 'A-Z' 'a-z' | tr -d '[:space:]' | cut -c 1-64)"
  case "$want" in
    *[!0-9a-f]* | "") die "ORIGAMI_RELEASE_SHA256 is not a SHA-256: $ORIGAMI_RELEASE_SHA256" ;;
  esac
  [ "${#want}" -eq 64 ] || die "ORIGAMI_RELEASE_SHA256 is not 64 hex characters: $ORIGAMI_RELEASE_SHA256"
  got="$(sha256sum "$work/origami.tar.gz" | cut -d ' ' -f 1)"
  [ "$got" = "$want" ] || die "checksum mismatch: expected $want, got $got"
  echo "checksum verified"
else
  echo "install.sh: installing UNVERIFIED — ORIGAMI_ALLOW_UNVERIFIED=1 is set" >&2
  echo "            and no checksum was given." >&2
fi

tar -xzf "$work/origami.tar.gz" -C "$work"
[ -f "$work/origami" ] || die "the archive does not contain a file named origami"

# Installed to a temporary name and moved, so an upgrade never leaves a
# half-written binary that systemd could restart into.
install -o root -g root -m 0755 "$work/origami" "$BIN_DIR/origami.new"
mv -f "$BIN_DIR/origami.new" "$BIN_DIR/origami"
echo "installed the relay binary to $BIN_DIR/origami"

# ----------------------------------------------------------- phone shell --

if [ -n "$APP_SRC" ]; then
  echo "copying the phone shell from $APP_SRC"
  rm -rf "${APP_DIR:?}"/*
  cp -R "$APP_SRC"/. "$APP_DIR"/
  chown -R "$RELAY_USER":"$RELAY_USER" "$APP_DIR"
  chmod -R u=rwX,go=rX "$APP_DIR"
elif [ ! -f "$APP_DIR/index.html" ]; then
  echo "WARNING: $APP_DIR has no index.html — pairing will 404 until you copy the shell there" >&2
fi

# ---------------------------------------------------------------- unit --

echo "writing $UNIT_DST"
# origami-relay.service ships with the defaults spelled out, so it can be read
# and copied by hand without this script. Only the values the caller CHANGED
# are rewritten here.
sed \
  -e "s|^User=origami$|User=$RELAY_USER|" \
  -e "s|^Group=origami$|Group=$RELAY_USER|" \
  -e "s|/opt/origami|$PREFIX|g" \
  -e "s|--hostname 127.0.0.1|--hostname $BIND|" \
  -e "s|--port 8787|--port $PORT|" \
  -e "s|--daily-budget-mb 2048|--daily-budget-mb $DAILY_BUDGET_MB|" \
  -e "s|--bulk-rid-mb-per-minute 20|--bulk-rid-mb-per-minute $BULK_RID_MB_PER_MINUTE|" \
  "$UNIT_SRC" > "$UNIT_DST"
chmod 0644 "$UNIT_DST"

systemctl daemon-reload
systemctl enable origami-relay
systemctl restart origami-relay

echo
echo "relay running on $BIND:$PORT — check it with:"
echo "  curl -fsS http://$BIND:$PORT/healthz"
echo "Put a TLS terminator in front of it (see Caddyfile), then point the"
echo "extension setting origamicoder.remote.relayUrl at wss://<your host>."
