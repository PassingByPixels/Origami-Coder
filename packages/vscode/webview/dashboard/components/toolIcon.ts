// toolIcon.ts — t-yyz5yk (Round 8, rule 3): one line-icon set for tool rows.
//
// The emoji that stood here (`kindIcons` in ToolCard.svelte) drew differently
// per OS and did not take the theme colour. These are 24-unit stroke paths
// drawn with `currentColor`, keyed on the same ACP `kind` as before, with the
// tool name winning where the kind buckets unlike tools together (`task`,
// `browser`, `todowrite`, the artifact tools all arrive as `other`).
// Path data is copied from the Round 8 specimen (mockups/tool-elements).

export const ICON_PATHS = {
  read: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  write: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/>',
  shell: '<path d="M4 6l5 5-5 5"/><path d="M12 18h8"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  send: '<path d="M21 3L3 10.5l7 2.5 2.5 7z"/><path d="M21 3L10 13"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>',
  browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z"/>',
  click: '<path d="M6 3l12 7-5.2 1.8L10.5 17z"/><path d="M13 12l5 5"/>',
  type: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.5M11 10h.5M15 10h.5M8 14h8"/>',
  shot: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/>',
  task: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="16" r="3"/><path d="M8 11v2a3 3 0 0 0 3 3h2"/>',
  parallel: '<path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="9" r="1.6"/><circle cx="12" cy="14" r="1.6"/><circle cx="19" cy="7" r="1.6"/>',
  artifact: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/><path d="M7 13h6M7 16h4"/><path d="M16 13.5l2 1.5-2 1.5"/>',
  todo: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11"/><circle cx="5" cy="18" r="1.2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  move: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  think: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4M12 16.5v.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  retry: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.2v.3"/>',
  other: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

const BY_TOOL: Record<string, IconName> = {
  task: 'task', task_parallel: 'parallel',
  browser: 'browser',
  write: 'write', write_file: 'write',
  todowrite: 'todo', todo_write: 'todo', todoread: 'todo',
  artifact_get: 'artifact', artifact_publish: 'artifact',
  send_message: 'send',
  bash: 'shell', shell: 'shell', run: 'shell',
  glob: 'search', grep: 'search', list_dir: 'folder',
};
const BY_KIND: Record<string, IconName> = {
  read: 'read', edit: 'edit', search: 'search', execute: 'shell', bash: 'shell',
  filesystem: 'folder', network: 'browser', fetch: 'browser', move: 'move', think: 'think', other: 'other',
};

/** The icon for a row. A `read` that returned a picture is the image glyph. */
export function toolIconName(toolName: string, kind: string, isImage = false): IconName {
  if (isImage) return 'image';
  return BY_TOOL[toolName.toLocaleLowerCase()] ?? BY_KIND[kind] ?? 'other';
}

/** The small action glyph beside the browser globe (Round 8f): which browser
 *  action ran. `undefined` for open/navigate, which the globe alone names. */
export function browserActionIcon(action: string | undefined): IconName | undefined {
  switch ((action ?? '').toLocaleLowerCase()) {
    // The engine's action list (engine/src/tool/browser.ts). It has no `wait`
    // action, so the specimen's clock glyph has no row to sit on here.
    case 'click': case 'hover': case 'drag': return 'click';
    case 'type': return 'type';
    case 'screenshot': return 'shot';
    default: return undefined;
  }
}
