// Status bar item — shows agent, model, context %, and permission mode.
// Sits in the left side of the VS Code status bar.

import * as vscode from 'vscode';

export class StatusBarController {
  private item: vscode.StatusBarItem;
  // S7 — a SECOND item for the Agent Manager fleet aggregate ("Agents: N running
  // - M need you"). Separate from the main item because it clicks THROUGH to the
  // board, not the chat sidebar; hidden until the board has live work.
  private agentsItem: vscode.StatusBarItem;
  private agentName = '';
  private modelName = '';
  private contextPct = 0;
  private mode = 'default';
  private reasoning = 'normal';
  // Phase M3 rectification — VRAM pressure surfaced in the main status item
  private vramPct = 0;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    // Clicking the status item focuses the Origami crane chat panel.
    this.item.command = 'origami.toggleSidebar';
    this.setDisconnected();
    this.item.show();
    // The fleet-aggregate item sits just to the right of the main item and opens
    // the Agent Manager board on click. Starts hidden (setAgents shows it).
    this.agentsItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99,
    );
    this.agentsItem.command = 'origami.openAgentManager';
  }

  /** S7 — the Agent Manager fleet aggregate. `text` = the label to show (e.g.
   *  "Agents: 2 running · 1 need you"), or null to HIDE the item when the board
   *  has no live work. Updated on every board broadcast. */
  setAgents(text: string | null): void {
    if (!text) {
      this.agentsItem.hide();
      return;
    }
    this.agentsItem.text = `$(organization) ${text}`;
    this.agentsItem.tooltip = 'Origami Agent Manager — click to open the board';
    this.agentsItem.show();
  }

  setConnected(agentName: string): void {
    this.agentName = agentName;
    this.render();
  }

  setAgent(agentName: string): void {
    this.agentName = agentName;
    this.render();
  }

  setModel(modelName: string): void {
    this.modelName = modelName;
    this.render();
  }

  setContext(used: number, total: number): void {
    this.contextPct = total > 0 ? Math.round((used / total) * 100) : 0;
    this.render();
  }

  setMode(mode: string): void {
    this.mode = mode;
    this.render();
  }

  setReasoning(mode: string): void {
    this.reasoning = mode;
    this.render();
  }

  /// Phase M3 rectification — update VRAM usage percentage (0-100). Clamped.
  setVram(pct: number): void {
    this.vramPct = Math.max(0, Math.min(100, Math.round(pct)));
    this.render();
  }

  setDisconnected(): void {
    this.agentName = '';
    this.modelName = '';
    this.contextPct = 0;
    this.mode = 'default';
    this.reasoning = 'normal';
    this.vramPct = 0;
    this.item.text = '$(hubot) Origami';
    this.item.tooltip = 'Origami — disconnected (click to open the chat panel)';
    this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  }

  setError(message: string): void {
    this.item.text = '$(error) Origami';
    this.item.tooltip = `Origami — ${message}`;
    this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
  }

  private render(): void {
    const parts: string[] = [`$(hubot) ${this.agentName || 'Origami'}`];

    if (this.modelName) {
      // Shorten model name for status bar (take last segment after /)
      const short = this.modelName.includes('/')
        ? this.modelName.split('/').pop()!
        : this.modelName;
      parts.push(short);
    }

    if (this.contextPct > 0) {
      parts.push(`ctx ${this.contextPct}%`);
    }

    // Phase M3 rectification — VRAM pressure in the status bar
    if (this.vramPct > 0) {
      parts.push(`vram ${this.vramPct}%`);
    }

    if (this.reasoning !== 'normal') {
      parts.push(this.reasoning.toUpperCase());
    }

    if (this.mode !== 'default') {
      parts.push(this.mode.toUpperCase());
    }

    this.item.text = parts.join(' | ');

    // Color by context pressure
    if (this.contextPct >= 80) {
      this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
    } else if (this.contextPct >= 60) {
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    } else {
      this.item.color = undefined;
    }

    // Tooltip
    const tips = [`Agent: ${this.agentName || '(none)'}`];
    if (this.modelName) tips.push(`Model: ${this.modelName}`);
    if (this.contextPct > 0) tips.push(`Context: ${this.contextPct}%`);
    if (this.vramPct > 0) tips.push(`VRAM: ${this.vramPct}%`);
    if (this.reasoning !== 'normal') tips.push(`Reasoning: ${this.reasoning}`);
    if (this.mode !== 'default') tips.push(`Mode: ${this.mode}`);
    this.item.tooltip = `Origami — ${tips.join(' · ')}`;
  }

  dispose(): void {
    this.item.dispose();
    this.agentsItem.dispose();
  }
}
