# Decision: v1 stays the session engine; v2 is parked, not finished

**Date:** 2026-07-16 · **Status:** accepted — still in force while the parked
`SessionV2` code remains in the tree.

> Naming note: "v2" here means the event-sourced SESSION BACKEND (`SessionV2`,
> `SessionExecution`, EventV2). It is unrelated to the `v2-rebase` branch/worktree
> name, which is "version 2 of the fork" (the rebrand rebuilt on newer upstream).

## Decision

The v1 session backend (message/part tables, prompt loop, HTTP/SDK contract) remains the
engine of this fork. The half-built v2 event-sourced backend is **parked**: kept in the
tree, dark in production, not extended and not removed. The streaming/multi-provider
defects that motivated "finish v2" were fixed directly at the v1 seams instead.

## Why not finish v2

All independently verified at decision time:

- **The v1/v2 duality was not the cause of the observed failures.** The v2 mirror is dark
  in production: `experimentalEventSystem` defaults false and is only set in tests. Every
  observed failing stream ran v1 end-to-end.
- **v2 is ~40% complete and the missing 60% is the hard part.** Its own runner TODO defers
  retry bounds, doom-loop detection, durable status, and crash recovery — resilience v1
  has today. Revert/fork/share/title/manual-compact/wait/shell/skill/task have no v2 path
  (`OperationUnavailableError`). The entire HTTP/SDK/shell contract is v1-shaped. No
  v1→v2 backfill exists.
- **Upstream hasn't finished it either.** Their dev branch still reads MessageV2 in the
  prompt path; their v2 work is unmerged and restructured onto packages this fork does not
  have. Finishing v2 solo would make the fork permanently unmergeable at the session seam
  against a moving target.

## What was done instead (the seams work)

- Single agent/model write path: `Session.setAgentModel` (upstream pick `a1f093a74`,
  landed as `18fed83e1`); all flag-gated v2 mirror publishes deleted (−569 lines).
- Authoritative ACP mode sync from the projected session row (`bd89f1365`), legacy
  message-based sync retired (`59f6443a6`).
- Provider fetch hardening (`a39e1e995`): abandoned-response permit watchdog,
  release-on-abort, bounded permit acquire with a visible error, default chunk timeout
  for self-hosted baseURLs.
- Multi-instance reap age-floor (each shell chat runs its own engine process against the
  shared global SQLite; cross-instance heuristics must assume live siblings).

## Keep / kill verdicts

| Thing | Verdict | Why |
|---|---|---|
| v1 tables, loop, HTTP/SDK contract | **Keep** | The engine. |
| v2 runner + projector v1/v2 handlers | **Keep (parked, dark)** | Adoptable later; projector keeps `SessionTable` fresh. |
| Flag-gated v2 mirror publishes, hand-published `AgentSwitched`/`ModelSwitched`, ACP message-based mode sync | **Killed** | Superseded by `setAgentModel` + session-row sync (phases 2a–2c). |
| `share/share-next.ts` + `share/session.ts` | **Keep as disabled stub** | Network paths are dead (`disabled = true`, pinned by test) and `SessionShare.create` is the live HTTP session-create path. Removal would churn the HTTP/SDK contract (share/unshare endpoints) for zero behaviour change and add permanent merge friction at the exact seam cheap upstream cherry-picks come from. |
| Durable `event` log | **Keep** | Load-bearing: the sync/replay HTTP handler and control-plane workspace read it by `seq`. Growth is bounded per turn (v1 lifecycle events persist; per-token deltas are live-only and never persisted). Correcting an earlier note: the log grows in normal v1 operation, not only from the since-deleted mirror publishes. |
| Cross-instance ownership (liveness heartbeat / same-session two-window busy marker) | **Won't build on v1** | Engine lifecycle is already sound at three layers: per-chat close and panel dispose kill the child process, and the engine self-exits on stdin EOF (`cli/cmd/acp.ts` resolves on stdin end; `index.ts` hard-exits in `finally`) — so engines die with their windows on every path, including host death. The residual holes — a turnless pane left open >24h reaped by a sibling's history fetch, or one session resumed in two windows — are rare and self-healing (one failed prompt; open a new chat). A shared heartbeat table would add a schema migration, a periodic writer in every engine, and new staleness failure modes to remove that. Real ownership arrives with v2's multi-node model. |

## Re-evaluation trigger

Re-open the adopt-v2 question when upstream merges their v2 branch to dev or cuts a 2.x
release — they will ship the migration tooling with it. Until then, no new code should
depend on v2 session state.
