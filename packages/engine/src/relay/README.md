# Deploying the Origami Remote relay

The relay is a blind rendezvous: it pairs a desktop and a phone by `rid`, forwards
opaque binary frames, keeps a short replay ring, and serves the phone shell's
static files. It never sees plaintext and never persists anything. `Bun.serve`
only — no packages, no reverse proxy, no database, nothing else to install.

```
origami relay \
  --port 443 \
  --tls-cert /etc/origami/fullchain.pem \
  --tls-key  /etc/origami/privkey.pem \
  --app-dir  /srv/origami/remote \
  --daily-budget-mb 500
```

1. **Build the shell.** `cd packages/vscode && npm run build` writes it to
   `packages/vscode/out/remote/` (index.html, remote.js, remote.css, chat.js,
   the icon and the webmanifest). Those files also ship inside the VSIX, so a
   release can copy them straight out of the installed extension.
2. **Copy that directory to `--app-dir`.** The shell must come from the SAME
   origin as the sockets: it derives its relay URL from `location.origin`, so
   serving `/app` from a different host breaks pairing with no error message.
   Deploy the shell and the relay together, from one release.
3. **Point TLS at a real certificate.** The QR encodes an `https://` URL and
   phones refuse WebCrypto on plain http, so `--tls-cert` and `--tls-key` are
   required for anything but a loopback test. Both must be readable by the
   relay's user.
4. **Set `--daily-budget-mb`.** Past it, NEW rendezvous ids get HTTP 503 while
   existing pairings keep working. Unset means unlimited.

Check it with `curl https://<host>/healthz` — the body is `ok`.

For a server someone ELSE will run, `selfhost/` holds the ten-minute version of
this: an installer, a systemd unit, a Caddyfile and a health check, written to be
published on their own as the `origami-relay` repository. Nothing in that folder
points back into this tree.

Caps are fixed, not configurable. A frame over 65,536 bytes closes that socket
with 4002; a rid over 2 MiB in a rolling minute gets 4003; a second socket for
the same rid and role evicts the first with 4001. The replay ring holds 256
frames or 10 minutes per rid, whichever comes first.

## Two features share this relay

The relay is blind: it sees a rendezvous id and opaque bytes. Two different
features send those bytes.

- **Origami Remote** pairs a desktop with the owner's own phone. The relay it
  uses is the VS Code setting `origamicoder.remote.relayUrl`.
- **Flock** carries a question between TWO PEOPLE'S Origamis. The relay it
  falls back to is `flock.relayUrl` in the GLOBAL `origami.json`, and a
  friend's invite can name a different one per friendship.

They are separate settings even when they name the same host, and neither
reads the other. Nothing about the relay changes for Flock: same frame layout,
same `?after=` resume, same caps. It fills the two role slots per rid by the
one rule both parties can apply offline — the party whose signing public key
sorts lexicographically smaller takes `desktop`, the other takes `phone`.
