# Run your own Origami Remote relay

Ten minutes on a small server, and your phone reaches your desktop through a
machine you own.

This folder is the whole kit. It is self-contained on purpose: it is published
as its own repository (`origami-relay`), so nothing here points back into the
Origami Coder source tree.

---

## What a relay is, and why you need one

Your phone is on a mobile network. Your desktop is behind a home router. Neither
can open a connection to the other. Every remote-control product solves this the
same way: a third machine that both sides CAN reach, which passes bytes between
them.

The Origami relay is that third machine and nothing more.

- It matches two sockets by a random pairing id and copies frames between them.
- The frames are sealed on the desktop and opened on the phone. The key never
  leaves those two devices, and the pairing id itself is derived from the key,
  so the relay cannot work backwards to it.
- It stores nothing. It keeps a short in-memory ring of recent frames so a phone
  that lost signal can catch up, and that ring is gone when the process stops.

| The relay sees | The relay does not see |
|---|---|
| A random pairing id, connect and disconnect times, the number and padded size of frames | Prompts, replies, file paths, diffs, tool names, repository names, model names, who you are |

There is no sign-in, so there is nothing to join a pairing to a person.

Running your own removes even that much from anyone else's machine.

---

## What you need

- A small server with a **public IPv4 address**. The relay is a socket switch:
  1 shared vCPU and 1 GB of memory are enough. Any fixed-price provider works.
  Avoid per-request or per-GB pricing — a relay holds long connections and the
  bill becomes hard to predict.
- A **name you control**, for example `relay.example.com`.
- **Port 443 open** to the internet. That is the only port the phone uses.
- Debian 12 or Ubuntu 22.04/24.04 for `install.sh`. Any Linux works if you write
  the unit file yourself.

---

## Step 1 — point a name at the server

Create one DNS record:

```
A    relay.example.com    <the server's public IPv4>
```

Wait until `dig +short relay.example.com` answers with that address. Everything
below fails in confusing ways if this is not done first.

---

## Step 2 — get the two pieces onto the server

**The binary.** Take the Linux release archive for the server's architecture
(`linux-x64.tar.gz` or `linux-arm64.tar.gz`) from the Origami Coder release
page. It holds the `origami` binary, which is the relay as well as the engine.

**The phone shell.** The relay serves the page the phone opens. Those files are
`out/remote/` inside the installed Origami Coder extension — `index.html`,
`remote.js`, `remote.css`, `chat.js`, an icon and a webmanifest. Copy that whole
folder from a machine that has the extension installed.

> The shell and the sockets MUST be served from the same host name. The page
> reads its relay address from `location.origin`. If you serve the page from one
> host and the sockets from another, pairing fails with no error message.

Put the shell folder on the server, for example at `/root/remote`.

---

## Step 3 — install

```bash
sudo ORIGAMI_RELEASE_URL="https://.../linux-x64.tar.gz" \
     ORIGAMI_RELEASE_SHA256="<the value from SHA256SUMS.txt>" \
     APP_SRC=/root/remote \
     ./install.sh
```

`ORIGAMI_RELEASE_SHA256` is required. The release page carries a
`SHA256SUMS.txt` with one line per asset; paste the value for the archive you
named — the whole line works, and case and spacing do not matter. The script
checks it before it unpacks anything and stops on a mismatch.

To install without checking, set `ORIGAMI_ALLOW_UNVERIFIED=1` and leave the
checksum empty. It is deliberately a second variable: an unset checksum is
almost always a wrapper script that did not expand, not a decision, and that
failure is invisible in a log.

Note what this does and does not do. It catches a corrupted or swapped
download. It cannot catch a bad release published from a compromised
account, because the same account writes `SHA256SUMS.txt`. Pin a tag
(`download/<tag>`, not `latest/download`) so a later release cannot change
under you.

The script:

1. creates a system user `origami` that cannot log in,
2. unpacks the binary to `/opt/origami/bin/origami`,
3. copies the phone shell to `/opt/origami/remote-app`,
4. writes `origami-relay.service` to systemd, enables it and starts it.

It is safe to run again. That is how you upgrade.

Check it:

```bash
curl -fsS http://127.0.0.1:8787/healthz     # prints: ok
systemctl status origami-relay
```

Variables you can set in front of the command: `RELAY_USER`, `PREFIX`, `PORT`,
`BIND`, `DAILY_BUDGET_MB`, `BULK_RID_MB_PER_MINUTE`, `ORIGAMI_RELEASE_SHA256`,
`ORIGAMI_ALLOW_UNVERIFIED`.

---

## Step 4 — TLS

A phone browser refuses WebCrypto on plain `http`, so the relay must be reached
over `https` and `wss`. Choose ONE of the two ways.

### The easy way: Caddy in front (recommended)

Caddy gets and renews the certificate on its own.

