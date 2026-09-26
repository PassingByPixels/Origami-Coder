> This is the Origami Remote wire specification. Source files cite sections of this file by name.

# Origami Remote — wire spec v1 (shared contract for the relay, extension and phone lanes)

Lead, 2026-09-02. Every lane implements against THIS text; a change here is a lead decision.

## Keys and ids

- `Ks`: 32 random bytes generated on the desktop per pairing (`crypto.getRandomValues`).
- `key = HKDF-SHA256(Ks, salt = empty, info = "origami-remote/v1/key", 32 bytes)` → AES-256-GCM.
- `rid = base64url(HKDF-SHA256(Ks, salt = empty, info = "origami-remote/v1/rid", 16 bytes))`.
  The relay learns `rid` only. Nothing derives back to `Ks`.
- ~~PIN (4–6 digits, desktop-chosen at pairing): desktop stores `PBKDF2-SHA256(pin, salt = rid, 100000 iters, 32 bytes)`; the phone sends the PIN in plaintext INSIDE a sealed frame when an approval requires it.~~ **REMOVED in v1.2.1, 2026-09-06** — see the addendum. There is no PIN. `Ks` is the whole of a pairing's secret material.

## Relay (engine verb `origami relay`)

- `origami relay --port <n> [--tls-cert <pem> --tls-key <pem>] [--app-dir <dir>] [--daily-budget-mb <n>] [--ring-seconds <n>]`.
  `Bun.serve` only; no packages.
- `GET /healthz` → `200 ok`. `GET /app/*` → static files from `--app-dir` (the phone shell), no auth.
- `WS /r/<rid>?role=desktop|phone`. Rules: at most one live socket per role per rid (a new one
  replaces the old and the old gets close code 4001). Frames are binary and opaque. The relay
  forwards each frame to the other role if connected, and appends it to a per-rid ring
  (max 256 frames or the ring window, default 90 s, whichever first — `--ring-seconds`, 0 keeps
  no ring at all). On connect, a role receives the ring's frames from the OTHER role whose `seq`
  is greater than the `?after=<seq>` query value (default 0). The window is short on purpose: a
  socket connecting late with a low `after` can read at most the last window of the other role's
  traffic, not everything since the pairing began (2026-09-06, ticket t-xyhymy).
- Caps: frame ≤ 65,536 bytes (close 4002); per-rid ≥ 2 MiB per rolling minute (close 4003);
  global `--daily-budget-mb` exceeded → new rids refused with HTTP 503, existing ones keep working.
- The relay never logs `rid`, never persists anything. It keeps in memory only: rid → sockets + ring.

### Presence (2026-09-05, ticket t-uttzsd, engine `202609051344`)

The relay sends a TEXT control frame to a role's socket when the OTHER role's socket opens or closes: `peer:present` (the other role has a live socket on this rid) and `peer:absent` (it has not).

- A socket is sent one the moment it opens, stating the other role's state at that instant; the other role's socket, if any, is sent `peer:present` at the same moment.
- When a socket closes and still held its role slot, the other role's socket is sent `peer:absent`. A socket REPLACED by a newer one for the same role (close 4001) announces nothing: the newcomer already holds the slot.
- The frame carries no rid, no seq and no payload. The token is the whole message. The relay stays blind.
- Control frames are never appended to the ring, never replayed, and are charged to neither the daily budget nor the per-rid rate limiter. They exist to shrink the traffic those cap.
- The rule that a CLIENT sending a TEXT frame is closed with 4004 is unchanged. Text is relay→client only, which is what makes it unambiguous.

Client obligations: the desktop pauses its fan-out on `peer:absent` and resumes it on `peer:present`, pushing a fresh hydration on the resume. UNKNOWN IS NOT ABSENT: a relay that sends no control frame must leave a client behaving exactly as before, so a desktop pauses only on an explicit `peer:absent`. A client that does not understand the frame must ignore it; the v1 phone page already does (a non-binary frame is rejected and the socket kept).

## Frame (binary)

```
byte 0      version = 1
byte 1      role: 1 = desktop, 2 = phone
bytes 2..5  seq, uint32 big-endian, per sender, starts at 1, strictly increasing
bytes 6..17 nonce, 12 random bytes
bytes 18..  AES-256-GCM ciphertext + 16-byte tag
```

- AAD = `rid` (utf-8 of the base64url string) || bytes 0..5 of the header.
- Plaintext = `uint32 BE length` || `utf-8 JSON` || zero padding to the next multiple of 1,024.
- A receiver rejects: unknown version, seq ≤ last seen seq from that role (replay), GCM failure.

