<script lang="ts">
  // Memory pane — force-directed graph mind map + search over the wiki/memory
  // source folder. Lifted from the LiliNyx donor WikiPane; theme vars remapped
  // to --og-*, the LiliNyx-only Ingest/Lint arms dropped. Graph physics use
  // plain `let` arrays (NOT $state) — Svelte 5 proxies break in-place mutation.

  interface WikiPage {
    id: string;
    title: string;
    namespace: string;
    updated: string;
    snippet: string;
    tags: string[];
    content: string;
    /** Raw outbound link targets ([[wikilinks]] + md links), resolved to page
     *  ids at graph-build time. Optional so older host payloads still parse. */
    links?: string[];
  }

  interface GraphNode {
    id: string;
    label: string;
    type: 'page' | 'tag' | 'namespace';
    x: number;
    y: number;
    vx: number;
    vy: number;
    page?: WikiPage;
    radius: number;
    fixed?: boolean;
    /** Edge count — drives centre-gravity so hubs anchor the core. */
    degree: number;
    /** Tag use-count — drives size + opacity weighting. 0 for non-tag nodes. */
    count: number;
    jitter: number;
  }

  interface GraphEdge {
    source: string;
    target: string;
    /** 'link' = page↔page wikilink (accented); undefined = tag/namespace edge. */
    kind?: 'link';
    hub?: boolean;
  }

  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { onMount, tick } from 'svelte';
  import {
    repulsionForce, clampVelocity, clampToBounds, annealAlpha,
    mergeNodePositions, hasNewNodes, spiralSeed, SETTLE_ITERS,
  } from './wikiGraphPhysics';
  import {
    drawsNodeLabel, isLabelMode, labelModeText, nextLabelMode, showsReadouts,
    type LabelMode,
  } from './wikiGraphLabels';
  // The owner-approved "Showcase" recipe: tuned constants + the four forces
  // and the theme-aware tints it added. See those two leaves for provenance —
  // every number traces to a dial in the graph lab.
  import {
    ringSlots, applyTagRingForce, applyBubbleForce, viewCentreWorld, centrePullDelta,
    REPEL, HUB_REPEL_MULT, ATTRACT, CHILD_REPEL, LINK_ATTRACT_SCALE, TAG_EDGE_SCALE,
    DAMP_SETTLE, DAMP_FOLLOW,
    type BubbleGroup, type RingSlot, type TagRingInput,
  } from './wikiGraphForces';
  import {
    HARBOUR_GRAPH_THEME, clusterColour, hubHaloColour, vignetteColour, drawRadius, tagAlpha,
    LINK_ALPHA, META_ALPHA, LINK_WIDTH, META_WIDTH, EDGE_CURVE,
    NODE_DIM, RING_DIM, GLOW, HUB_HALO, HUB_HALO_R, VIGNETTE,
  } from './wikiGraphTheme';
  // The pure half of buildGraph(): the deterministic key->number tables and the
  // link-target resolution rules, out where they can be tested without a canvas.
  import { evenHues, folderOf, hash01, resolveLinkEdges } from './wikiGraphBuild';
  import { matchesSearch } from './paneSearch';
  import { marked } from 'marked';
  const vscode = getVsCodeApi();

  // `fullscreen` = this pane is the dedicated full editor tab (hides its own
  // "open fullscreen" button so it can't spawn another). Default false in the
  // sidebar host.
  let { fullscreen = false }: { fullscreen?: boolean } = $props();

  let query = $state('');
  let selectedResult: WikiPage | null = $state(null);
  let allPages: WikiPage[] = $state([]);
  let wikiPath = $state('');
  // Label density — see wikiGraphLabels.ts for what each state leaves visible.
  let labelMode: LabelMode = $state('hubs');
  let paneEl: HTMLDivElement | undefined = $state();
  let canvasEl: HTMLCanvasElement | undefined = $state();
  let hoveredNode: GraphNode | null = null;
  let dragNode: GraphNode | null = null;
  // Every rAF loop (settle / drag / coast / push-hold) writes its handle here
  // and cancels whatever was pending before scheduling its own first frame —
  // a SINGLE shared handle, so a rebuild mid-coast (or mid-push-hold) can
  // never leave two loops integrating the same `nodes` array at once.
  let animFrame: number = 0;
  // Ticks since the layout was last "re-heated" — drives annealAlpha's cooling
  // curve. Reset to 0 on a rebuild that adds new nodes, and on drag/push-hold
  // start; left alone on an unrelated rebuild so an already-settled graph
  // doesn't start jittering again.
  let settleIter = 0;

  // Colour axis (cycles Branch → Folder → Tag → Theme).
  // Branch/Folder/Tag use evenly spaced hues (not hash — hash collided).
  let colorBy: 'branch' | 'namespace' | 'tag' | 'theme' = $state('namespace');
  // Draggable preview/read box height (px). Clamped to the pane on drag.
  let previewH = $state(200);
  // …and whether the box is showing at all. COLLAPSED by default: at 200px it
  // took half of the 380px sidebar host before anything was selected, and it
  // held that space in the "Select a node…" empty state too. Selecting a node
  // does NOT auto-expand — the always-visible header names the page instead, so
  // what the box costs stays a decision the reader makes, not a surprise.
  let previewCollapsed = $state(true);

  // Graph state
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  let graphReady = $state(false);
  // Weighting denominators, recomputed per build.
  let maxTagCount = 1;
  let maxDegree = 1;
  // nodeId → set of directly-connected nodeIds, for hover-to-highlight.
  let adjacency = new Map<string, Set<string>>();

  let branchHues = new Map<string, number>();
  let folderHues = new Map<string, number>();
  let tagHues = new Map<string, number>();
  // Tag opacity by frequency share — most-used tags full, rare ones fade.
  const nodeTagAlpha = (node: GraphNode) => tagAlpha(node.count, maxTagCount);
  // Drawn radius grows with degree, so size means "how connected". Hit-testing
  // reads the same function or the clickable disc stops matching the painted one.
  const nodeRadius = (node: GraphNode) => drawRadius(node.radius, node.degree, maxDegree);
  // tag node id -> the folder it rings and its slot on that ring.
  let ringSlot: Map<string, RingSlot> = new Map();

  // View transform (screen = world * zoom + pan)
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let panning = false;
  let panStartScreen = { x: 0, y: 0 };
  let panStartOffset = { x: 0, y: 0 };

  onMount(() => {
    restorePrefs();
    // Register the host->pane listener HERE (not at module top) so it is torn
    // down when the collapsible Memory section closes — otherwise every expand
    // would leak another permanent window 'message' listener onto a dead pane.
    const onMessage = (event: MessageEvent) => {
      const msg = event.data || {};
      if (msg.type === 'workspaceData' && msg.data?.wikiPages) {
        allPages = msg.data.wikiPages;
        buildGraph();
      }
      if (msg.type === 'wikiPath' && typeof msg.path === 'string') {
        wikiPath = msg.path;
      }
    };
    window.addEventListener('message', onMessage);
    // Re-clamp the read box + repaint the canvas whenever the pane resizes
    // (window/sidebar re-dock, or the initial layout settling after mount) so a
    // persisted-too-tall previewH can't strand the graph at zero height, and a
    // resized canvas backing store stays in sync.
    let ro: ResizeObserver | undefined;
    if (paneEl && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onLayoutChanged);
      ro.observe(paneEl);
    }
    // The host broadcasts workspaceData once at bootstrap; this pane can mount
    // later, so pull the current wiki state now — mirrors ControlStrip's
    // requestModels handshake.
    vscode.postMessage({ type: 'requestWorkspaceData' });
    return () => {
      window.removeEventListener('message', onMessage);
      ro?.disconnect();
      // Unwind any gesture in progress so its captured window listeners can't
      // leak onto the detached component; the drag/coast/push-hold rAF chain
      // all share `animFrame`, so the one cancel below covers whichever is live.
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      window.removeEventListener('pointermove', onWindowPanMove);
      window.removeEventListener('pointerup', onWindowPanUp);
      window.removeEventListener('pointercancel', onWindowPanUp);
      window.removeEventListener('pointermove', onResizeMove);
      window.removeEventListener('pointerup', onResizeUp);
      window.removeEventListener('pointercancel', onResizeUp);
      dragNode = null;
      panning = false;
      resizing = false;
      if (animFrame) cancelAnimationFrame(animFrame);
    };
  });

  function changeWikiFolder() {
    vscode.postMessage({ type: 'pickWikiFolder' });
  }

  function cycleLabelMode() {
    labelMode = nextLabelMode(labelMode);
    persistPrefs();
    render();
  }
  const labelBtnText = $derived(labelModeText(labelMode));

  function cycleColorBy() {
    colorBy = colorBy === 'branch' ? 'namespace' : colorBy === 'namespace' ? 'tag' : colorBy === 'tag' ? 'theme' : 'branch';
    persistPrefs();
    render();
  }
  const colorLabel = $derived(colorBy === 'branch' ? 'Branch' : colorBy === 'namespace' ? 'Folder' : colorBy === 'tag' ? 'Tag' : 'Theme');

  // Persist view prefs (colour axis + read-box height) in webview state so they
  // survive collapse/expand and reload. Namespaced merge so we don't clobber
  // other panes sharing this webview's state bag.
  function persistPrefs() {
    try {
      const s = (vscode.getState?.() as Record<string, unknown>) || {};
      vscode.setState?.({ ...s, memoryGraph: { colorBy, previewH, labelMode, previewCollapsed } });
    } catch { /* setState unavailable — prefs just don't persist */ }
  }
  function restorePrefs() {
    try {
      const mg = (vscode.getState?.() as { memoryGraph?: { colorBy?: string; previewH?: number; labelMode?: string; previewCollapsed?: boolean } } | undefined)?.memoryGraph;
      if (mg?.colorBy === 'theme' || mg?.colorBy === 'namespace' || mg?.colorBy === 'tag' || mg?.colorBy === 'branch') colorBy = mg.colorBy;
      if (isLabelMode(mg?.labelMode)) labelMode = mg.labelMode;
      if (typeof mg?.previewH === 'number' && mg.previewH >= 80) previewH = mg.previewH;
      // Absent (state written by a build before the box could collapse) means
      // collapsed — the new default wins over the old build's implied `false`.
      if (typeof mg?.previewCollapsed === 'boolean') previewCollapsed = mg.previewCollapsed;
    } catch { /* getState unavailable — use defaults */ }
    clampPreview();
  }
  // Clamp the read-box height to the current pane so a value persisted on a
  // taller layout can't collapse the graph canvas to nothing on a shorter one.
  function clampPreview() {
    const max = Math.max(120, (paneEl?.clientHeight ?? 400) - 140);
    previewH = Math.max(80, Math.min(max, previewH));
  }
  // The canvas box changed under us: re-clamp the read box to the pane, place
  // the graph if this is its first LIVE canvas, and repaint. The pane's own
  // ResizeObserver and the preview toggle are both callers — the toggle needs
  // it because the PANE does not resize when the read box opens or shuts, so
  // nothing else would hand the canvas the rows it just won or lost.
  function onLayoutChanged() { clampPreview(); onCanvasLayout(); render(); }

  async function togglePreview() {
    previewCollapsed = !previewCollapsed;
    persistPrefs();
    // Measure AFTER the flush: render() reads the canvas's client height, which
    // is still the pre-toggle one until Svelte has applied the DOM change.
    await tick();
    onLayoutChanged();
  }

  // Drag the divider to resize the read box. Dragging UP grows it; clamped to
  // the pane so neither the graph nor the preview can be squeezed to nothing.
  let resizing = false;
  let rsStartY = 0;
  let rsStartH = 0;
  function onResizeDown(e: PointerEvent) {
    resizing = true;
    rsStartY = e.clientY;
    rsStartH = previewH;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeUp);
    // pointercancel (pen palm-rejection / OS gesture revocation) fires INSTEAD
    // of pointerup — without this the drag sticks. Mirrors the node-drag + pan
    // paths.
    window.addEventListener('pointercancel', onResizeUp);
    e.preventDefault();
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    const paneH = paneEl?.clientHeight ?? 400;
    const max = Math.max(120, paneH - 140);
    previewH = Math.max(80, Math.min(max, rsStartH + (rsStartY - e.clientY)));
    // The canvas CSS box just changed; re-sync its backing store + repaint
    // (resizeCanvas only runs inside render, and the settle loop has stopped).
    render();
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeUp);
    window.removeEventListener('pointercancel', onResizeUp);
    persistPrefs();
  }

  function buildGraph() {
    // Snapshot the OLD layout's physics state before it's discarded, so a
    // rebuild (the host refires workspaceData on every wiki .md file event)
    // can restore it below instead of re-randomizing a settled graph.
    const prevById = new Map(nodes.map(n => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy, fixed: n.fixed }]));

    nodes = [];
    edges = [];
    const nodeMap = new Map<string, GraphNode>();
    const { cx, cy, live } = canvasCenter();
    seedCx = cx; seedCy = cy;
    placedOnLiveCanvas = live;

    // Add page nodes. Seeded on a golden-angle spiral (not a random ring) so
    // spawn collisions — which get MORE likely as the page count grows, and
    // are exactly what feeds the repulsion-force blowup — can't happen; any
    // node that already existed gets its real position back from the merge below.
    allPages.forEach((page, i) => {
      const { x, y } = spiralSeed(i, allPages.length, cx, cy, 120, 200);
      const node: GraphNode = {
        id: `page:${page.id}`,
        label: page.title,
        type: 'page',
        x, y,
        vx: 0, vy: 0,
        page,
        radius: 6,
        degree: 0,
        count: 0,
        jitter: hash01(page.id),
      };
      nodes.push(node);
      nodeMap.set(node.id, node);
    });

    // Add tag nodes + edges. Size normalised to the busiest tag so weighting
    // scales to any wiki (2 tags or 200) rather than a fixed per-use bump.
    const tagCounts = new Map<string, number>();
    allPages.forEach(p => p.tags.forEach(t => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
    maxTagCount = Math.max(1, ...tagCounts.values());

    let tagIndex = 0;
    const tagTotal = tagCounts.size;
    // Which folders carry each tag — the vote that decides whose ring it joins.
    const ringInputs: TagRingInput[] = [];
    tagCounts.forEach((count, tag) => {
      const { x, y } = spiralSeed(tagIndex++, tagTotal, cx, cy, 40, 90);
      const node: GraphNode = {
        id: `tag:${tag}`,
        label: tag,
        type: 'tag',
        x, y,
        vx: 0, vy: 0,
        radius: 3 + 9 * (count / maxTagCount),
        degree: 0,
        count,
        jitter: hash01(tag),
      };
      nodes.push(node);
      nodeMap.set(node.id, node);

      // Connect pages to their tags
      const folders: string[] = [];
      allPages.forEach(p => {
        if (p.tags.includes(tag)) {
          edges.push({ source: `page:${p.id}`, target: `tag:${tag}` });
          folders.push(folderOf(p));
        }
      });
      ringInputs.push({ id: node.id, label: tag, folders });
    });
    ringSlot = ringSlots(ringInputs);

    // Add namespace nodes + edges. Spiral-seeded like tags/pages — the old
    // ±20px random box around the centre got more collision-prone with every
    // added namespace.
    const namespaces = new Set(allPages.map(folderOf));
    let nsIndex = 0;
    const nsTotal = namespaces.size;
    namespaces.forEach(ns => {
      const seeded = ns === '(root)' ? { x: cx, y: cy } : spiralSeed(nsIndex++, nsTotal, cx, cy, 15, 55);
      const node: GraphNode = {
        id: `ns:${ns}`,
        label: ns,
        type: 'namespace',
        x: seeded.x, y: seeded.y,
        vx: 0, vy: 0,
        radius: 10,
        degree: 0,
        count: 0,
        jitter: 0,
        fixed: ns === '(root)',
      };
      nodes.push(node);
      nodeMap.set(node.id, node);

      allPages.forEach(p => {
        if (folderOf(p) === ns) {
          edges.push({ source: `page:${p.id}`, target: `ns:${ns}`, hub: true });
        }
      });
    });

    // Rule 4 — page↔page link edges. The resolution ladder (exact id → path
    // resolved relative to the SOURCE page's folder → UNAMBIGUOUS basename →
    // UNAMBIGUOUS title, self-links and reciprocal pairs collapsed) lives in
    // wikiGraphBuild.resolveLinkEdges, where every branch has a test.
    for (const e of resolveLinkEdges(allPages)) edges.push(e);

    // Degree drives centre-gravity so the most-connected nodes anchor the core;
    // adjacency drives hover-to-highlight.
    const deg = new Map<string, number>();
    adjacency = new Map();
    const link = (a: string, b: string) => {
      let s = adjacency.get(a);
      if (!s) { s = new Set(); adjacency.set(a, s); }
      s.add(b);
    };
    for (const e of edges) {
      deg.set(e.source, (deg.get(e.source) || 0) + 1);
      deg.set(e.target, (deg.get(e.target) || 0) + 1);
      link(e.source, e.target);
      link(e.target, e.source);
    }
    maxDegree = 1;
    for (const n of nodes) {
      n.degree = deg.get(n.id) || 0;
      if (n.degree > maxDegree) maxDegree = n.degree;
    }

    // Position-preserving merge: any node id that existed before gets its
    // real x/y/vx/vy/fixed back, so a settled layout is not re-exploded by
    // the next workspaceData refresh. Only re-heat the settle curve when this
    // rebuild actually introduced something new to integrate — an unrelated
    // refresh (a save to a page already in the graph) leaves it alone.
    const graphGrew = hasNewNodes(nodes, prevById);
    mergeNodePositions(nodes, prevById);
    if (graphGrew) settleIter = 0;
    // The drag/hover pointers reference the OLD node objects, which were just
    // discarded — re-point them at the new instance for the same id (now
    // carrying the restored position via the merge above) so an in-progress
    // drag survives a rebuild instead of silently going stale.
    if (dragNode) dragNode = nodeMap.get(dragNode.id) ?? null;
    if (hoveredNode) hoveredNode = nodeMap.get(hoveredNode.id) ?? null;

    branchHues = evenHues(allPages.map((p) => folderOf(p).split('/')[0]));
    folderHues = evenHues(allPages.map(folderOf));
    tagHues = evenHues(allPages.flatMap((p) => p.tags));

    graphReady = true;
    render();
    startSimulation();
  }

  function isHub(n: GraphNode) { return n.type === 'namespace'; }
  function isRootHub(n: GraphNode) { return n.id === 'ns:(root)'; }

  // A just-mounted canvas often reports 0×0. Treating that as the centre
  // seeds every node at the top-left, then pinRootHub later jumps to the
  // real midpoint — wiki-index looks flung. Never treat a collapsed box as a centre.
  let seedCx = 400, seedCy = 300;
  let placedOnLiveCanvas = false;
  function canvasCenter(): { cx: number; cy: number; live: boolean } {
    const w = canvasEl?.clientWidth ?? 0;
    const h = canvasEl?.clientHeight ?? 0;
    const live = w >= 40 && h >= 40;
    return { cx: live ? w / 2 : 400, cy: live ? h / 2 : 300, live };
  }
  function onCanvasLayout() {
    const { live } = canvasCenter();
    if (!live || placedOnLiveCanvas || nodes.length === 0) return;
    placedOnLiveCanvas = true;
    pinRootHub();
    settleIter = 0;
    kickLoop();
    resetView();
  }

  function startSimulation() {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = 0; }
    kickLoop();
  }

  function kickLoop() {
    if (animFrame) return;
    function tick() {
      if (!canvasEl) { animFrame = 0; return; }
      if (settleIter < SETTLE_ITERS) {
        simulate(false);
        render();
        animFrame = requestAnimationFrame(tick);
        return;
      }
      const moving = followTick();
      render();
      if (dragNode || moving) animFrame = requestAnimationFrame(tick);
      else animFrame = 0;
    }
    animFrame = requestAnimationFrame(tick);
  }

  // After the layout has settled, hubs stay put so they can be pulled
  // apart by hand. Pages and tags keep a soft spring toward their edges
  // (so dragging a hub makes its children trail, not the whole graph reheat).
  // Sit on the cloud, not the CSS box. Pinning to canvas mid ripped wiki-index
  // out of the pack whenever the pack still lived in spawn-space.
  function pinRootHub() {
    let sx = 0, sy = 0, c = 0;
    for (const n of nodes) {
      if (isRootHub(n)) continue;
      sx += n.x; sy += n.y; c++;
    }
    const x = c ? sx / c : canvasCenter().cx;
    const y = c ? sy / c : canvasCenter().cy;
    for (const n of nodes) {
      if (!isRootHub(n)) continue;
      n.x = x; n.y = y; n.vx = 0; n.vy = 0; n.fixed = true;
    }
  }

  // --- Showcase forces: the pane owns the arrays, the leaf owns the maths ---

  // The world point under the middle of the viewport — the centre pull's
  // anchor. Deliberately NOT canvasCenter(): that returns SCREEN coordinates,
  // and once resetView() has installed a fitted zoom and a non-zero pan the two
  // are different places. See wikiGraphForces.viewCentreWorld.
  function viewCentre(): { x: number; y: number } {
    return viewCentreWorld(canvasEl?.clientWidth ?? 0, canvasEl?.clientHeight ?? 0, panX, panY, zoom);
  }

  // Folder hubs by folder name — both new forces anchor on them.
  function hubsByFolder(): Map<string, GraphNode> {
    return new Map(nodes.filter(isHub).map((n) => [n.label, n]));
  }

  // Push tags out onto a ring around their own folder's hub.
  function tagRingForce() {
    const hubs = hubsByFolder();
    applyTagRingForce(nodes.filter((n) => n.type === 'tag'), ringSlot, (slot) => hubs.get(slot.folder));
  }

  // One cluster per folder that has a hub and members free to move.
  function bubbleGroups(): BubbleGroup[] {
    const hubs = hubsByFolder();
    const kidsBy = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      if (n.type !== 'page' || !n.page || n.fixed) continue;
      const k = folderOf(n.page);
      let g = kidsBy.get(k);
      if (!g) { g = []; kidsBy.set(k, g); }
      g.push(n);
    }
    const groups: BubbleGroup[] = [];
    kidsBy.forEach((kids, folder) => {
      const hub = hubs.get(folder);
      if (hub) groups.push({ hub, kids });
    });
    return groups;
  }

  function followTick(): boolean {
    const attraction = 0.016;
    const rest0 = 36;
    const jitter = 0.4;
    const childR = CHILD_REPEL;
    const { cx, cy } = canvasCenter();
    pinRootHub();
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    if (childR > 0) {
      const groups = new Map<string, GraphNode[]>();
      for (const n of nodes) {
        if (n.type !== 'page' || !n.page) continue;
        const k = folderOf(n.page);
        let g = groups.get(k);
        if (!g) { g = []; groups.set(k, g); }
        g.push(n);
      }
      for (const kids of groups.values()) {
        for (let i = 0; i < kids.length; i++) {
          for (let j = i + 1; j < kids.length; j++) {
            const a = kids[i], b = kids[j];
            const { fx, fy } = repulsionForce(b.x - a.x, b.y - a.y, childR, 0.25);
            a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
          }
        }
      }
    }
    for (const edge of edges) {
      const a = nodeById.get(edge.source), b = nodeById.get(edge.target);
      if (!a || !b) continue;
      if (edge.kind === 'link' || !edge.hub) continue;
      const hub = isHub(a) ? a : b, child = isHub(a) ? b : a;
      const dx = child.x - hub.x, dy = child.y - hub.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = rest0 * (1 - jitter + 2 * jitter * child.jitter);
      const force = (dist - rest) * attraction;
      if (!child.fixed) { child.vx -= (dx / dist) * force; child.vy -= (dy / dist) * force; }
    }
    tagRingForce();
    // Containment keeps holding the silhouette after the settle; the swirl does
    // NOT run here — a tangential force at rest would hold maxSp above the rest
    // threshold below and this loop would never stop.
    applyBubbleForce(bubbleGroups(), false);
    let maxSp = 0;
    for (const n of nodes) {
      if (isRootHub(n)) continue;
      if (isHub(n) || n.fixed) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= DAMP_FOLLOW;
      n.vy *= DAMP_FOLLOW;
      const v = clampVelocity(n.vx, n.vy);
      n.vx = v.vx; n.vy = v.vy;
      n.x += n.vx;
      n.y += n.vy;
      const p = clampToBounds(n.x, n.y, cx, cy);
      n.x = p.x; n.y = p.y;
      const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (sp > maxSp) maxSp = sp;
    }
    return maxSp > 0.18;
  }

  // `dragging` is passed in rather than read off the closed-over `dragNode`
  // so this is one call site whether the caller is the settle loop, the drag
  // loop, or the coast tail.
  function simulate(dragging: boolean) {
    const alpha = annealAlpha(settleIter / SETTLE_ITERS, dragging);
    if (settleIter < SETTLE_ITERS) settleIter++;
    const repulsion = REPEL;
    const attraction = ATTRACT;
    const { cx, cy } = canvasCenter();
    pinRootHub();

    // Repulsion between all nodes — distance-floored + magnitude-capped (see
    // wikiGraphPhysics.repulsionForce) so a near-coincident pair can no
    // longer produce an explosive single-tick force. Folder hubs get a
    // stronger pairwise kick so they do not collapse into one pile.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const bothHubs = a.type === 'namespace' && b.type === 'namespace';
        const { fx, fy } = repulsionForce(b.x - a.x, b.y - a.y, bothHubs ? repulsion * HUB_REPEL_MULT : repulsion, alpha);
        if (!a.fixed) { a.vx -= fx; a.vy -= fy; }
        if (!b.fixed) { b.vx += fx; b.vy += fy; }
      }
    }

    // Attraction along edges
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    for (const edge of edges) {
      const a = nodeById.get(edge.source), b = nodeById.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      // Tag springs are slackened on top of the link/metadata scale — at full
      // strength they drag the perimeter ring back into the cloud.
      let kindScale = edge.kind === 'link' ? LINK_ATTRACT_SCALE : 1;
      if (a.type === 'tag' || b.type === 'tag') kindScale *= TAG_EDGE_SCALE;
      const rest = (isHub(a) || isHub(b)) ? 36 * (1 - 0.4 + 0.8 * ((a.jitter + b.jitter) / 2)) : 28;
      const force = (dist - rest) * attraction * kindScale * alpha;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }

    tagRingForce();
    applyBubbleForce(bubbleGroups(), true);

    // Integrate, with a centre pull anchored on the WORLD point under the view
    // centre. The previous attempt used the canvas midpoint as if it were a
    // world coordinate, which packed every hub onto it once the view was panned
    // or zoomed — so it was deleted rather than fixed. viewCentre() is the fix.
    // clampToBounds below still takes canvasCenter(), unchanged: it is a
    // 4000-unit runaway net a settled layout never touches, so the same
    // coordinate-space slip is inert there rather than a shaping force.
    const centre = viewCentre();
    for (const n of nodes) {
      if (isRootHub(n)) continue;
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      const { dvx, dvy } = centrePullDelta(n, centre, alpha);
      n.vx += dvx;
      n.vy += dvy;
      n.vx *= DAMP_SETTLE;
      n.vy *= DAMP_SETTLE;
      const v = clampVelocity(n.vx, n.vy);
      n.vx = v.vx; n.vy = v.vy;
      n.x += n.vx;
      n.y += n.vy;
      const p = clampToBounds(n.x, n.y, cx, cy);
      n.x = p.x; n.y = p.y;
    }
  }

  function resizeCanvas() {
    if (!canvasEl) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
    const targetW = Math.round(w * dpr), targetH = Math.round(h * dpr);
    if (canvasEl.width !== targetW || canvasEl.height !== targetH) {
      canvasEl.width = targetW;
      canvasEl.height = targetH;
    }
  }

  function render() {
    if (!canvasEl) return;
    resizeCanvas();
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
    // The graph is PINNED to Harbour on every theme (owner call, 2026-08-27):
    // on the light ones it was hard to look at. So the ground is painted here,
    // OPAQUE, in screen space — the pane behind the canvas is still live-themed,
    // and the old clear-to-transparent would let that colour through. globalAlpha
    // is set explicitly: canvas state survives the previous frame's last draw.
    const theme = HARBOUR_GRAPH_THEME;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);

    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const vis = visibleIds();

    // Hover-to-highlight: when a node is hovered, its edges + neighbours stay
    // lit and everything else dims, so you can read what connects to what.
    const hoverId = hoveredNode?.id ?? null;
    const neighbours = hoverId ? adjacency.get(hoverId) : null;

    // Draw edges — page↔page link edges accented + brighter so structure reads;
    // tag/folder metadata edges stay faint. Linewidth scales inversely with zoom.
    for (const edge of edges) {
      const a = nodeById.get(edge.source), b = nodeById.get(edge.target);
      if (!a || !b) continue;
      if (isRootHub(a) || isRootHub(b)) continue;
      if (vis && (!vis.has(a.id) || !vis.has(b.id))) continue;
      const isLink = edge.kind === 'link';
      const active = !hoverId || edge.source === hoverId || edge.target === hoverId;
      ctx.strokeStyle = isLink ? theme.accent : theme.border;
      ctx.globalAlpha = (isLink ? LINK_ALPHA : META_ALPHA) * (active ? 1 : 0.08);
      ctx.lineWidth = (isLink ? LINK_WIDTH : META_WIDTH) / zoom;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      // Bow each edge perpendicular to its own chord, so a dense bundle reads
      // as separate strands instead of one straight-line mat.
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ex = b.x - a.x, ey = b.y - a.y;
      ctx.quadraticCurveTo(mx - ey * EDGE_CURVE, my + ex * EDGE_CURVE, b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Draw nodes
    for (const node of nodes) {
      if (isRootHub(node)) continue;
      if (vis && !vis.has(node.id)) continue;
      const isHovered = hoveredNode?.id === node.id;
      const isSelected = selectedResult && node.page?.id === selectedResult.id;
      // Dim nodes not connected to the hovered one (self + neighbours stay lit).
      const dim = hoverId ? (node.id === hoverId || (neighbours?.has(node.id) ?? false) ? 1 : NODE_DIM) : 1;
      const r = nodeRadius(node);

      // Halo behind a folder hub: the hub's OWN folder hue, bloomed, on the
      // readable side of whichever theme is running.
      if (isHub(node) && dim > 0) {
        const hr = r * HUB_HALO_R;
        const g = ctx.createRadialGradient(node.x, node.y, r * 0.5, node.x, node.y, hr);
        const hue = folderHues.get(node.label) ?? 200;
        g.addColorStop(0, hubHaloColour(hue, 0.5 * HUB_HALO * dim));
        g.addColorStop(1, hubHaloColour(hue, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(node.x, node.y, hr, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, r + (isHovered ? 2 : 0), 0, Math.PI * 2);

      // Colour by the active axis — deterministic hue per group. Under
      // 'namespace' tags are muted, frequency-faded connectors; under 'tag'
      // folders are muted. Selection always wins (chatColor).
      let alpha = 1;
      if (isSelected) {
        ctx.fillStyle = theme.chat;
      } else if (colorBy === 'theme') {
        if (node.type === 'namespace') ctx.fillStyle = theme.hub;
        else if (node.type === 'tag') { ctx.fillStyle = theme.tag; alpha = nodeTagAlpha(node); }
        else ctx.fillStyle = theme.text;
      } else if (colorBy === 'tag') {
        if (node.type === 'namespace') ctx.fillStyle = theme.muted;
        else if (node.type === 'tag') { ctx.fillStyle = clusterColour(tagHues.get(node.label) ?? 30); alpha = nodeTagAlpha(node); }
        else {
          const t = node.page?.tags?.[0];
          ctx.fillStyle = t ? clusterColour(tagHues.get(t) ?? 200) : theme.text;
        }
      } else {
        if (node.type === 'tag') { ctx.fillStyle = theme.muted; alpha = nodeTagAlpha(node); }
        else {
          const folder = node.type === 'namespace' ? node.label : folderOf(node.page ?? { namespace: '' });
          const key = colorBy === 'namespace' ? folder : folder.split('/')[0];
          const hues = colorBy === 'namespace' ? folderHues : branchHues;
          ctx.fillStyle = clusterColour(hues.get(key) ?? 200);
        }
      }
      // Tags ring their folder now, so they read as grey satellites rather than
      // lit members of it.
      if (node.type === 'tag') alpha *= RING_DIM;
      // shadowBlur is measured in DEVICE space, so divide by zoom to keep the
      // bloom the same visual size at every zoom level. The colour is the
      // node's own fill, which is already theme-derived — read back rather than
      // recomputed, but guarded: fillStyle is still the halo's GRADIENT if a
      // colour branch above ever fails to assign, and a gradient shadowColor is
      // silently ignored rather than erroring.
      const fill = ctx.fillStyle;
      ctx.shadowBlur = GLOW / zoom;
      ctx.shadowColor = typeof fill === 'string' ? fill : theme.text;
      ctx.globalAlpha = alpha * dim;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      // Distinct accent ring on the active node so a selected page is legible
      // even where --og-chat and --og-crane resolve to the same colour.
      if (isSelected || isHovered) {
        ctx.lineWidth = 2 / zoom;
        ctx.strokeStyle = theme.accent;
        ctx.stroke();
      }

      const queryActive = !!query.trim();
      if (drawsNodeLabel(labelMode, {
        isHub: node.type === 'namespace',
        isHovered,
        isSelected: !!isSelected,
        isQueryHit: queryActive && nodeQueryHit(node),
        queryActive,
      })) {
        ctx.font = node.type === 'namespace' ? 'bold 11px sans-serif' : node.type === 'tag' ? '9px sans-serif' : '10px sans-serif';
        ctx.fillStyle = isHovered || isSelected ? theme.text : theme.muted;
        ctx.globalAlpha = dim;
        ctx.textAlign = 'center';
        ctx.fillText(node.label, node.x, node.y - r - 4);
        ctx.globalAlpha = 1;
      }
    }

    // Vignette, painted in SCREEN space after the world draw so it stays put
    // under pan and zoom. Its pole is black — see vignetteColour.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vg = ctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.25,
      w / 2, h / 2, Math.max(w, h) * 0.75,
    );
    vg.addColorStop(0, vignetteColour(0));
    vg.addColorStop(1, vignetteColour(VIGNETTE));
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  function getNodeAt(x: number, y: number): GraphNode | null {
    const vis = visibleIds();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (isRootHub(n) || (vis && !vis.has(n.id))) continue;
      // The DRAWN radius, not the base one — degree grows the disc on screen,
      // and a hit target that ignored that would sit inside a bigger node.
      const hit = nodeRadius(n) + 4;
      const dx = x - n.x, dy = y - n.y;
      if (dx * dx + dy * dy <= hit * hit) return n;
    }
    return null;
  }

  let dragStartX = 0;
  let dragStartY = 0;
  let didDrag = false;

  let activePointerId: number | null = null;

  function screenPoint(e: { clientX: number; clientY: number }) {
    const rect = canvasEl!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function pointFromEvent(e: { clientX: number; clientY: number }) {
    // World coordinates for node picking / dragging
    const s = screenPoint(e);
    return { x: (s.x - panX) / zoom, y: (s.y - panY) / zoom };
  }

  function zoomBy(factor: number) {
    if (!canvasEl) return;
    const cx = canvasEl.clientWidth / 2;
    const cy = canvasEl.clientHeight / 2;
    const worldX = (cx - panX) / zoom;
    const worldY = (cy - panY) / zoom;
    const newZoom = Math.max(0.25, Math.min(4, zoom * factor));
    panX = cx - worldX * newZoom;
    panY = cy - worldY * newZoom;
    zoom = newZoom;
    render();
  }

  function resetView() {
    const w = canvasEl?.clientWidth ?? 0;
    const h = canvasEl?.clientHeight ?? 0;
    if (!canvasEl || w < 40 || h < 40 || nodes.length === 0) {
      zoom = 1; panX = 0; panY = 0; render();
      return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (isRootHub(n)) continue;
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    }
    if (!Number.isFinite(minX)) { zoom = 1; panX = 0; panY = 0; render(); return; }
    const gcx = (minX + maxX) / 2, gcy = (minY + maxY) / 2;
    const gw = Math.max(80, maxX - minX + 80), gh = Math.max(80, maxY - minY + 80);
    zoom = Math.max(0.25, Math.min(1.5, Math.min(w / gw, h / gh)));
    panX = w / 2 - gcx * zoom;
    panY = h / 2 - gcy * zoom;
    render();
  }

  function onCanvasWheel(e: WheelEvent) {
    e.preventDefault();
    if (!canvasEl) return;
    const s = screenPoint(e);
    const worldX = (s.x - panX) / zoom;
    const worldY = (s.y - panY) / zoom;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newZoom = Math.max(0.25, Math.min(4, zoom * factor));
    // Keep the point under cursor stable
    panX = s.x - worldX * newZoom;
    panY = s.y - worldY * newZoom;
    zoom = newZoom;
    render();
  }

  function onCanvasContextMenu(e: MouseEvent) {
    // Right-click is used for panning; suppress the browser menu
    e.preventDefault();
  }

  function onWindowPanMove(e: PointerEvent) {
    if (!panning || !canvasEl) return;
    const s = screenPoint(e);
    panX = panStartOffset.x + (s.x - panStartScreen.x);
    panY = panStartOffset.y + (s.y - panStartScreen.y);
    render();
  }

  function onWindowPanUp(_e: PointerEvent) {
    if (!panning) return;
    panning = false;
    if (canvasEl) canvasEl.style.cursor = hoveredNode ? 'grab' : 'default';
    window.removeEventListener('pointermove', onWindowPanMove);
    window.removeEventListener('pointerup', onWindowPanUp);
    window.removeEventListener('pointercancel', onWindowPanUp);
  }

  function onWindowPointerMove(e: PointerEvent) {
    if (!canvasEl || !dragNode) return;
    const { x, y } = pointFromEvent(e);
    const dx = x - dragStartX, dy = y - dragStartY;
    if (!didDrag && dx * dx + dy * dy > 16) {
      didDrag = true;
      dragNode.fixed = true;
      canvasEl.style.cursor = 'grabbing';
    }
    if (didDrag) {
      dragNode.x = x;
      dragNode.y = y;
      dragNode.vx = 0;
      dragNode.vy = 0;
      render();
      kickLoop();
    }
  }

  function onWindowPointerUp(_e: PointerEvent) {
    endDrag();
  }

  function onCanvasPointerMove(e: PointerEvent) {
    if (!canvasEl || dragNode) return; // window listener owns drag moves
    const { x, y } = pointFromEvent(e);
    const node = getNodeAt(x, y);
    if (node !== hoveredNode) {
      hoveredNode = node;
      canvasEl.style.cursor = node ? 'grab' : 'default';
      render();
    }
  }

  function onCanvasPointerDown(e: PointerEvent) {
    if (!canvasEl) return;
    e.preventDefault();

    // Right mouse button (or middle) — start panning the viewport
    if (e.button === 2 || e.button === 1) {
      panning = true;
      const s = screenPoint(e);
      panStartScreen = s;
      panStartOffset = { x: panX, y: panY };
      canvasEl.style.cursor = 'move';
      window.addEventListener('pointermove', onWindowPanMove);
      window.addEventListener('pointerup', onWindowPanUp);
      window.addEventListener('pointercancel', onWindowPanUp);
      return;
    }

    const { x, y } = pointFromEvent(e);
    const node = getNodeAt(x, y);
    if (node) {
      try { canvasEl.setPointerCapture(e.pointerId); } catch {}
      activePointerId = e.pointerId;
      dragNode = node;
      dragStartX = x;
      dragStartY = y;
      didDrag = false;
      window.addEventListener('pointermove', onWindowPointerMove);
      window.addEventListener('pointerup', onWindowPointerUp);
      window.addEventListener('pointercancel', onWindowPointerUp);
    }
  }

  function endDrag() {
    if (!dragNode) return;
    if (!didDrag && dragNode.page) {
      selectPage(dragNode.page);
      render();
    }
    dragNode.fixed = false;
    dragNode = null;
    if (canvasEl) canvasEl.style.cursor = hoveredNode ? 'grab' : 'default';
    if (canvasEl && activePointerId !== null) {
      try { canvasEl.releasePointerCapture(activePointerId); } catch {}
    }
    activePointerId = null;
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerUp);
  }

  function pageMatches(p: WikiPage): boolean {
    return matchesSearch([p.title, p.snippet, p.namespace, p.id, p.tags.join(' ')], query);
  }

  function nodeQueryHit(node: GraphNode): boolean {
    if (!query.trim()) return true;
    if (node.type === 'page') return !!node.page && pageMatches(node.page);
    return matchesSearch([node.label], query);
  }

  // Hits only — no 1-hop neighbours. A neighbour that does not contain the
  // terms must not stay on screen.
  function visibleIds(): Set<string> | null {
    if (!query.trim()) return null;
    const hits = new Set<string>();
    for (const n of nodes) {
      if (nodeQueryHit(n)) hits.add(n.id);
    }
    return hits;
  }

  let results = $derived(query.trim() ? allPages.filter(pageMatches) : []);

  function selectPage(page: WikiPage) { selectedResult = page; }

  function pagePreviewHtml(page: WikiPage): string {
    const raw = (page.content || page.snippet || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    return marked.parse(raw, { async: false }) as string;
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      query = '';
      render();
      return;
    }
    if (e.key !== 'Enter') return;
    if (results[0]) selectPage(results[0]);
  }

  // render() paints the pinned ground every frame, but only once a frame runs.
  // Pin the ELEMENT's background from the same constant so the box is never the
  // live-themed pane colour — before the first frame, or if render bails early.
  // An $effect, not onMount: the canvas mounts inside an {#if}, later than this.
  $effect(() => { if (canvasEl) canvasEl.style.background = HARBOUR_GRAPH_THEME.bg; });

  $effect(() => {
    query;
    if (canvasEl && graphReady) render();
  });
</script>

<div class="wiki-pane" bind:this={paneEl}>
  <div class="wiki-controls">
    <div class="view-toggle">
      {#if showsReadouts(labelMode)}
        <span class="page-count">{#if query.trim()}{results.length}/{allPages.length}{:else}{allPages.length} pages{/if}</span>
      {/if}
    </div>
    <input type="text" bind:value={query} onkeydown={onSearchKey} placeholder="Filter nodes…" class="search-input" />
    <div class="action-buttons">
      <button class="action-btn" onclick={cycleColorBy} title="Cycle colour: Branch (top folder), Folder, Tag, or Theme">Colour: {colorLabel}</button>
      {#if !fullscreen}
        <button class="action-btn" onclick={() => vscode.postMessage({ type: 'openMemoryFullscreen' })} title="Open the memory graph in a full editor tab">⛶ Full</button>
      {/if}
      <button class="action-btn" onclick={cycleLabelMode} title="Label density: Hubs (folders + hover/hits), All, None, or Clean (no text at all — no hover labels, no legend)">Labels: {labelBtnText}</button>
      <button class="action-btn" onclick={changeWikiFolder} title={wikiPath || 'Pick the folder the memory graph scans for .md files'}>Source…</button>
    </div>
  </div>

  <div class="wiki-body">
    <div class="nav-panel" class:split={!!query.trim()}>
      {#if allPages.length === 0}
        <div class="empty-state">No pages in memory</div>
      {:else}
        {#if query.trim()}
          <div class="search-results">
            {#each results as page (page.id)}
              <button class="search-card" class:selected={selectedResult?.id === page.id} onclick={() => selectPage(page)}>
                <div class="card-title">{page.title}</div>
                <div class="card-ns">{page.namespace}</div>
              </button>
            {/each}
            {#if results.length === 0}
              <div class="empty-state">No pages match "{query}"</div>
            {/if}
          </div>
        {/if}
        <div class="graph-stack">
          <canvas
            bind:this={canvasEl}
            class="graph-canvas"
            onpointermove={onCanvasPointerMove}
            onpointerdown={onCanvasPointerDown}
            onwheel={onCanvasWheel}
            oncontextmenu={onCanvasContextMenu}
          ></canvas>
          <div class="graph-zoom">
            <button class="zoom-btn" onclick={() => zoomBy(1.2)} title="Zoom in">+</button>
            <button class="zoom-btn" onclick={() => zoomBy(1 / 1.2)} title="Zoom out">−</button>
            <button class="zoom-btn" onclick={resetView} title="Reset view">⌂</button>
          </div>
          {#if showsReadouts(labelMode)}
            <div class="graph-legend">
              <span class="legend-item">{colorBy === 'branch' ? 'Colour = top folder' : colorBy === 'namespace' ? 'Colour = folder path' : colorBy === 'tag' ? 'Colour = tag' : 'Theme colours · tag size = use'}</span>
              <span class="legend-item link-key"><span class="legend-line"></span> links</span>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if !previewCollapsed}
      <div
        class="resize-handle"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize the read box"
        onpointerdown={onResizeDown}
      ></div>
    {/if}

    <!-- Always on screen, collapsed or open: one line, and the only way back
         into the read box. It names the selected page so a click is enough. -->
    <button
      class="preview-toggle"
      onclick={togglePreview}
      aria-expanded={!previewCollapsed}
      title={previewCollapsed ? 'Show the page preview' : 'Hide the page preview'}
    >
      <span class="preview-chevron">{previewCollapsed ? '▸' : '▾'}</span>
      <span>Preview</span>
      {#if selectedResult}<span class="preview-toggle-page">{selectedResult.title}</span>{/if}
    </button>

    {#if !previewCollapsed}
      {#if selectedResult}
        <div class="preview" style="height: {previewH}px">
          <div class="preview-header">
            <span class="preview-title">{selectedResult.title}</span>
            <span class="preview-date">{selectedResult.updated}</span>
          </div>
          <div class="preview-meta">
            <span class="preview-ns">{selectedResult.namespace}</span>
            {#if selectedResult.tags.length > 0}
              <div class="preview-tags">{#each selectedResult.tags as tag}<span class="tag">{tag}</span>{/each}</div>
            {/if}
          </div>
          <div class="preview-body">{@html pagePreviewHtml(selectedResult)}</div>
        </div>
      {:else}
        <div class="preview empty-preview" style="height: {previewH}px">Select a node or page to preview</div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .wiki-pane { display: flex; flex-direction: column; height: 100%; }
  .wiki-controls { padding: 6px 8px; background: var(--og-surface); flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
  .view-toggle { display: flex; gap: 1px; align-items: center; }
  .page-count { font-size: 10px; color: var(--og-text-muted); margin-left: auto; }
  .search-input { width: 100%; padding: 4px 8px; font-size: 12px; color: var(--og-text); background: var(--og-input-bg); border: 1px solid var(--og-input-border); border-radius: 4px; outline: none; font-family: inherit; }
  .search-input:focus { border-color: var(--og-chat); }
  .search-input::placeholder { color: var(--og-text-muted); }
  .action-buttons { display: flex; gap: 4px; }
  .action-btn { padding: 2px 8px; font-size: 10px; background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border); border-radius: 3px; cursor: pointer; font-family: inherit; }
  .action-btn:hover { background: var(--og-btn-hover); }

  /* Stacked vertically (graph over preview) for the narrow sidebar host. */
  .wiki-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .nav-panel { width: 100%; flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; position: relative; }
  .nav-panel.split { flex-direction: row; align-items: stretch; }
  .graph-stack { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }

  /* Graph canvas */
  .graph-canvas {
    flex: 1;
    width: 100%;
    cursor: default;
    touch-action: none;
    user-select: none;
  }

  .graph-zoom {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    z-index: 2;
  }
  .zoom-btn {
    width: 22px;
    height: 22px;
    padding: 0;
    font-size: 13px;
    line-height: 1;
    background: var(--og-btn-bg);
    color: var(--og-text);
    border: 1px solid var(--og-border);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }
  .zoom-btn:hover { background: var(--og-btn-hover); }

  .graph-legend {
    display: flex;
    gap: 12px;
    padding: 4px 8px;
    background: var(--og-surface);
    border-top: 1px solid var(--og-border);
    flex-shrink: 0;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 9px;
    color: var(--og-text-muted);
  }

  .legend-line {
    width: 12px;
    height: 0;
    border-top: 1.5px solid var(--og-accent);
    opacity: 0.6;
  }
  .link-key { margin-left: auto; }

  .search-results { flex: 0 0 38%; min-width: 118px; max-width: 240px; overflow-y: auto; padding: 4px; border-right: 1px solid var(--og-border); background: var(--og-surface); }
  .search-card { display: block; width: 100%; padding: 6px 8px; margin-bottom: 3px; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 4px; color: var(--og-text); cursor: pointer; text-align: left; font-family: inherit; }
  .search-card:hover { border-color: var(--og-chat); }
  .search-card.selected { border-color: var(--og-chat); border-left: 3px solid var(--og-chat); }
  .card-title { font-size: 12px; font-weight: 700; }
  .card-ns { font-size: 10px; color: var(--og-text-muted); font-family: var(--vscode-editor-font-family, monospace); }
  .tag { font-size: 9px; padding: 2px 6px; background: var(--og-surface-alt); color: var(--og-text-muted); border-radius: 3px; }

  /* Draggable divider between the graph and the read box. */
  .resize-handle {
    flex: 0 0 auto;
    height: 7px;
    cursor: ns-resize;
    background: var(--og-border);
    opacity: 0.5;
    touch-action: none;
  }
  .resize-handle:hover { opacity: 1; background: var(--og-accent); }

  /* The read box's header — the whole of what the preview costs while it is
     collapsed, and the control that opens it. One line, always present. */
  .preview-toggle { display: flex; align-items: center; gap: 6px; width: 100%; flex: 0 0 auto; padding: 4px 8px; background: var(--og-surface); color: var(--og-text-muted); border: none; border-top: 1px solid var(--og-border); font-family: inherit; font-size: 10px; text-align: left; cursor: pointer; }
  .preview-toggle:hover { color: var(--og-text); }
  .preview-chevron { font-size: 9px; }
  /* The selected page's title, so the collapsed header still says WHAT one
     click would open. Truncates rather than wrapping the row to two lines. */
  .preview-toggle-page { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--og-text); }

  /* Preview — height is drag-controlled via an inline style (previewH). */
  .preview { width: 100%; flex: 0 0 auto; min-height: 0; overflow-y: auto; padding: 12px; }
  .empty-preview { display: flex; align-items: center; justify-content: center; color: var(--og-text-muted); font-style: italic; font-size: 12px; width: 100%; flex: 0 0 auto; }
  .preview-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .preview-title { font-size: 15px; font-weight: 700; color: var(--og-text); }
  .preview-date { font-size: 10px; color: var(--og-text-muted); }
  .preview-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--og-border); }
  .preview-ns { font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); color: var(--og-text-muted); }
  .preview-tags { display: flex; gap: 3px; }
  .preview-body { font-size: 12px; line-height: 1.6; color: var(--og-text-secondary); white-space: normal; }
  .preview-body :global(h1) { font-size: 16px; font-weight: 700; color: var(--og-text); margin: 0 0 8px; }
  .preview-body :global(h2) { font-size: 14px; font-weight: 700; color: var(--og-text); margin: 12px 0 6px; }
  .preview-body :global(h3) { font-size: 13px; font-weight: 600; color: var(--og-text); margin: 10px 0 4px; }
  .preview-body :global(p) { margin: 0 0 8px; }
  .preview-body :global(ul), .preview-body :global(ol) { margin: 0 0 8px; padding-left: 18px; }
  .preview-body :global(code) { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .preview-body :global(pre) { overflow-x: auto; padding: 8px; background: var(--og-surface); border-radius: 4px; }
  .empty-state { padding: 24px; color: var(--og-text-muted); font-style: italic; text-align: center; font-size: 12px; flex: 1; display: flex; align-items: center; justify-content: center; }
</style>