```bash
sudo apt install -y caddy
sudo cp Caddyfile /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile      # replace relay.example.com with your host
sudo systemctl reload caddy
```

The relay stays on loopback. Caddy holds port 443. WebSockets need no extra
directive — `reverse_proxy` upgrades them — but the read and write timeouts are
set to 0 in the supplied file, because a paired phone holds one socket open for
hours.

### The direct way: the relay holds the certificate

Use this only if you do not want a second program on the box.

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d relay.example.com
```

Then edit `/etc/systemd/system/origami-relay.service` so that `ExecStart` reads:

```
ExecStart=/opt/origami/bin/origami relay --hostname 0.0.0.0 --port 443 --tls-cert /etc/letsencrypt/live/relay.example.com/fullchain.pem --tls-key /etc/letsencrypt/live/relay.example.com/privkey.pem --app-dir /opt/origami/remote-app --daily-budget-mb 2048
```

and add this line under `[Service]`, because a non-root process cannot bind 443:

```
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

Both PEM files must be readable by the `origami` user, and you own the renewal:
add `systemctl restart origami-relay` to certbot's deploy hook, because the
relay reads the certificate once at start.

Then, either way:

```bash
./healthcheck.sh relay.example.com
```

---

## Step 5 — point the extension at it

In VS Code, open the Origami dashboard, choose the **REM** pane, and set the
relay field to:

```
wss://relay.example.com
```

Turn Remote on, press **Show code**, and scan it with the phone. The phone opens
`https://relay.example.com/app/`.

---

## The caps

These are fixed in the relay. They are not settings, because a relay that can be
told to carry more is a relay that can be told to carry everything.

| Cap | Value | What happens |
|---|---|---|
| Frame size | 65,536 bytes | that socket is closed with code 4002 |
| Traffic per pairing | 2 MiB per rolling minute | that socket is closed with code 4003 |
| Replay ring | 256 frames or the ring window (see below), whichever comes first | older frames are dropped |
| Sockets per pairing | one desktop, one phone | a second socket for the same role replaces the first with code 4001 |

Two settings are yours.

`--daily-budget-mb`: past it, **new** pairings are refused with HTTP 503 and
pairings already connected keep working. It is the stop on a runaway bill, not
a quality-of-service control. 2048 MiB per day is a generous default for one
person.

`--ring-seconds` (default 90): how long the replay ring keeps a role's frames,
for a phone that reconnects with `?after=` after losing signal. Short on
purpose — a socket that connects with a low `after` can read at most the last
window of the other role's traffic, never everything since the pairing began.
`0` keeps no ring at all.

---

## The bulk lane

`?lane=bulk` on the `/r/<rid>` URL puts a socket in its own namespace, separate
from the live lane even for the same rid string. It exists for a one-shot pull
— a device catching up on a compacted session journal — not for an
interactive pairing.

- No replay ring. `?after=` is accepted on the URL (it is a shared query
  param) but ignored; resume is up to whatever is sending the bytes, not the
  relay.
- `--bulk-rid-mb-per-minute` (default 20): its own per-rid token bucket,
  separate from the live lane's fixed 2 MiB/minute. Frames are still capped
  at 65,536 bytes and still counted against `--daily-budget-mb`.
- **Priority**: cloud sessions over remote control. Once the day is 90% spent,
  a NEW live rid is refused with 503 first; a NEW bulk rid is still accepted
  until the day is fully spent (100%).
- `/metrics` reports `bulk_frames`, `bulk_bytes` and `bulk_rids_open`
  alongside the existing counters.

---

## What the operator (you) can see

Run `journalctl -u origami-relay` and you get a start line. The relay never
writes a pairing id to a log and never writes a file. The supplied `Caddyfile`
also discards access logs, because a request log would record pairing ids that
the relay itself refuses to record.

If you change that, be honest with anyone else who pairs to your relay.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| The phone shows a blank page | `--app-dir` has no `index.html`. Copy `out/remote/` there. |
| The code scans, then nothing happens | The shell and the sockets are on different host names. Serve both from one. |
| The phone connects, then drops after a minute | A proxy timeout. Set `read_timeout 0` and `write_timeout 0`. |
| `curl` says 503 | The daily budget is used up. Raise `--daily-budget-mb` or wait for the next UTC day. |
| Pairing works at home and not on mobile data | Port 443 is not open, or DNS has not propagated. |

---

## Files in this kit

| File | What it is |
|---|---|
| `install.sh` | Debian and Ubuntu installer. Idempotent. Run it again to upgrade. |
| `origami-relay.service` | The systemd unit, with the defaults written out. |
| `Caddyfile` | TLS terminator with the WebSocket timeouts already correct. |
| `healthcheck.sh` | `curl` on `/healthz`, for cron or an uptime checker. |
