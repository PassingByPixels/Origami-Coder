<script lang="ts">
  // THE COMPOSER'S MODE ROW: `/`, the effort ladder, Plan, Access and Vision
  // at the left, Export at the right (CHANGES.md round 3, change 42).
  //
  // NOT a segmented control. Round 2's proposal wrapped the three toggles in
  // one and was REJECTED: a segmented control means "one of these", and these
  // post three different messages and light independently. What was kept is
  // the half of that proposal that was right — the row's RHYTHM. One height,
  // one radius, one weight, so the row reads as a row rather than as five
  // mismatched boxes. Each toggle keeps its own ON colour.
  //
  // Its own file because InputBar.svelte is at its cap and the row's CSS is
  // the whole rhythm: Svelte scopes styles to the component that owns the
  // markup, so the rules had to travel with it.
  //
  // It owns only WHICH POPOVER IS OPEN. Every value on the row belongs to the
  // session and stays in InputBar, which is fed by the host's frames.
  import { tip } from '../../shared/warmTip';
  import ApprovePopover from './ApprovePopover.svelte';
  import CacheWarmDot from './CacheWarmDot.svelte';
  import EffortPopover from './EffortPopover.svelte';
  import ModeControl from './ModeControl.svelte';
  import VisionProfileMenu from './VisionProfileMenu.svelte';
  import type { ApproveButtonState } from './approveButtonState';
  import type { VisionState } from './visionPinState';

  interface ApproveRow {
    key: string; title: string; mode: string;
    options: Array<{ value: string; label: string; hint?: string }>;
    disabled: boolean; onSelect: (value: string) => void;
  }

  interface Props {
    /** The `/` palette is open — the button reads as pressed. */
    showSlash: boolean;
    onToggleSlash: () => void;
    /** A bare collab composer carries nothing that speaks to an engine
     *  session: only `/` and Export. */
    bare?: boolean;
    passthrough?: boolean;
    effortOptions: Array<{ value: string; name: string }>;
    effortCurrent: string;
    effortActive: boolean;
    onSelectEffort: (value: string) => void;
    permissionMode: string;
    onSelectMode: (modeId: string) => void;
    /** What the merged Access button says and wears (approveButtonState.ts). */
    approveButton: ApproveButtonState;
    approveRows: ApproveRow[];
    /** The Browser half of the Access button is VS Code's own setting and can
     *  change outside Origami while the popover was shut — the caller
     *  re-reads it on open so the badge stays honest. */
    onOpenApprove?: () => void;
    isVlm?: boolean;
    visionState?: VisionState;
    visionProfile: string;
    visionAgents: string[];
    sessionId?: string | null;
    onSelectVision: (slug: string) => void;
    onExport?: () => void;
    canExport?: boolean;
  }
  let {
    showSlash, onToggleSlash, bare = false, passthrough = false,
    effortOptions, effortCurrent, effortActive, onSelectEffort,
    permissionMode, onSelectMode, approveButton, approveRows, onOpenApprove,
    isVlm = false, visionState = 'auto-off', visionProfile, visionAgents, sessionId = null,
    onSelectVision, onExport, canExport = false,
  }: Props = $props();

  let effortOpen = $state(false);
  let approveOpen = $state(false);
  let visionOpen = $state(false);

  function toggleApprove() {
    approveOpen = !approveOpen;
    if (approveOpen) onOpenApprove?.();
  }
</script>

