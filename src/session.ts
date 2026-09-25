// One conversation: owns the claude.exe process (via the Agent SDK), the
// transcript, pending permission prompts, and the status shown in the panel.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  query,
  getSessionMessages,
  listSubagents,
  getSubagentMessages,
  getSessionInfo,
  type Query,
  type Options,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
  type CanUseTool,
} from '@anthropic-ai/claude-agent-sdk';
import { Transcript, describeForPermission } from './transcript';
import type { HostToView, Item, Status, ViewConfig, ViewToHost, Question } from './shared/protocol';
import type { WarmPool } from './warm';
import { readConfig, log, claudeExecutable } from './config';

type Pending =
  | { kind: 'permission'; threadId: string; input: any; suggestions: PermissionUpdate[]; resolve: (r: PermissionResult) => void }
  | { kind: 'question'; threadId: string; input: any; resolve: (r: PermissionResult) => void }
  | { kind: 'plan'; threadId: string; input: any; resolve: (r: PermissionResult) => void };

const VSCODE_CONTEXT = `# VS Code panel context
You are running inside a custom VS Code panel. The user reads only your text messages: tool calls, diffs and command output are hidden from them, so put every result they need in your prose.
When referencing files or code locations, use markdown links with workspace-relative paths so they are clickable: [file.ts](src/file.ts), [file.ts:42](src/file.ts#L42). The panel renders LaTeX math written with $...$ and $$...$$.`;

/** Everything a session needs from the SDK callbacks, bound late so a pre-warmed process can be adopted. */
export interface SessionHooks {
  canUseTool: CanUseTool;
  stderr: (data: string) => void;
}

export function buildOptions(cwd: string, hooks: () => SessionHooks | undefined, extra: Partial<Options> = {}): Options {
  const cfg = readConfig();
  const opts: Options = {
    cwd,
    includePartialMessages: true,
    forwardSubagentText: true,
    perTaskStopAffordance: true,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: VSCODE_CONTEXT },
    canUseTool: (name, input, ctx) => {
      const h = hooks();
      return h ? h.canUseTool(name, input, ctx) : Promise.resolve({ behavior: 'deny', message: 'No panel attached.' });
    },
    stderr: (d) => hooks()?.stderr(d),
    ...extra,
  };
  const exe = claudeExecutable();
  if (exe && fs.existsSync(exe)) opts.pathToClaudeCodeExecutable = exe;
  if (cfg.initialModel && !opts.model) opts.model = cfg.initialModel;
  if (cfg.initialPermissionMode && !opts.permissionMode) opts.permissionMode = cfg.initialPermissionMode as Options['permissionMode'];
  return opts;
}

function claudeUserSetting(key: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'))[key];
  } catch {
    return undefined;
  }
}

function permissionLabel(u: PermissionUpdate): string {
  const where = (d: string) =>
    ({ session: 'for this session', localSettings: 'in this project (local)', projectSettings: 'in this project (shared)', userSettings: 'everywhere' } as Record<string, string>)[d] ?? d;
  switch (u.type) {
    case 'addRules':
    case 'replaceRules':
      return `Always allow ${u.rules.map((r) => r.toolName + (r.ruleContent ? `(${r.ruleContent})` : '')).join(', ')} ${where(u.destination)}`;
    case 'setMode':
      return `Switch to ${u.mode} mode ${where(u.destination)}`;
    case 'addDirectories':
      return `Allow access to ${u.directories.join(', ')} ${where(u.destination)}`;
    default:
      return `${u.type} ${where((u as any).destination)}`;
  }
}