## Messages (JSON inside the plaintext)

- Both sides first send `{ "type": "remote/hello", "v": 1, "device": "<name>" }`.
- `remote/hello` may carry `reset: true`, desktop → phone only (2026-09-05, t-utufjk). It means the desktop rejected the phone's hello as a replay on a fresh socket (the phone's seq marks are gone) and the pairing cannot recover without a new QR. A phone that does not know the field ignores it. The replay guard is unchanged: the rejected hello stays rejected.
- Phone → desktop: `{ "type": "remote/snapshot" }` asks the desktop to replay the same hydration
  it sends a freshly attached webview (the `attachView` path in `DashboardPanel`).
- Everything else is the existing webview protocol verbatim: desktop → phone carries exactly what
  `DashboardPanel.post()` sends to a view; phone → desktop carries exactly what
  `handleWebviewMessage()` accepts. The phone shell is the real `out/webview/chat.js` with
  `acquireVsCodeApi()` replaced by a shim whose `postMessage` seals and sends, and whose
  `onmessage` opens and dispatches.
- ~~Approvals: when the desktop's policy is `pin-on-shell` … `remote/pin-required` … `remote/pin`
  … Wrong PIN three times → the desktop revokes the pairing. Policy `yolo` → no PIN ever.~~
  **REMOVED in v1.2.1, 2026-09-06.** `remote/pin-required` and `remote/pin` are no longer sent or
  accepted by either side. An approval is signed (addendum v1.2) or it is not honoured; a page
  that has enrolled no device key may only WATCH.

## Pairing QR

`<relayHttpsUrl>/app/#v1.<rid>.<base64url(Ks)>[.<base64url(lanUrl)>]` — the secret rides in the
fragment only. The desktop shows the QR for 60 s and invalidates the pairing if no `remote/hello`
arrives from the phone in that time. The phone stores `Ks` in `localStorage` keyed by rid and
rewrites the URL to drop the fragment.

## Settings (extension)

- `origamicoder.remote.relayUrl` (string; default `wss://relay.origamilabs.nl`).
- ~~`origamicoder.remote.approvals`: `"pin-on-shell"` (default) | `"yolo"`.~~ **REMOVED in v1.2.1.**
- `origamicoder.remote.enabled` (boolean, default false). Off = no socket is ever opened.

## Modes

v1 ships relay mode only. LAN mode (extension serves `/app` itself with a pinned self-signed
cert) and tailnet mode are v2; the QR format already reserves the optional LAN URL.

## Clarifications (2026-09-02, after the phone lane)

- **Chunking** lives inside the sealed plaintext: a message whose JSON exceeds 32,512 bytes is sent as N envelopes `{ "type": "remote/chunk", "id": string, "i": n, "n": N, "part": string }` where `part` is a UTF-8-safe slice of the JSON text and the parts concatenate back in `i` order. Smaller messages are sent unwrapped. A receiver ignores an `i` outside `[0, n)`.
- ~~**PIN refusal**: on a wrong PIN the desktop re-sends `remote/pin-required` … After the third wrong PIN it sends `{ "type": "remote/revoked" }`, rotates Ks/rid and closes the socket.~~ **REMOVED in v1.2.1.** `remote/revoked` itself stays: it is still sent, before the socket closes, when a code is scanned after its sixty seconds are up and when the owner revokes.

## Addendum v1.1 — device identity (2026-09-06, the iOS app lane)

Added by `lane/remote-device-key`. The wording of the two frames and of the signed bytes is
copied verbatim from the iOS app's native bridge specification, sections 5.1-5.2, so the
two documents cannot drift. OPTIONAL on the wire: a desktop that sends no challenge is the desktop
that shipped before this, and a page that sends no `deviceKey` is a browser — both keep working.

### Why

`Ks` is the whole pairing. Anyone who photographs the QR, or reads it out of a screenshot, derives
the same `rid` and the same frame key and is indistinguishable from the owner's phone. The Origami
Remote iOS shell mints a P-256 key in the Secure Enclave at scan time and cannot export it, so a
copied `Ks` alone no longer opens the session: the copy cannot answer a challenge.

### Phone → desktop, `remote/hello` (new optional fields)

The phone's `remote/hello` gains optional `platform`, `app`, `deviceKey: { alg: 'ES256', pub, fp,
backend }`. `pub` = base64url of the 65-byte X9.63 uncompressed point; `fp` = base64url
SHA-256(pub); `backend` ∈ `secure-enclave | software`. A browser page sends none of them.

```json
{ "type": "remote/hello", "v": 1, "device": "Sam's iPhone",
  "platform": "ios", "app": "1.0 (1)",
  "deviceKey": { "alg": "ES256", "pub": "<b64url>", "fp": "<b64url>", "backend": "secure-enclave" } }
