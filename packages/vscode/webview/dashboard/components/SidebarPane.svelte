<script lang="ts">
  // In-dashboard sidebar — session status.
  // All in Origami branding, not VS Code native chrome.
  // V1 is single-coder: no multi-agent roster lives here.

  let collapsed = $state(false);

  import { getVsCodeApi } from '../../shared/vscodeApi';
  const vscode = getVsCodeApi();

  interface SessionInfo {
    id: string;
    number: number;
    agentName: string;
  }

  let openSessions: SessionInfo[] = $state([]);
  let activeSessionId: string | null = $state(null);

  function closeSession(sid: string) {
    vscode.postMessage({ type: 'closeSession', sessionId: sid });
  }

  // Listen for data from extension host
  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'sessionCreated') {
      openSessions = [...openSessions, {
        id: msg.sessionId,
        number: msg.sessionNumber,
        agentName: msg.agentName || 'Agent',
      }];
      activeSessionId = msg.sessionId;
    }
    if (msg.type === 'sessionClosed') {
      openSessions = openSessions.filter(s => s.id !== msg.sessionId);
      if (activeSessionId === msg.sessionId) {
        activeSessionId = openSessions.length > 0 ? openSessions[openSessions.length - 1].id : null;
      }
    }
  });
</script>

{#if !collapsed}
  <div class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">Origami</span>
      <button class="collapse-btn" onclick={() => collapsed = true} title="Collapse sidebar">
        &lsaquo;
      </button>
    </div>

    <!-- Sessions -->
    <div class="section">
      <div class="section-label">Sessions</div>
      {#if openSessions.length === 0}
        <div class="empty-hint">No sessions</div>
      {:else}
        {#each openSessions as s (s.id)}
          <div class="session-row" class:active={s.id === activeSessionId}>
            <span class="session-label">#{s.number} {s.agentName}</span>
            {#if openSessions.length > 1}
              <button class="session-close" onclick={() => closeSession(s.id)} title="Close session">&times;</button>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{:else}
  <div class="sidebar-collapsed">
    <button class="expand-btn" onclick={() => collapsed = false} title="Expand sidebar">
      &rsaquo;
    </button>
  </div>
{/if}

<style>
  .sidebar {
    width: 200px;
    min-width: 200px;
    background: var(--og-surface);
    border-right: 1px solid var(--og-border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .sidebar-collapsed {
    width: 28px;
    min-width: 28px;
    background: var(--og-surface);
    border-right: 1px solid var(--og-border);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 8px;
    flex-shrink: 0;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--og-border);
  }

  .sidebar-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--og-text-secondary);
  }

  .collapse-btn, .expand-btn {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 16px;
    padding: 2px 4px;
    border-radius: 3px;
    line-height: 1;
  }

  .collapse-btn:hover, .expand-btn:hover {
    background: var(--og-btn-bg);
    color: var(--og-text);
  }

  .section {
    padding: 8px 10px;
    border-bottom: 1px solid var(--og-border);
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--og-text-muted);
    margin-bottom: 6px;
  }

  .empty-hint {
    font-size: 11px;
    color: var(--og-text-muted);
    font-style: italic;
    padding: 2px 4px;
  }

  .session-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 4px;
    border-radius: 3px;
    font-size: 11px;
  }

  .session-row.active {
    background: var(--og-btn-bg);
  }

  .session-label {
    color: var(--og-text-secondary);
    font-weight: 500;
  }

  .session-row.active .session-label {
    color: var(--og-text);
  }

  .session-close {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 12px;
    padding: 0 3px;
    border-radius: 2px;
    line-height: 1;
  }

  .session-close:hover {
    background: var(--og-error);
    color: white;
  }
</style>
