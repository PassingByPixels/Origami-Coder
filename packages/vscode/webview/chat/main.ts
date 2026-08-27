// Chat webview entry point — mounts the CHAT shell (ChatView: a compact
// crane header + honest status badge + the real ChatPane). Importing
// shared/theme.css makes esbuild emit out/webview/chat.css, the sidecar
// the host links so the four :root[data-theme] palettes are defined and
// theme switching repaints independent of the VS Code workbench theme.

import '../shared/theme.css';
import ChatView from './ChatView.svelte';
import { mount } from 'svelte';

const target = document.getElementById('app');
if (target) {
  mount(ChatView, { target });
}
