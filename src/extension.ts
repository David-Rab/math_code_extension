import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { listSessions, renameSession, deleteSession, forkSession } from '@anthropic-ai/claude-agent-sdk';
import { ChatSession, type SessionHost } from './session';
import { WarmPool } from './warm';
import { readConfig, log, setBundledExecutable, showLog } from './config';
import { readBuildInfo, fetchLatest, newer, showChangelog, runUpdate, type Latest } from './updates';
import { checkAuth, signIn } from './auth';

const VIEW_TYPE = 'claudePanel.chat';
const sessions = new Set<ChatSession>();
const warm = new WarmPool();
let extUri: vscode.Uri;
let latest: Latest | undefined;
let history: SessionsView;
let lastActive: ChatSession | undefined;

const host: SessionHost = {
  openSession: (id, cwd, prefill) => openPanel(id, cwd, prefill),
  sessionsChanged: () => setTimeout(() => history.refresh(), 500),
};

export function activate(ctx: vscode.ExtensionContext) {
  extUri = ctx.extensionUri;
  log(`activated from ${ctx.extensionPath} (VS Code ${vscode.version})`);
  setBundledExecutable(path.join(ctx.extensionPath, 'dist', 'bin', 'claude.exe'));
  history = new SessionsView();

  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudePanel.newSession', () => openPanel()),
    vscode.commands.registerCommand('claudePanel.openSession', (arg?: SessionEntry | string, cwd?: string) => {
      if (typeof arg === 'string') return openPanel(arg, cwd);
      if (arg?.id) return openPanel(arg.id, arg.cwd);
      return pickSession();
    }),
    vscode.commands.registerCommand('claudePanel.refreshSessions', () => history.refresh()),
    vscode.commands.registerCommand('claudePanel.renameSession', (e?: SessionEntry) => renameCmd(e)),
    vscode.commands.registerCommand('claudePanel.forkSession', (e?: SessionEntry) => forkCmd(e)),
    vscode.commands.registerCommand('claudePanel.deleteSession', (e?: SessionEntry) => deleteCmd(e)),
    vscode.commands.registerCommand('claudePanel.agentMap', () => lastActive?.panel.webview.postMessage({ t: 'showAgentMap' })),
    vscode.commands.registerCommand('claudePanel.signIn', () => signIn()),
    vscode.commands.registerCommand('claudePanel.toggleMath', () => {
      const c = vscode.workspace.getConfiguration('claudePanel');
      return c.update('renderMath', !c.get('renderMath', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('claudePanel.checkForUpdates', () => checkForUpdates(ctx, true)),
    vscode.commands.registerCommand('claudePanel.showLog', showLog),
    vscode.window.registerTreeDataProvider('claudePanel.sessions', history),
    // VS Code restores open panels when a window is reopened or reloaded;
    // the saved state carries the session id.
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state: any) {
        attach(panel, state?.cwd ? normalizeCwd(state.cwd) : defaultCwd(), state?.sessionId);
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudePanel')) return;
      const view = readConfig().view;
      for (const s of sessions) s.pushConfig(view);
    }),
    { dispose: () => warm.dispose() },
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(comment-discussion) Claude';
  status.tooltip = 'New Claude Panel session';
  status.command = 'claudePanel.newSession';
  status.show();
  ctx.subscriptions.push(status);

  // Start a spare claude.exe now so the first session opens quickly.
  warm.fill(defaultCwd());
  void checkAuth().then((a) => log(`signed in: ${a?.loggedIn ?? 'unknown'}`));
  if (readConfig().checkForUpdates) setTimeout(() => void checkForUpdates(ctx, false), 15000);
}

export function deactivate() {
  for (const s of sessions) s.dispose();
  warm.dispose();
}

/**
 * VS Code reports Windows paths with a lowercase drive letter; a terminal gives
 * "C:". Claude Code keys folder trust by the exact spelling, so use the
 * terminal form or a folder trusted from the terminal looks untrusted here.
 */
function normalizeCwd(p: string): string {
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}

function defaultCwd(): string {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return normalizeCwd(folder?.uri.fsPath ?? os.homedir());
}

function openPanel(resumeId?: string, cwd = defaultCwd(), prefill?: string) {
  cwd = normalizeCwd(cwd);
  if (resumeId) {
    const open = [...sessions].find((s) => s.sessionId === resumeId);
    if (open) return open.panel.reveal();
  }
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    'Claude',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableFindWidget: true, retainContextWhenHidden: true },
  );
  attach(panel, cwd, resumeId, prefill);
}