```

### Desktop → phone, `remote/challenge`

Sent immediately after the desktop's own hello, on every socket open:

```json
{ "type": "remote/challenge", "v": 1, "challenge": "<b64url of 32 random bytes>" }
```

### Phone → desktop, `remote/challenge-response`

```json
{ "type": "remote/challenge-response", "v": 1, "sig": "<b64url r||s>", "pub": "<b64url>", "fp": "<b64url>" }
```

Signed bytes = `utf8("origami-remote/v1/device-auth") || challenge(32 bytes) || utf8(rid)`.
The domain prefix is deliberate: this key must never produce a signature that could be
reinterpreted as anything else.

`sig` = base64url of the 64-byte raw `r||s` (IEEE P1363), ECDSA P-256 / SHA-256. WebCrypto
verifies it directly: `importKey('raw', pubBytes, { name: 'ECDSA', namedCurve: 'P-256' })`,
`verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, payload)`. No DER anywhere.

### Phone behaviour

Answer a challenge whenever one arrives (no biometric; this is session binding). Never WAIT for
one: a desktop that sends none is today's desktop, and the phone must work against it unchanged.

### Desktop behaviour

- **Enrol on the confirming hello.** The `deviceKey` on the hello that confirms a pairing inside
  the 60 s window is stored beside `Ks` in the OS keychain (`pub`, `fp`, `device`, `platform`,
  `app`, `backend`). That is the enrolled device. Revoking the pairing clears it, and so does
  minting a new code. A confirming hello with no `deviceKey` enrols nothing — that is a browser.
  A LATER hello never enrols: a thief holding a copied `Ks` must not be able to enrol his own key
  on a pairing the owner made from a browser page.
- **First enrolment wins.** A hello carrying a DIFFERENT `pub` is dropped and its fingerprint is
  named to the owner. The enrolled key is kept and the pairing is NOT revoked — an attacker who
  could revoke the owner's phone by connecting once would have a denial of service for free.
- **A challenge per socket, retried on `peer:present`.** GENERATED and DELIVERED are tracked
  separately: the relay drops a frame sent while it says `peer:absent`, so the first challenge can
  vanish and the retry must re-send the SAME bytes. A new socket is a new challenge.
- **Nothing before verification.** With a device enrolled, the desktop neither hydrates nor
  dispatches until a response verifies. The phone's `remote/snapshot` rides the same socket open as
  its hello, before it can have seen the challenge, so that one is HELD and the hydration is
  replayed on the verdict; everything else is dropped with a line on the pane. Verification is per
  SOCKET and is never persisted: a reconnect starts unverified.
- **A page with no device key** is governed by `origamicoder.remote.requireDeviceKey` (boolean,
  default false while the app is unreleased and the relay-served page is the only phone). With it
  true, a phone whose confirming hello carried no `deviceKey` gets hello and the challenge and
  nothing else. With a device ENROLLED the challenge is required whatever the setting says.
- **The seq trap.** An impersonator that connects FIRST advances the desktop's inbound replay mark,
  so the real phone's seq-1 hello is then rejected as a replay and it can never enrol. The mark
  cannot be rewound without re-opening the replay hole, so the only clean recovery is a new QR, and
  the pane says exactly that when a hello is refused on an unconfirmed pairing.
- **The pane shows the enrolled device**: name, platform, app version, a backend badge and the FULL
  43-character fingerprint with a copy button, so the owner can compare it with the app's Settings
  screen. The public key itself never leaves the extension host.

### Settings (extension), added

- `origamicoder.remote.requireDeviceKey` (boolean, default false).

### Relay

No change. The challenge and its answer ride inside sealed frames; the relay stays blind and its
caps are untouched. Enrolment is desktop state above the transport.

---

## v1.2 — privilege (2026-09-06)

The phone drives the desktop's REAL privilege system, Ask and YOLO, and every grant of
authority from the phone is bound to the enrolled Secure Enclave key. Nothing a relay can
replay, and nothing a copied `Ks` can mint, escalates the desktop.

Companion: the iOS app's privilege specification.
Threat model, set by the owner: defend IMPERSONATION. A phone stolen while unlocked with
the app open is out of scope. One identity confirmation per escalation, no timers, no
auto-revert.

### The bytes that are signed

Three domains, one shape: `utf8(domain) || nonce bytes || utf8(field) ...`. The nonce is
the RAW decoded bytes, never its base64url text. `sig` is base64url of the 64-byte raw
`r||s` (IEEE P1363), ECDSA P-256 / SHA-256, no DER. `pub` is base64url of the 65-byte
X9.63 uncompressed point. A key must never make a signature that can be reinterpreted as a
different kind of statement, which is what the domain prefix is for.

| Grant | Signed bytes |
|---|---|
| session binding (v1.1) | `utf8("origami-remote/v1/device-auth") \|\| challenge(32) \|\| utf8(rid)` |
| approval | `utf8("origami-remote/v1/approve") \|\| approvalNonce \|\| utf8(toolCallId) \|\| utf8(optionId)` |
| set-mode | `utf8("origami-remote/v1/set-mode") \|\| nonce(32) \|\| utf8(sessionId) \|\| utf8("yolo")` |

The desktop verifies against the key it ENROLLED, never against the `pub` in the same
message: otherwise an attacker signs his own bytes with his own key and every check passes.

### Ask — the signed approval

Desktop -> phone, `requestPermission` gains one field:

```json
{ "type": "requestPermission", "toolCallId": "tc-1", "approvalNonce": "<b64url, 16+ bytes>", ... }
```

Phone -> desktop, when APPROVING:

```json
{ "type": "permission", "toolCallId": "tc-1", "optionId": "allow_once",
  "sig": "<b64url r||s>", "pub": "<b64url>", "fp": "<b64url>" }