<div class="mode-row">
  <button class="mode-btn slash-btn" class:active={showSlash} onclick={onToggleSlash} use:tip={'Commands (toolbar)'}>/</button>
  <!-- Everything between the `/` toggle and Export speaks to an engine
       session, so a bare composer carries none of it. -->
  {#if !bare}
    <EffortPopover options={effortOptions} current={effortCurrent} active={effortActive} open={effortOpen}
      onToggle={() => (effortOpen = !effortOpen)} onClose={() => (effortOpen = false)}
      onSelect={onSelectEffort} />
    <!-- The session-mode control is per-chat: Build / Plan / Deep Plan. Trigger
         and popover both live in ModeControl.svelte; the badge on the model bar
         mirrors the live mode. -->
    <ModeControl current={permissionMode} onSelect={onSelectMode} {passthrough} />
    <!-- One access control, one popover, one labeled row: Actions (this
         chat's own Ask/Auto/Bypass preset). t-obf3jw removed the Browser
         row — bypass-browser (VS Code's global chat-tool auto-approve) is
         now the default with no setup action, so there is nothing left to
         pick for it; it still feeds the badge (approveButtonState.ts) so
         the button stays honest if that setting has been explicitly turned
         off in VS Code's own Settings UI. -->
    <div class="approve-wrap">
      <button class="mode-btn approve-btn" class:active={approveButton.active} class:bypass={approveButton.bypass} onclick={toggleApprove}
        use:tip={`Access settings — click to set Actions (this chat's own approval mode). Browser tool use is bypassed by default (VS Code's global chat-tool auto-approve); turn it off in VS Code's own Settings if you want it to ask.`}>{approveButton.label}</button>
      <ApprovePopover open={approveOpen} rows={approveRows} onClose={() => (approveOpen = false)} />
    </div>

    <!-- The one Vision control. Lit-and-native means this model reads images
         itself; neutral means it cannot, and a click picks the agent that
         reads them for it. Off by default, since arming adds a tool and a
         prompt block to every image turn; the engine narrows further
         (session/vision.ts) so nothing is spent on a turn with no image. -->
    <VisionProfileMenu profile={visionProfile} agents={visionAgents} open={visionOpen} native={isVlm} {visionState} sessionId={sessionId ?? ''}
      onToggle={() => (visionOpen = !visionOpen)} onSelect={onSelectVision} onClose={() => (visionOpen = false)} />
    <!-- The cache badge (t-rylyhm). A read-out, not a toggle: it says whether
         the engine's LAST REAL request read this chat's prefix back from the
         provider, which is the one fact that decides what the next message
         costs. It owns its own host message, so nothing on this row or in
         InputBar threads a value through for it. -->
    <CacheWarmDot sessionId={sessionId ?? ''} />
  {/if}
  <!-- Export is an action on the whole chat, not a mode, so it sits at the far
       end of the row rather than among the toggles. -->
  {#if onExport}
    <span class="export-slot">
      <button class="mode-btn export-md-btn" onclick={() => onExport?.()} disabled={!canExport} use:tip={'Export this conversation as markdown'}>&#8675; Export</button>
    </span>
  {/if}
</div>

<style>
  .mode-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px var(--composer-gutter, 12px) 6px;
  }

  /* ONE height, ONE radius, ONE weight for every button on the row.
     `:global` because three of the five buttons are drawn by child components
     (ModeControl, VisionProfileMenu, EffortPopover) and Svelte scopes a rule
     to the file that owns the markup — without it the row's rhythm would stop
     at its own two buttons, which is exactly the mismatch round 3 named. The
     children's own ON colours still win: theirs carry a second class. */
  .mode-row :global(.mode-btn) {
    height: 22px;
    padding: 0 10px;
    font-size: 11px;
    font-weight: 500;
    line-height: 20px;
    white-space: nowrap;
    background: var(--og-surface);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
  }
  .mode-row :global(.mode-btn:hover) {
    color: var(--og-text);
    background: var(--og-btn-bg);
  }
  .mode-row :global(.mode-btn:disabled) { opacity: 0.4; cursor: not-allowed; }
  /* Auto-approve: green when auto (accept edits), red when bypass (yolo), so
     the elevated-trust state is unmistakable. Order matters — .bypass follows
     .active so it wins at equal specificity. */
  .mode-btn.approve-btn.active {
    background: var(--og-success);
    border-color: var(--og-success);
    color: var(--og-bg);
  }
  .mode-btn.approve-btn.bypass {
    background: var(--og-error);
    border-color: var(--og-error);
    color: var(--og-btn-text);
  }
  /* `/` is a glyph, not a word, so it is square on the row's own height. */
  .slash-btn {
    width: 22px;
    min-width: 22px;
    padding: 0;
    text-align: center;
    font-family: var(--vscode-editor-font-family, monospace);
    font-weight: 700;
    color: var(--og-chat);
  }
  .slash-btn.active {
    background: var(--og-chat);
    color: var(--og-bg);
    border-color: var(--og-chat);
  }

  .export-slot { margin-left: auto; display: inline-flex; }

  /* .approve-wrap anchors ApprovePopover's absolute popover. */
  .approve-wrap { position: relative; display: inline-flex; }
</style>