function attach(panel: vscode.WebviewPanel, cwd: string, resumeId?: string, prefill?: string) {
  const root = vscode.Uri.joinPath(extUri, 'dist', 'webview');
  panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
  panel.iconPath = vscode.Uri.joinPath(extUri, 'resources', 'icon.svg');
  panel.webview.html = html(panel.webview, root);
  log(`panel opened: cwd=${cwd} resume=${resumeId ?? '-'}`);
  const s = new ChatSession(panel, cwd, warm, host, resumeId, prefill);
  sessions.add(s);
  const track = () => {
    if (panel.active) lastActive = s;
  };
  track();
  panel.onDidChangeViewState(track);
  panel.onDidDispose(() => {
    sessions.delete(s);
    if (lastActive === s) lastActive = undefined;
    history.refresh();
  });
  if (latest) markUpdate(s);
  void s.start().then(() => history.refresh());
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, f));
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: https:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('katex.min.css')}">
<link rel="stylesheet" href="${uri('style.css')}">
</head><body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body></html>`;
}

// --- previous sessions ------------------------------------------------------

interface SessionEntry {
  id: string;
  title: string;
  cwd: string;
  modified: number;
}

async function recentSessions(): Promise<SessionEntry[]> {
  const folders = vscode.workspace.workspaceFolders?.map((f) => normalizeCwd(f.uri.fsPath)) ?? [os.homedir()];
  const out: SessionEntry[] = [];
  for (const dir of folders) {
    try {
      for (const s of await listSessions({ dir, limit: 80 }))
        out.push({ id: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || s.sessionId, cwd: dir, modified: s.lastModified });
    } catch (e) {
      log(`listSessions(${dir}): ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

async function pickSession(placeHolder = 'Open a previous Claude session'): Promise<SessionEntry | undefined> {
  const items = (await recentSessions()).map((s) => ({ label: s.title, description: ago(s.modified), s }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
  if (pick && placeHolder.startsWith('Open')) openPanel(pick.s.id, pick.s.cwd);
  return pick?.s;
}

/** The session a command applies to: the clicked sidebar item, else the active panel, else ask. */
async function target(e: SessionEntry | undefined, verb: string): Promise<SessionEntry | undefined> {
  if (e?.id) return e;
  const s = lastActive;
  if (s?.sessionId) return { id: s.sessionId, title: s.status.title ?? 'this session', cwd: s.cwd, modified: Date.now() };
  return pickSession(`Choose a session to ${verb}`);
}

async function renameCmd(e?: SessionEntry) {
  const t = await target(e, 'rename');
  if (!t) return;
  const title = await vscode.window.showInputBox({ prompt: 'New session name', value: t.title, validateInput: (v) => (v.trim() ? null : 'Enter a name') });
  if (!title?.trim()) return;
  await renameSession(t.id, title.trim(), { dir: t.cwd });
  for (const s of sessions) if (s.sessionId === t.id) s.setTitleFromHost(title.trim());
  history.refresh();
}

async function forkCmd(e?: SessionEntry) {
  const t = await target(e, 'fork');
  if (!t) return;
  const r = await forkSession(t.id, { dir: t.cwd });
  openPanel(r.sessionId, t.cwd);
  history.refresh();
}

async function deleteCmd(e?: SessionEntry) {
  const t = await target(e, 'delete');
  if (!t) return;
  const choice = await vscode.window.showWarningMessage(
    `Delete the session “${t.title}”?`,
    { modal: true, detail: 'Its conversation history is removed permanently. Files Claude changed are not affected.' },
    'Delete',
  );
  if (choice !== 'Delete') return;
  for (const s of [...sessions]) if (s.sessionId === t.id) s.panel.dispose();
  await deleteSession(t.id, { dir: t.cwd });
  history.refresh();
}

class SessionsView implements vscode.TreeDataProvider<SessionEntry> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  refresh() {
    this.changed.fire();
  }
  getTreeItem(s: SessionEntry): vscode.TreeItem {
    const open = [...sessions].some((x) => x.sessionId === s.id);
    const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
    item.description = (open ? 'open · ' : '') + ago(s.modified);
    item.tooltip = `${s.title}\n${new Date(s.modified).toLocaleString()}\n${s.cwd}`;
    item.iconPath = new vscode.ThemeIcon(open ? 'comment-discussion' : 'comment');
    item.contextValue = 'session';
    item.command = { command: 'claudePanel.openSession', title: 'Open', arguments: [s] };
    return item;
  }
  getChildren(): Promise<SessionEntry[]> {
    return recentSessions();
  }
}

// --- updates ----------------------------------------------------------------

function markUpdate(s: ChatSession) {
  const info = readBuildInfo(extUri.fsPath);
  if (!latest || !info) return;
  s.status.update = { latest: latest.claudeCodeVersion, current: info.claudeCodeVersion };
  s.pushStatus();
}

async function checkForUpdates(ctx: vscode.ExtensionContext, manual: boolean) {
  const info = readBuildInfo(ctx.extensionPath);
  if (!info) return;
  const l = await fetchLatest();
  if (!l) {
    if (manual) void vscode.window.showWarningMessage('Could not reach npm to check for Claude Code updates.');
    return;
  }
  if (!newer(l.claudeCodeVersion, info.claudeCodeVersion)) {
    if (manual) void vscode.window.showInformationMessage(`Claude Panel is up to date (Claude Code ${info.claudeCodeVersion}).`);
    return;
  }
  latest = l;
  for (const s of sessions) markUpdate(s);
  const choice = await vscode.window.showInformationMessage(
    `Claude Code ${l.claudeCodeVersion} is out — this panel bundles ${info.claudeCodeVersion}.`,
    'What changed?',
    'Update now',
  );
  if (choice === 'What changed?') await showChangelog(info.claudeCodeVersion, l.claudeCodeVersion);
  else if (choice === 'Update now') runUpdate(info, l);
}
