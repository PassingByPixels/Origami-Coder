// browserSnapshot.ts — the FRAME the chat pane draws, minted from a browser answer.
// Nothing here can fail a browser request: the engine's tool result is already
// computed and returned by the time any of this runs. The reveal browserPage.ts
// performs leaves the page laid out where the user may not be looking, so the pane
// grows a strip of what the agent saw — a FLIPBOOK of screenshots, not a live view.
// THE SCREENSHOT FALLBACK is fire-and-forget on purpose: waiting for a second tool
// call would put an extra round trip inside every browser call, against the engine's
// 30s budget. A failure is silence by design — the previous frame stays up.

import type { BrowserResponse } from './browserTools';
import { pngSize } from './browserShotSize';

/** One frame, as the dashboard webview receives it. */
export interface BrowserSnapshot {
  /** The verb that produced it — the ORIGINAL one, never the fallback
   *  screenshot, because the caption reads as what the agent just did. */
  action: string;
  ts: number;
  url?: string;
  /** `data:<mime>;base64,<bytes>` — already a webview-usable src, so the pane
   *  never has to know how VS Code hands images over. */
  imageDataUrl?: string;
  /** The page viewport the picture was taken at (t-qn0lpl, browserViewport.ts's
   *  `measuredSize`). The strip's caption reads `frame 3 of 3 · 1280 × 720 px`
   *  from it: a screenshot with no dimensions cannot be compared with anything,
   *  and the decoded <img> answers a DIFFERENT question — how big the bitmap
   *  is, not what size the page was laid out at. Absent from a fallback frame
   *  whose viewport could never be set, and from an older host. */
  width?: number;
  height?: number;
  /** t-ru1i84. How big the PICTURE is, read out of the PNG's own header
   *  (browserShotSize.ts). A capture is routinely scaled on its way out, so when this
   *  differs from the viewport above the caption names both and says which is which.
   *  Absent for a non-PNG, and from an older host. */
  shotWidth?: number;
  shotHeight?: number;
  pageText?: string;
}

export type SnapshotSink = (snapshot: BrowserSnapshot) => void;

/** 2 KB. The pane draws a CAPTION under a thumbnail, and a page summary can run
 *  to tens of kilobytes — every byte past this one is postMessage traffic for
 *  text no one will read at 96px. Cut, never summarised: a truncated line the
 *  user can see is ending is honest, a rewritten one is not. */
export const PAGE_TEXT_CAP = 2048;

export function capPageText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length <= PAGE_TEXT_CAP ? text : `${text.slice(0, PAGE_TEXT_CAP)}…`;
}

/** Build the frame. `answer` is the verb's own reply — it owns the url and the
 *  caption — while `image` is whatever actually carried the bytes. Keeping them
 *  separate stops a fallback frame reporting the bare screenshot's empty url. */
export function frameOf(
  action: string,
  answer: BrowserResponse,
  image: BrowserResponse,
  ts: number,
): BrowserSnapshot {
  const text = capPageText(answer.pageText);
  const shot = pngSize(image.imageBase64);
  return {
    action,
    ts,
    ...(answer.url ? { url: answer.url } : {}),
    ...(image.imageBase64
      ? { imageDataUrl: `data:${image.imageMime ?? 'image/png'};base64,${image.imageBase64}` }
      : {}),
    // From the IMAGE, like the bytes: the fallback screenshot is the thing that
    // was measured, and `answer` on that path is the verb that carried no picture.
    ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
    ...(shot ? { shotWidth: shot.width, shotHeight: shot.height } : {}),
    ...(text ? { pageText: text } : {}),
  };
}

/** Post a frame for one answered request, and never make the caller wait. `probe`
 *  is excluded outright: it opens nothing and drives nothing, so a screenshot chased
 *  after one would be a tool call spent on a question about which tools exist. */
export function emitSnapshot(
  action: string,
  answer: BrowserResponse,
  sink: SnapshotSink,
  screenshot: () => Promise<BrowserResponse>,
  now: () => number = Date.now,
): void {
  if (!answer.ok || action === 'probe') return;
  if (answer.imageBase64) {
    send(sink, frameOf(action, answer, answer, now()));
    return;
  }
  void screenshot().then(
    (shot) => {
      if (shot.ok && shot.imageBase64) send(sink, frameOf(action, answer, shot, now()));
    },
    () => {
      // The page closed, the tool is unpublished, the reveal failed. All the
      // same answer here: no new frame, and the last one keeps the strip.
    },
  );
}

/** A sink that throws must not take a browser turn down with it — by the time
 *  the fallback lands there is no caller left to report it to. */
function send(sink: SnapshotSink, snapshot: BrowserSnapshot): void {
  try {
    sink(snapshot);
  } catch {
    /* the panel went away mid-turn */
  }
}