export class ChatSession {
  readonly transcript: Transcript;
  status: Status;
  private q?: Query;
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private pending = new Map<string, Pending>();
  private disposed = false;
  private viewReady = false;
  private outbox: HostToView[] = [];
  private titleFetched = false;

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly cwd: string,
    private warm: WarmPool,
    private resumeId?: string,
  ) {
    this.transcript = new Transcript((m) => this.post(m));
    this.status = { models: [], commands: [], remote: { state: 'off' }, busy: false, starting: true, sessionId: resumeId, cwd };
    panel.webview.onDidReceiveMessage((m: ViewToHost) => this.onView(m).catch((e) => this.fail(e)));
    panel.onDidDispose(() => this.dispose());
  }

  get sessionId() {
    return this.status.sessionId;
  }

  /** Load stored history (when resuming) and start the claude.exe process. */
  async start() {
    if (this.resumeId) await this.loadHistory(this.resumeId);
    this.spawn();
  }

  private async loadHistory(id: string) {
    try {
      const info = await getSessionInfo(id, { dir: this.cwd });
      if (info) this.setTitle(info.customTitle || info.summary);
      const main = await getSessionMessages(id, { dir: this.cwd });
      for (const m of main) this.transcript.handle(m, true);
      for (const agentId of await listSubagents(id, { dir: this.cwd })) {
        for (const m of await getSubagentMessages(id, agentId, { dir: this.cwd })) this.transcript.handle(m, true);
      }
      for (const t of this.transcript.threads.values()) if (t.status === 'running') this.transcript.updateThread(t.id, { status: 'done' });
    } catch (e) {
      this.transcript.notice('main', 'error', `Could not load history: ${(e as Error).message}`);
    }
  }

  private hooks = (): SessionHooks => ({
    canUseTool: (name, input, ctx) => this.canUseTool(name, input, ctx),
    stderr: (d) => log(`[${this.sessionId ?? 'new'}] ${d.trimEnd()}`),
  });

  private spawn() {
    this.status.starting = true;
    this.pushStatus();
    const input = this.inputStream();
    const warm = this.resumeId ? undefined : this.warm.take(this.cwd, this.hooks());
    this.q = warm
      ? warm.query(input)
      : query({ prompt: input, options: buildOptions(this.cwd, this.hooks, this.resumeId ? { resume: this.resumeId } : {}) });
    this.warm.refillSoon(this.cwd);
    void this.consume(this.q!);
    void this.loadControls();
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.disposed) {
      while (this.queue.length) yield this.queue.shift()!;
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  private async consume(q: Query) {
    try {
      for await (const m of q) {
        if (this.disposed) break;
        this.onMessage(m);
      }
    } catch (e) {
      if (!this.disposed) this.fail(e);
    } finally {
      if (this.q === q) this.q = undefined;
      if (!this.disposed) {
        this.setBusy(false);
        this.status.starting = false;
        this.pushStatus();
      }
    }
  }

  private onMessage(m: any) {
    if (m.type === 'system' && m.subtype === 'init') {
      this.status.sessionId = m.session_id;
      this.resumeId = m.session_id; // a restart continues this conversation
      this.status.model = m.model;
      this.status.permissionMode = m.permissionMode;
      this.status.version = m.claude_code_version;
      this.status.starting = false;
      if (Array.isArray(m.slash_commands)) this.status.commands = m.slash_commands;
      this.setBusy(true);
    } else if (m.type === 'result') {
      this.onTurnEnd(m);
    } else if (m.type === 'rate_limit_event') {
      const w = m.rate_limit_info?.unifiedWindows;
      if (w) {
        this.status.rateLimits = {
          fiveHour: w.five_hour && { utilization: Math.round(w.five_hour.utilization * 100), resetsAt: w.five_hour.resetsAt },
          sevenDay: w.seven_day && { utilization: Math.round(w.seven_day.utilization * 100), resetsAt: w.seven_day.resetsAt },
        };
        this.pushStatus();
      }
    } else if (m.type === 'system' && m.subtype === 'bridge_state') {
      this.status.remote = { ...this.status.remote, state: m.state === 'ready' || m.state === 'connected' ? 'on' : m.state === 'failed' ? 'error' : this.status.remote.state };
      this.pushStatus();
    } else if (m.type === 'system' && m.subtype === 'status' && m.permissionMode) {
      this.status.permissionMode = m.permissionMode;
      this.pushStatus();
    }
    this.transcript.handle(m);
  }

  private onTurnEnd(m: any) {
    const u = m.usage;
    if (u) {
      const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (total > 0) this.status.cacheHitPercent = Math.round((100 * (u.cache_read_input_tokens ?? 0)) / total);
    }
    this.setBusy(false);
    void this.refreshContext();
    if (!this.titleFetched) void this.fetchTitle();
  }

  private setBusy(busy: boolean) {
    this.status.busy = busy;
    this.transcript.setMainRunning(busy);
    this.pushStatus();
  }

  private async loadControls() {
    const q = this.q;
    if (!q) return;
    try {
      const [models, commands] = await Promise.all([q.supportedModels(), q.supportedCommands()]);
      this.status.models = models.map((x: any) => ({
        value: x.value,
        displayName: x.displayName,
        description: x.description,
        effortLevels: x.supportsEffort ? (x.supportedEffortLevels ?? []) : [],
      }));
      this.status.commands = commands.map((c: any) => c.name);
      await this.refreshSettings();
      this.status.starting = false;
      this.pushStatus();
      const cfg = readConfig();
      const rc = cfg.remoteControl === 'auto' ? claudeUserSetting('remoteControlAtStartup') === true : cfg.remoteControl === 'on';
      if (rc) await this.setRemote(true);
      await this.refreshContext();
    } catch (e) {
      log(`loadControls: ${(e as Error).message}`);
    }
  }

  private async refreshSettings() {
    const s: any = await (this.q as any)?.getSettings?.();
    if (!s) return;
    if (s.applied?.model) this.status.model = s.applied.model;
    this.status.effort = s.applied?.effort ?? null;
    const match = this.status.models.find((m) => m.value === this.status.modelChoice);
    if (!match) {
      const byResolved = this.status.models.find((m: any) => m.value === s.applied?.model);
      if (byResolved) this.status.modelChoice = byResolved.value;
    }
  }

  private async refreshContext() {
    try {
      const c: any = await this.q?.getContextUsage({ detail: 'summary' });
      if (!c) return;
      this.status.contextPercent = c.percentage;
      this.status.contextTokens = c.totalTokens;
      this.status.contextMax = c.maxTokens;
      this.status.contextBreakdown = (c.categories ?? []).filter((x: any) => x.kind !== 'deferred').map((x: any) => ({ name: x.name, tokens: x.tokens }));
      this.pushStatus();
    } catch (e) {
      log(`context: ${(e as Error).message}`);
    }
  }

  private async fetchTitle() {
    if (!this.sessionId) return;
    try {
      const info = await getSessionInfo(this.sessionId, { dir: this.cwd });
      const title = info?.customTitle || info?.summary;
      if (title) {
        this.titleFetched = true;
        this.setTitle(title);
      }
    } catch {
      /* title is cosmetic */
    }
  }

  private setTitle(title: string | undefined) {
    if (!title) return;
    this.status.title = title;
    this.panel.title = title.length > 40 ? title.slice(0, 39) + '…' : title;
    this.pushStatus();
  }

  // ---- permissions, questions, plans -------------------------------------

  private canUseTool: CanUseTool = (toolName, input, ctx) => {
    const threadId = this.transcript.threadForAgent(ctx.agentID);
    const id = this.transcript.nextId('ask');
    return new Promise<PermissionResult>((resolve) => {
      let item: Item;
      if (toolName === 'AskUserQuestion') {
        item = { kind: 'question', id, questions: ((input as any).questions ?? []) as Question[], state: 'pending' };
        this.pending.set(id, { kind: 'question', threadId, input, resolve });
      } else if (toolName === 'ExitPlanMode') {
        item = { kind: 'plan', id, plan: String((input as any).plan ?? ''), state: 'pending' };
        this.pending.set(id, { kind: 'plan', threadId, input, resolve });
      } else {
        const suggestions = ctx.suggestions ?? [];
        item = { kind: 'permission', id, tool: toolName, detail: describeForPermission(toolName, input), suggestions: suggestions.map(permissionLabel), state: 'pending' };
        this.pending.set(id, { kind: 'permission', threadId, input, suggestions, resolve });
      }
      this.transcript.put(threadId, item);
      ctx.signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        this.transcript.put(threadId, { ...item, state: 'cancelled' } as Item);
        resolve({ behavior: 'deny', message: 'Cancelled.' });
      });
      if (!this.panel.visible || !this.panel.active) this.panel.reveal(undefined, true);
    });
  };

  private settle(id: string): Pending | undefined {
    const p = this.pending.get(id);
    this.pending.delete(id);
    return p;
  }

  // ---- messages from the webview -----------------------------------------

  private async onView(m: ViewToHost) {
    switch (m.t) {
      case 'ready':
        this.viewReady = true;
        this.post({ t: 'snapshot', snapshot: { ...this.transcript.snapshotParts(), status: this.status, config: readConfig().view } }, true);
        for (const o of this.outbox.splice(0)) this.post(o);
        return;
      case 'send':
        return this.send(m.text);
      case 'interrupt':
        await this.q?.interrupt();
        return;
      case 'stopTask':
        await this.q?.stopTask(m.taskId);
        return;
      case 'permission': {
        const p = this.settle(m.id);
        if (p?.kind !== 'permission') return;
        const item = this.transcript.findItem(p.threadId, m.id);
        if (m.allow) {
          const upd = m.suggestion !== undefined ? [p.suggestions[m.suggestion]] : undefined;
          p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: upd });
          const mode = upd?.find((u) => u.type === 'setMode');
          if (mode && mode.type === 'setMode') this.status.permissionMode = mode.mode;
        } else {
          p.resolve({ behavior: 'deny', message: m.message?.trim() || 'The user denied this action.' });
        }
        if (item) this.transcript.put(p.threadId, { ...item, state: m.allow ? 'allowed' : 'denied' } as Item);
        this.pushStatus();
        return;
      }
      case 'answer': {
        const p = this.settle(m.id);
        if (p?.kind !== 'question') return;
        const item = this.transcript.findItem(p.threadId, m.id);
        if (m.answers) p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers: m.answers } });
        else p.resolve({ behavior: 'deny', message: 'The user declined to answer.' });
        if (item) this.transcript.put(p.threadId, { ...item, state: m.answers ? 'answered' : 'cancelled', answers: m.answers ?? undefined } as Item);
        return;
      }
      case 'plan': {
        const p = this.settle(m.id);
        if (p?.kind !== 'plan') return;
        const item = this.transcript.findItem(p.threadId, m.id);
        if (m.approve) {
          p.resolve({ behavior: 'allow', updatedInput: p.input });
          if (m.mode) await this.setMode(m.mode);
        } else p.resolve({ behavior: 'deny', message: m.feedback?.trim() || 'The user wants to keep planning.' });
        if (item) this.transcript.put(p.threadId, { ...item, state: m.approve ? 'approved' : 'rejected' } as Item);
        return;
      }
      case 'setModel':
        await this.q?.setModel(m.value);
        this.status.modelChoice = m.value;
        await this.refreshSettings();
        this.pushStatus();
        void this.refreshContext();
        return;
      case 'setMode':
        return this.setMode(m.value);
      case 'setEffort':
        await this.q?.applyFlagSettings({ effortLevel: m.value as any });
        await this.refreshSettings();
        this.pushStatus();
        return;
      case 'setRemote':
        return this.setRemote(m.on);
      case 'setConfig':
        await updateViewConfig(m.config);
        return;
      case 'openLink':
        return openLink(m.href, this.cwd);
      case 'findFiles': {
        const files = await findFiles(m.query, this.cwd);
        this.post({ t: 'fileMatches', query: m.query, files });
        return;
      }
      case 'refreshStatus':
        await this.refreshContext();
        return;
      case 'runUpdate':
        await vscode.commands.executeCommand('claudePanel.checkForUpdates');
        return;
    }
  }

  private async setMode(mode: string) {
    await this.q?.setPermissionMode(mode as any);
    this.status.permissionMode = mode;
    this.pushStatus();
  }

  private async setRemote(on: boolean) {
    if (!this.q) return;
    this.status.remote = { state: on ? 'connecting' : 'off' };
    this.pushStatus();
    try {
      const r: any = await (this.q as any).enableRemoteControl(on, on ? this.status.title : undefined);
      this.status.remote = on ? { state: 'on', url: r?.session_url } : { state: 'off' };
    } catch (e) {
      this.status.remote = { state: 'error' };
      this.transcript.notice('main', 'error', `Remote control: ${(e as Error).message}`);
    }
    this.pushStatus();
  }

  send(text: string) {
    if (!text.trim()) return;
    this.transcript.addUser(text);
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.setBusy(true);
    if (!this.q) this.spawn(); // process ended (crash or idle exit): resume the same conversation
    this.wake?.();
  }

  private fail(e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    log(`session error: ${msg}`);
    this.transcript.notice('main', 'error', msg);
    this.setBusy(false);
  }

  // ---- plumbing ------------------------------------------------------------

  pushStatus() {
    this.post({ t: 'status', status: this.status });
  }

  pushConfig(config: ViewConfig) {
    this.post({ t: 'config', config });
  }

  private post(m: HostToView, force = false) {
    if (this.disposed) return;
    if (!this.viewReady && !force) {
      // The snapshot sent on 'ready' already contains the full state.
      if (m.t === 'fileMatches') this.outbox.push(m);
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, p] of this.pending) p.resolve({ behavior: 'deny', message: 'Panel closed.' });
    this.pending.clear();
    this.wake?.();
    try {
      this.q?.close();
    } catch {
      /* already gone */
    }
  }
}

