// t-ysud6n: how many whole tiles the connections strip hides on each side.
// Owner UAT read a tile scrolled out of view as a missing tile; the arrows
// show these counts so the strip says that more tiles exist.
import { CONN_GAP, type ConnFit } from './connectionCarouselFit';

export interface Hidden { before: number; after: number }

export function hiddenTiles(scrollLeft: number, clientWidth: number, fit: ConnFit, total: number, gap = CONN_GAP): Hidden {
  const step = fit.width + gap;
  if (!(clientWidth > 0) || !(step > 0)) return { before: 0, after: 0 };
  const before = Math.min(total, Math.max(0, Math.round(scrollLeft / step)));
  const shown = Math.max(1, Math.floor((clientWidth + gap + 1) / step));
  return { before, after: Math.max(0, total - before - shown) };
}