```

- The nonce is minted ONCE per `toolCallId` and re-used if the ask is re-sent, because a
  hydration replays asks the phone is already holding and a fresh nonce would make the copy
  on its screen unanswerable.
- The nonce is SINGLE USE. It is spent on a good signature and on a bad one alike: an
  attacker must not get unlimited attempts at one ask.
- A DENY (`optionId` null or absent) carries no signature and is ALWAYS honoured. Dropping
  or refusing authority is free at every capability envelope.
- A wrong, missing or foreign-key signature drops the approval and the pane says which.

### YOLO — the signed set-mode

One round trip, replay-proof:

1. Phone -> desktop: `{ "type": "remote/set-mode-request", "v": 1, "mode": "yolo", "sessionId": "..." }`
2. Desktop -> phone: `{ "type": "remote/mode-challenge", "v": 1, "nonce": "<b64url 32 bytes>", "sessionId": "..." }`
3. Phone -> desktop (behind Face ID): `{ "type": "remote/set-mode", "v": 1, "mode": "yolo", "sessionId": "...", "sig": "...", "pub": "...", "fp": "..." }`

The nonce is remembered per `sessionId`, is minted per REQUEST, and is spent whatever the
verdict is. On a good signature the desktop puts that session into bypass through the same
host message the composer's own Actions row posts (`setApproveMode`, mode `bypass`), so the
phone drives the engine's real session permission ruleset and not a parallel idea of it. The
desktop records who set it: device name, fingerprint, time.

Reverting: `{ "type": "remote/set-mode", "v": 1, "mode": "ask", "sessionId": "..." }`, no
signature, no challenge, no complaint if the session was never in YOLO.

### What ends YOLO

On facts, never on a clock. An expiry would only train people to re-confirm without reading.

- the session ends (the host broadcasts `sessionClosed` — the record is forgotten, and
  nothing is written to a ruleset that died with the session);
- the phone reverts it;
- the pairing's transport stops for GOOD — which is also what revoking and re-pairing do.
  Every escalated session is put back to Ask through the host before the view is disposed.
- a RECONNECT is NOT one of them: a socket dropping for a moment is not the owner changing
  his mind, and reverting there would undo a decision mid-turn.

Nothing is persisted. A window that restarts comes back in Ask.

### R-1 — the default-deny allowlist

The phone may send ONLY these, and everything else is dropped with one status line naming
the TYPE (never the payload, which would put a prompt on a pane and in the output channel):

`remote/hello`, `remote/challenge-response`, `remote/snapshot`,
`remote/set-mode-request`, `remote/set-mode`, `send`, `sendWithImages`, `permission`,
`cancel`, `newSession`, `closeSession`, `soloSession`, and any `request*` read.

`request*` is a prefix rule and is the one bet: every `request...` the dashboard host
answers re-broadcasts state the phone is already entitled to. A `request...` that WRITES
must be named explicitly with a higher need.

Refused by name, and asserted as refused in a test: `setApproveMode`, `setMode`,
`setBrowserAutoApprove`, `setEngineUrl`, `remoteSetRelayUrl`, `remoteSetEnabled`,
`remotePair`, `remoteRevoke`, `remoteTakeOver`, `createCron`, `updateCron`, `runCronNow`,
`setupProvider`, `createInstructionFile`, `openAbsoluteFile`, `openWorkspaceFile`.

`/auto`, `/bypass` and `/plan` are not intercepted anywhere in the extension's webview or in
the engine's command list: what they and the ChatPane YOLO button post is `setApproveMode`
(and `setMode` for `/plan`), so refusing those two is what makes them inert from a phone.

### R-2a — the capability envelope

`origamicoder.remote.capability`, one of `watch` / `ask` / `full`, default **`full`** — the
owner's stated intent is that the phone MAY ask for YOLO, behind Face ID and a signature.
The envelope is the LEAST capability that admits a verb, so it reads as one column:

| Envelope | What the phone may do |
|---|---|
| `watch` | reads, `cancel`, a permission DENY, and reverting YOLO to Ask |
| `ask` | the above plus `send` / `sendWithImages`, opening and closing chats, and a signed APPROVAL |
| `full` | the above plus asking for YOLO |

The same type can sit at two levels: `permission` is `watch` when it denies and `ask` when
it approves; `remote/set-mode` is `watch` when it reverts and `full` when it escalates. The
rule is about what the message DOES.

### ~~PIN — fallback only~~ SUPERSEDED by v1.2.1

The paragraph that stood here kept the PIN alive for a relay-served browser page. It is gone;
see the addendum below.

### Re-verification on a new peer

The relay's control frame says a socket ATTACHED on the phone's side and never says WHOSE,
and its one-socket rule means a second client evicts the first and produces a `peer:present`
with no `peer:absent` in front of it. The desktop now distinguishes two edges:

- `arrived` (present after absent or unknown): today's behaviour, greet and hydrate.
- `replaced` (present while already present): if a verdict had been earned on this socket it
  is DISCARDED, a FRESH challenge is minted, and the pane says "the phone's socket was
  replaced; waiting for it to prove its key". Nothing is served until the new peer verifies.

The challenge is re-minted rather than re-offered, because a replacement holding a copied
`Ks` could have read the old challenge AND its answer off the relay's replay ring
(ticket t-xyhymy). An UNVERIFIED socket keeps its challenge: nothing answered it, so nothing
is on the ring, and a fresh one would race the answer to the first.

A `replaced` edge that discarded no verdict is NOT acted on — the frame may be a duplicate
for the same phone, and re-greeting and re-hydrating on each would push a whole transcript up
the relay for nothing.

### Settings (extension), added

- `origamicoder.remote.capability` (string, enum `watch` / `ask` / `full`, default `full`).

### Relay

No change. Every new frame rides inside the sealed envelope; the relay stays blind and its
caps are untouched. **Ring replay (t-xyhymy) is still open and is independent of this**: signed
escalation binds FUTURE authority and does nothing for the confidentiality of frames already
on the relay's ten-minute ring. The session-key-after-verification or shorter-ring decision
still gates shipping the feature to anyone but the owner.

## Addendum v1.2.1 — the PIN is removed; a keyless page is watch-only (2026-09-06)

Owner's decision, implemented by `lane/remote-nopin`. It removes a mechanism and adds none.

### What is removed

| Removed | Where it was |
|---|---|
| The pairing PIN, its PBKDF2 hash and the keychain entry holding it | "Keys and ids"; `SECRET_PIN` in `src/remote/pairing.ts` |
| `remote/pin-required` (desktop → phone) and `remote/pin` (phone → desktop) | "Messages"; the R-1 allowlist |
| The three-wrong-PINs revoke, with its `attempt` / `remaining` fields | "PIN refusal" |
| `origamicoder.remote.approvals` (`pin-on-shell` \| `yolo`) | "Settings (extension)" |
| `origamicoder.remote.requireDeviceKey` | added by v1.1; never in this document's settings list |

The PIN is obsolete because the app proves the pairing with its Secure Enclave key on EVERY
connection and signs EVERY approval with it (addendum v1.2). Four digits typed into a phone add
nothing to a signature over bytes the desktop chose, and asking for one at pairing implies a
threat model that no longer applies. A pairing made by an older build still works: the stored PIN
hash is deleted the first time the pairing is loaded, and never read.

### The rule that replaced it

> **Keyless = watch. Keyed = signed.**

- A pairing that has enrolled NO device key is clamped to the `watch` envelope (R-2a), whatever
  the desk's `origamicoder.remote.capability` says. That is the relay-served browser page: it
  gets `remote/hello`, the challenge, and a full hydration, and it may read, `cancel`, `stop`,
  ask for a `remote/snapshot`, DENY a permission and revert YOLO to Ask. `send`,
  `sendWithImages`, an APPROVE and `remote/set-mode-request` are dropped with a status line.
- Enrolment, not this socket's verdict, is the test. A client that answers the challenge with a
  key it minted itself is `verified` — nothing was enrolled for it to fail against — so a clamp
  that keyed on the verdict would hand that client the whole envelope.
- A pairing that HAS enrolled a key behaves exactly as v1.2 describes: nothing is served until
  the challenge is answered, and an approve must carry a valid signature over the ask's nonce.
- The phone page shows one line the first time the reader tries something a keyless page cannot
  get acted on: *"This page can watch. Use the app to send or approve."* The message is still
  SENT — the desktop remains the one authority on what it acts on.

### Pairing

`begin()` takes no PIN. The owner presses "Pair another phone" / "Show a new code" and the QR
appears; there is no field in front of it. Everything else about pairing — the QR format, the
60-second window, `remote/hello` confirming it, `remote/revoked` before the socket closes on a
late scan — is unchanged.

### Settings (extension), after v1.2.1

The complete list is now three: `origamicoder.remote.enabled`, `.relayUrl`, `.capability`.

### Relay

No change.

## v1.3 — a session key a copied secret cannot derive (2026-09-07)

Owner's decision, from the v1.3 session-key design. It closes what the
90-second ring only shortened: `Ks` is copyable, so anyone holding it can open every frame the
relay replays. After the phone proves its enrolled Secure Enclave key, both ends derive a SECOND
key from an ECDH the copy cannot compute, and seal everything after that with it. The relay does
not change; nothing here is visible to it.

### The challenge, version 2

Desktop → phone, on every socket open, replacing the v1.1 challenge:

```json
{ "type": "remote/challenge", "v": 2,
  "challenge": "<b64url of 32 random bytes>",
  "ephPub": "<b64url 65-byte X9.63 uncompressed P-256 point>" }
