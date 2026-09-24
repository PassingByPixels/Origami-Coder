<script lang="ts">
  // WHAT THIS IS — the card that answers the owner's note, "we need to make
  // clear what's being offered here and its limitations", and carries the one
  // switch the whole feature hangs off.
  //
  // The switch lives HERE, on the same line as the card's own head, because
  // this card is the argument for turning Remote on: the sentence beside it
  // states what happens either way ("nothing leaves but sealed frames" /
  // "nothing is constructed"), which is the answer to the question the four
  // lines below it raise.
  //
  // No optimistic local state: the switch renders `enabled` as the HOST last
  // reported it. A settings write can fail silently (a policy-locked setting, a
  // read-only settings file), and a toggle stuck ON would tell the owner their
  // phone can reach them when it cannot.
  //
  // The words are the phone app's own four explainer pages, cut to one line
  // each, and the two lists are the same length on purpose: the limits are the
  // product as much as the features are.
  import {
    REMOTE_ICON_HAND, REMOTE_ICON_KEY, REMOTE_ICON_LOCK, REMOTE_ICON_PHONE,
  } from './remoteIcons';

  interface Props {
    enabled: boolean;
    onenabled: (enabled: boolean) => void;
  }
  let { enabled, onenabled }: Props = $props();

  const ON = 'One sealed socket to your relay. No account, no telemetry, nothing leaves but sealed frames.';
  const OFF = 'Nothing is constructed, no socket is opened, no secret is read.';

  const ROWS = [
    { icon: REMOTE_ICON_PHONE, title: 'Your desktop, in your pocket.', say: 'Read and steer the coding assistant running on your desktop, from this phone.' },
    { icon: REMOTE_ICON_LOCK, title: 'A locked box, passed hand to hand.', say: 'When you scan the code, your phone and this desktop share a secret, and everything they say is sealed with it.' },
    { icon: REMOTE_ICON_KEY, title: 'A key that cannot be copied.', say: "The key lives in the phone's Secure Enclave chip and never leaves it, not even for the app." },
    { icon: REMOTE_ICON_HAND, title: 'You decide how much it may do.', say: 'In Ask, every risky command waits for your tap first. In YOLO, you trust the chat and it runs without asking.' },
  ];
  const DOES = [
    'The live chat, mirrored — the same transcript the desktop is showing.',
    'Send a prompt from the phone.',
    'Stop a turn that is going wrong.',
    "Approve a permission the desktop waits on, signed by the phone's key.",
    'Switch a chat between Ask and YOLO.',
    'Switch the model and the session.',
  ];
  const DOES_NOT = [
    'No file access and no editor on the phone — you read the chat, you do not open the repo.',
    'No tools run on the phone — every command, edit and search runs on the desktop.',
    'Away from your own network it needs a relay — two devices behind NAT cannot meet without one.',
    'One phone per pairing — a second phone needs a new code.',
    'A lost key means pairing again.',
  ];
</script>

<section class="card story" data-name="what this is">
  <div class="card-head">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{@html REMOTE_ICON_PHONE}</svg>
    <span class="caps">What this is</span>
    <div class="master">
      <label class="sw big" title="Turn Origami Remote on or off">
        <input type="checkbox" checked={enabled} onchange={(e) => onenabled(e.currentTarget.checked)} />
        <span class="track"></span>
        <span class="sw-label">Remote is {enabled ? 'on' : 'off'}</span>
      </label>
      <span class="sw-state">{enabled ? ON : OFF}</span>
    </div>
  </div>

  <div class="story-rows">
    {#each ROWS as row (row.title)}
      <div class="st-row">
        <svg class="st-i" viewBox="0 0 24 24" aria-hidden="true">{@html row.icon}</svg>
        <p class="st-b"><span class="st-t">{row.title}</span> {row.say}</p>
      </div>
    {/each}
  </div>

  <div class="cols2">
    <div>
      <h4 class="yes">It does</h4>
      <ul>{#each DOES as line (line)}<li>{line}</li>{/each}</ul>
    </div>
    <div>
      <h4>It does not</h4>
      <ul>{#each DOES_NOT as line (line)}<li>{line}</li>{/each}</ul>
    </div>
  </div>
</section>

<style>
  .card {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 16px;
    display: flex; flex-direction: column; gap: 8px; min-width: 0;
  }
  .card-head { display: flex; align-items: center; gap: 8px; }
  /* NOT flex:1 — the master switch is pushed right by its own margin, and a
     growing caps label wrapped WHAT THIS IS onto two lines the moment the
     sentence beside it was the long one. */
  .caps {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted);
    font-weight: 600; flex: 0 0 auto; white-space: nowrap;
  }
  .ico {
    width: 16px; height: 16px; flex: 0 0 auto; color: var(--og-text-muted); stroke: currentColor; fill: none;
    stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round;
  }
  /* ROW-REVERSE: the switch reads last in the DOM (it is the control) and sits
     furthest right, with the consequence sentence to its left where the eye
     lands before the thumb does. */
  .master { display: flex; flex-direction: row-reverse; align-items: center; gap: 12px; margin-left: auto; min-width: 0; }
  .sw { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .sw input { position: absolute; opacity: 0; width: 0; height: 0; }
  .sw .track {
    width: 46px; height: 24px; border-radius: 999px; background: var(--og-success-soft);
    border: 1px solid var(--og-success); position: relative; flex: 0 0 auto;
    transition: background 0.15s, border-color 0.15s;
  }
  .sw .track::after {
    content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--og-success); transform: translateX(20px); transition: transform 0.15s, background 0.15s;
  }
  .sw:has(input:not(:checked)) .track { background: var(--og-surface-alt); border-color: var(--og-border); }
  .sw:has(input:not(:checked)) .track::after { background: var(--og-text-muted); transform: translateX(0); }
  .sw input:focus-visible + .track { outline: 1px solid var(--og-accent); outline-offset: 2px; }
  .sw-label { font-weight: 600; color: var(--og-text); white-space: nowrap; }
  .sw-state { font-size: 10.5px; color: var(--og-text-muted); line-height: 1.3; text-align: right; max-width: 540px; }

  .story-rows { display: flex; flex-direction: column; gap: 6px; }
  .st-row { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
  .st-i {
    width: 16px; height: 16px; flex: 0 0 auto; margin-top: 2px; color: var(--og-accent-2);
    stroke: currentColor; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round;
  }
  .st-t { font-weight: 700; color: var(--og-text); }
  .st-b { margin: 0; color: var(--og-text-secondary); }

  .cols2 {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 6px 24px;
    border-top: 1px solid var(--og-border); padding-top: 10px;
  }
  .cols2 h4 {
    margin: 0 0 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--og-text-muted); font-weight: 600;
  }
  .cols2 h4.yes { color: var(--og-success); }
  .cols2 ul { margin: 0; padding-left: 16px; }
  .cols2 li { line-height: 1.5; margin-bottom: 3px; color: var(--og-text-secondary); }
</style>
