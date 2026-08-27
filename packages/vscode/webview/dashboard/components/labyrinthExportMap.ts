// Save the map as a self-contained HTML page — the ASSEMBLY step, extracted
// from LabyrinthPane.svelte when the pane reached its architecture cap.
//
// The split of duties is unchanged by the move: the host owns the Save dialog
// and the write (DashboardPanel's `exportLabyrinth` case), and the WEBVIEW owns
// the content, because only it can see the rendered SVG, the resolved theme and
// which steps were actually drawn. That is why this reads the live document
// rather than taking a string — the exported page carries the theme it was
// drawn under, not the theme it is later opened in.
//
// Returns the message to post, or undefined when there is no map on screen to
// export: a caller that posted anyway would write an empty page.

import { labyrinthSvg } from './labyrinthExport';
import { labyrinthHtmlDoc } from './labyrinthHtml';
import type { LayoutStep, MapMode } from './labyrinthLayout';

export interface ExportMapInput {
  /** The pane's canvas. The SVG is found inside it, never passed in. */
  canvasEl: HTMLElement | undefined;
  mode: MapMode;
  /** What the map DREW — filter and all, which is what the page's table lists. */
  steps: readonly LayoutStep[];
  /** What the ENGINE returned, the truncation notice's numerator. */
  loaded: number;
  truncated: boolean;
  total: number;
  title?: string;
  folder?: string;
  when?: string;
}

export interface ExportMapMessage {
  type: 'exportLabyrinth';
  mode: MapMode;
  html: string;
}

export function exportMapMessage(input: ExportMapInput): ExportMapMessage | undefined {
  const svg = input.canvasEl?.querySelector('svg.lab-svg') as SVGSVGElement | null;
  if (!svg) return undefined;
  const root = getComputedStyle(document.documentElement);
  const vars = (name: string) => root.getPropertyValue(name);
  const html = labyrinthHtmlDoc(
    {
      mode: input.mode,
      svg: labyrinthSvg(svg, (el) => getComputedStyle(el), vars),
      steps: input.steps,
      loaded: input.loaded,
      truncated: input.truncated,
      total: input.total,
      title: input.title,
      folder: input.folder,
      when: input.when,
    },
    vars,
  );
  return { type: 'exportLabyrinth', mode: input.mode, html };
}