```

The desktop mints a fresh ephemeral P-256 key pair per socket and discards it when the socket
closes or is replaced. Nothing else about the challenge changes: it is still generated once per
socket and re-sent verbatim on a `peer:present` retry.

### The signed bytes

`utf8("origami-remote/v2/device-auth") || challenge(32) || utf8(rid) || ephPub(65)`

The shape is decided by the PRESENCE of `ephPub` in the challenge, so both ends agree without a
capability flag. The answer frame is unchanged (`remote/challenge-response` with `sig`, `pub`,
`fp`) and is the LAST v1 frame the phone sends.

`ephPub` is inside the signature because without it a thief holding `Ks` can open the challenge,
swap in his own ephemeral key, forward it, and end up sharing a key with the phone. Signing the
transcript makes the substitution fail verification at the desktop.

**The desktop verifies against the key it ENROLLED, never the `pub` in the same message** — the
v1.2 rule, unchanged. If the v2 bytes fail it verifies the v1 bytes; if THOSE pass the phone is an
old build, the socket is marked v1-only and never sees a version 2 frame. If both fail the response
is refused exactly as before.

### The derivation

```
Z   = ECDH(ephPriv, devicePub)            // desktop, WebCrypto deriveBits, 256 bits
    = ECDH(devicePriv, ephPub)            // phone, in the Enclave