async function updateViewConfig(patch: Partial<ViewConfig>) {
  const c = vscode.workspace.getConfiguration('claudePanel');
  const keys: Record<keyof ViewConfig, string> = { renderMath: 'renderMath', toolActivity: 'toolActivity', showThinking: 'showThinking', enterToSend: 'enterToSend' };
  for (const [k, v] of Object.entries(patch)) await c.update(keys[k as keyof ViewConfig], v, vscode.ConfigurationTarget.Global);
}

async function openLink(href: string, cwd: string) {
  if (/^(https?|mailto):/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const m = href.match(/^(.*?)(?:#L(\d+)(?:-L?(\d+))?)?$/);
  if (!m) return;
  let file = decodeURIComponent(m[1]).replace(/^file:\/\/\/?/, '');
  if (!path.isAbsolute(file)) file = path.join(cwd, file);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const line = m[2] ? Math.max(0, Number(m[2]) - 1) : 0;
  const end = m[3] ? Math.max(line, Number(m[3]) - 1) : line;
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    selection: new vscode.Range(line, 0, end, 0),
    preview: true,
  });
}

async function findFiles(q: string, cwd: string): Promise<string[]> {
  const pattern = q ? `**/*${q.replace(/[\\[\]{}*?]/g, '')}*` : '**/*';
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(cwd, pattern), '**/{node_modules,.git,dist,out}/**', 30);
  return uris.map((u) => path.relative(cwd, u.fsPath).replace(/\\/g, '/')).sort((a, b) => a.length - b.length);
}