K'  = HKDF-SHA256( IKM  = Z || Ks,
                   salt = challenge,      // the 32 bytes from the challenge
                   info = "origami-remote/v2/session-key",
                   len  = 32 )            // AES-256-GCM
```

`Ks` stays in the IKM, so `K'` is also useless to someone who obtained `Z` without `Ks`. The
challenge is the salt, so `K'` is bound to ONE socket: a reconnect derives a different key and the
ring's older frames stay shut. `K` (from `Ks`) stays alive for the handshake frames only.

### The frame

Header byte 0 is the version: **`2`** for a frame sealed with `K'`. The role, the seq, the nonce,
the AAD (`rid || header[0..5]`) and the 12-byte nonce rule are all unchanged, and the AAD already
covers byte 0, so a v2 frame cannot be downgraded to v1 by flipping the byte — the tag fails.

- **Seq counters are NOT reset at the switch.** The replay guard is one rule across both versions.
- **Switch point.** The desktop seals with `K'` from the first frame AFTER it verified the
  response; the phone from the first frame after it SENT the response.
- **Receiver rule.** Open a frame with the key its version byte names. A version 2 frame that
  arrives before the receiver holds `K'` is rejected. Once a version 2 frame from a role has been
  ACCEPTED, a version 1 frame from that role is rejected for the rest of the socket; a v1 still in
  flight before the first v2 is tolerated, because that is the switch and not an attack. Every one
  of these rejections is non-fatal and is counted exactly like a replay.
- **Reconnect.** New socket, new challenge, new `ephPub`, new `K'`. Both ends drop the old key when
  the socket goes, so a ring-replayed v2 frame from the previous socket is unopenable and is
  dropped as a reject. Re-hydration on `peer:present` is unchanged.
- **Handshake frames stay v1**: `remote/hello`, `remote/challenge`, `remote/challenge-response`,
  and the relay's presence control frames, which were never sealed at all. None of them carries
  chat, which is what shrinks the exposure to the handshake.
- Chunking is unaffected: chunk envelopes are inside the plaintext.

### Pad buckets, version 2 only

A v1 frame keeps the flat 1,024-byte pad. A v2 frame pads its plaintext
(`uint32 BE length || JSON || zero pad`) to the smallest of **256, 512, 1024, 2048, 4096** that
fits, and above 4,096 to the next multiple of 4,096. The frame cap stays 65,536, so the largest v2
plaintext is 15 x 4,096 = **61,440** and the largest v2 JSON is 61,436. The chunk threshold
(32,512 bytes of JSON) is unchanged and lands in the 36,864 bucket.

A receiver checks, BEFORE reading the JSON of a v2 frame:

1. the plaintext length is exactly one of the five buckets, or a multiple of 4,096 above 4,096;
2. the declared length is at most the plaintext length minus 4;
3. every pad byte is zero.

Any of the three failing is a non-fatal reject. The smallest v2 frame on the wire is
256 + 18 + 16 = **290 bytes**, against 1,058 for the same message under v1.

### Compatibility

| Pairing | What happens |
|---|---|
| Desktop 1.3 + phone 1.3 | v2 after verification. The only pairing that closes the hole. |
| Desktop 1.3 + older app | The app signs the v1 shape; the desktop detects it, stays on v1 frames for that socket, and the pane reads `Session key: off (old app)`. Content stays `Ks`-sealed — today's exposure. |
| Desktop 1.3 + browser page | No device key, so nothing to bind to and no `K'`. Watch-tier, as v1.2.1 already says. The pane reads `off (no device key)`. |
| Older desktop + phone 1.3 | The challenge has no `ephPub`, so the phone signs the v1 shape and everything is as before. |

### Pane

The Your phone card carries one line: `Session key: on` while this socket is sealing with `K'`,
`off (old app)`, `off (no device key)`, or a plain `off` for an enrolled phone that has not yet
proved its key on THIS socket. It is per socket, not per pairing.

### Relay

No change. The challenge, its answer and every v2 frame ride inside the same opaque envelope; the
ring, the caps and the 65,536-byte frame limit are untouched.

## v1.4 — Hydration order (2026-09-15, ticket t-3j5281)

A hydration is the desk telling a freshly-attached or freshly-reconnected
phone what a live view already has: the session replay burst
(`restoreMessages` and friends, one per open chat) and a `remote/mode-state`
report (the escalated-session modes the desk's own records hold — see
`modeReport.ts`).

**Order: the desk queues `remote/mode-state` LAST, right behind the replay
burst, on every hydration.** The queue order is fixed in code
(`RemoteController.hydrate()`: `attach()` the burst, then
`Privilege.sendModeState()`), both funnelled through the same per-socket
`OutboundPipe`, which serializes sends in call order regardless of how long
each frame's seal takes (`pipes.ts`). A phone that wants "the modes as of
after this hydration's burst" reads the report after the last replay message.

**This order is NOT a wire guarantee across a socket reconnect.** On a
reconnect, `remote/hello`, the device-key challenge, and the mode-state
report are three separately-queued sends (`socketGreeting.ts: announce()`),
each sealed on its own schedule (device-key challenge mints a fresh ECDH
keypair before it can seal — see `remoteController.test.ts`, t-2ek0o9). A
message an application path sends independently, moments after the socket
reports itself open, is not guaranteed to arrive after that burst has
finished — `connected` (`transport.status === 'open'`) means the socket
opened, not that the burst landed. A caller — desk-side code, or a test —
that needs "after this hydration" must wait for the actual last burst frame
(the mode-state report) to arrive, not merely for the socket to reconnect.

Consequence for callers: **the trailing frames of a reconnect are a SET, not
a strict last-message guarantee**, unless the caller has waited for the
mode-state report to land first. `remoteRelayLive.test.ts` ("the desktop's
socket drops and comes back") does this: it waits for the reconnect's own
mode-state report before racing a fresh `agentDelta`, then asserts the
delta is present in the trailing set rather than asserting it is the sole
last message — the mode-state report itself is still a legitimate trailing
frame under real relay timing (t-3j5281).

## Desk groups (Nests) — the join handshake v2 (2026-09-23, ticket t-sj32zl)

The desk group rides the same relay and frame as the phone lane (two roles per
rid, sealed frames). Each pair of desks uses a pairwise rid and key derived from
the group secret `Kg` and the two device ids (`src/remote/groupCrypto.ts`). That
part is unchanged. What changed is how a new desk gets `Kg`.

### v1 (0.4.165 and older) — withdrawn

The pasted key and QR were `origami-group-v1.<Kg>.<inviter id>`. The key CARRIED
`Kg`, so a leaked key (chat history, screenshot, clipboard manager) was valid for
the life of the group. The join rid derived from `Kg` + inviter id, so every
invite from one desk opened the SAME rendezvous. The inviter accepted any joiner
without a question. A v2 desk refuses a v1 key with the words "This key is from
an older Origami Code; make a new invite". Both desks must run v2.

### The key

`origami-group-v2.<base64url(secret)>.<inviter id>`

- `secret`: 16 random bytes, minted fresh for EACH invite, held in memory only
  (never in the keychain, never sent). It dies when the invite closes: on
  Accept, Decline, Cancel, the 10-minute window (`GROUP_INVITE_WINDOW_MS`) or a
  window reload. A second invite mints a new secret.
- Whitespace anywhere in a pasted key is ignored.

### Derivations (HKDF-SHA256, empty salt)

```
ikm   = secret || utf8(inviter id)
rid   = base64url(HKDF(ikm, "origami-group/v2/join-rid", 16))
key   = HKDF(ikm, "origami-group/v2/join-key", 32)                      -> AES-256-GCM
match = HKDF(ikm || utf8(joiner id) || joiner pub, "origami-group/v2/match", 4)
        as uint32 BE, mod 1 000 000, shown as "ddd ddd"
wrap  = HKDF(ECDH-P256(inviter eph, joiner eph) || secret, "origami-group/v2/welcome", 32)
```

Device ids are fixed length (11 characters), so each concatenation is unambiguous.

### Messages on the join rid (sealed under `key`, inviter = `desktop`, joiner = `phone`)

1. Joiner -> inviter: `{ "type": "group/join", "from": <joiner id>, "name": <desk name>, "pub": <base64url raw P-256 point, 65 bytes> }`.
   The joiner mints its device id and an ephemeral ECDH pair for this join. It
   stores NOTHING yet. Both desks now show the match code; the joiner shows its
   own desk name next to it, the inviter shows "<name> wants to join".
2. The inviter takes ONE request per invite. It sends nothing until its owner
   answers.
3. Accept — inviter -> joiner: `group/welcome` with the roster fields as before
   (`from`, `name`, `peers`, and the gossip record), plus
   `{ "pub": <inviter ephemeral point>, "box": base64url(nonce(12) || AES-256-GCM(wrap, nonce, aad = utf8(joiner id), Kg)) }`.
   `Kg` never appears in the clear, even inside the sealed frame. The inviter
   then closes the join rid and opens the pairwise link.
4. Decline — inviter -> joiner: `{ "type": "group/declined", "from": <inviter id> }`.
   No secret. The inviter closes the join rid.
5. The joiner accepts a welcome only from the inviter id in the key, and only if
   `box` opens under its own ephemeral key. Then it stores `Kg` and its id,
   rebuilds its roster from the welcome and opens a pairwise link to each desk.

### Why the welcome is sealed to the joiner's ephemeral key

The join key derives from the pasted secret, and the threat is a leaked key.
The relay keeps a replay ring (90 s by default) and gives it to the next socket in a
role. A holder of the leaked key that takes the phone slot after the owner saw
the right code, or an operator of the relay, can read the welcome frame. It
still cannot open `box`: that needs the private half of the joiner's ephemeral
key. The joiner's public key is inside the match code, so a relay that
substitutes it shows the owner two different codes.

### Unchanged

`restore()`, the pairwise rids and keys, `group/hello`, `group/roster` gossip,
and the revocation rule: forget the group on a desk that stays, start a new
group there and invite the kept desks again. The new `Kg` rotates every pairwise
rid, and a removed desk holds only the old one.
