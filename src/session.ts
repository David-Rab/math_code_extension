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
  forkSession,
  type Query,
  type Options,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
  type CanUseTool,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { Transcript, describeForPermission } from './transcript';
import { knownAuth, onAuthChange, signIn } from './auth';
import { notify } from './notify';
import { trustRoot, isTrusted, neverAsk, rememberNeverAsk } from './trust';
import type { HostToView, ImageAttachment, Item, Status, ViewConfig, ViewToHost, Question } from './shared/protocol';
import type { WarmPool } from './warm';
import { readConfig, log, claudeExecutable } from './config';
import { openLink } from './links';
import { lastUsed, rememberLastUsed, type LastUsed } from './prefs';

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

/** A saved conversation updated more recently than this is probably still open somewhere else. */
const ACTIVE_ELSEWHERE_MS = 5 * 60_000;

/** Permission modes the panel will ever set. Never bypassPermissions. */
const SAFE_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']);

/**
 * The model, effort and permission mode a process starts with. A tab's own
 * picks come first (so a restart keeps them), then the "initial" settings,
 * then what you last picked in any panel. Unset: Claude Code's default.
 */
export function launchSettings(picks: LastUsed = {}): LastUsed {
  const cfg = readConfig();
  const last = lastUsed();
  const model = picks.model ?? (cfg.initialModel || last.model);
  const mode = picks.permissionMode ?? (SAFE_MODES.has(cfg.initialPermissionMode) ? cfg.initialPermissionMode : last.permissionMode);
  return {
    model: model && model !== 'default' ? model : undefined,
    effort: picks.effort ?? last.effort,
    permissionMode: mode && SAFE_MODES.has(mode) ? mode : undefined,
  };
}

export function buildOptions(cwd: string, hooks: () => SessionHooks | undefined, extra: Partial<Options> = {}, picks: LastUsed = {}): Options {
  const start = launchSettings(picks);
  const opts: Options = {
    cwd,
    includePartialMessages: true,
    forwardSubagentText: true,
    perTaskStopAffordance: true,
    enableFileCheckpointing: true, // needed for "rewind code"
    // In VS Code Restricted Mode the folder's own Claude settings (hooks, MCP servers, rules) are never loaded.
    settingSources: vscode.workspace.isTrusted ? ['user', 'project', 'local'] : ['user'],
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
  if (start.model && !opts.model) opts.model = start.model;
  if (start.effort && !opts.effort) opts.effort = start.effort as Options['effort'];
  if (start.permissionMode && !opts.permissionMode) opts.permissionMode = start.permissionMode as Options['permissionMode'];
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
    case 'replaceRules': {
      const verb = u.behavior === 'deny' ? 'Always deny' : u.behavior === 'ask' ? 'Always ask for' : 'Always allow';
      const rules = u.rules.map((r) => r.toolName + (r.ruleContent ? `(${r.ruleContent})` : '')).join(', ');
      return u.type === 'replaceRules'
        ? `Replace all "${u.behavior}" rules ${where(u.destination)} with: ${rules}`
        : `${verb} ${rules} ${where(u.destination)}`;
    }
    case 'setMode':
      return `Switch to ${u.mode} mode ${where(u.destination)}`;
    case 'addDirectories':
      return `Allow access to ${u.directories.join(', ')} ${where(u.destination)}`;
    default:
      return `${u.type} ${where((u as any).destination)}`;
  }
}

/** What a session needs from the extension around it. */
export interface SessionHost {
  openSession(sessionId: string | undefined, cwd: string, prefill?: string): void;
  sessionsChanged(): void;
  saveReport(session: ChatSession, text: string, images: ImageAttachment[]): Promise<void>;
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
/** Images from the webview: only the supported types, bounded in size and number. */
function validImages(images: ImageAttachment[] | undefined): ImageAttachment[] {
  return (Array.isArray(images) ? images : [])
    .filter((i) => typeof i?.mediaType === 'string' && IMAGE_TYPES.test(i.mediaType) && typeof i.data === 'string' && i.data.length < 7_000_000)
    .slice(0, 10);
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

  private signInItem?: string;
  private trustItem?: string;
  private trustGranted?: string; // folder to attest on the next launch
  private trustRootDir?: string;
  private subs: vscode.Disposable[] = [];
  /** What you picked in this tab; a restarted process starts with it again. */
  private picks: LastUsed = {};

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly cwd: string,
    private warm: WarmPool,
    private host: SessionHost,
    private resumeId?: string,
    private prefill?: string,
  ) {
    this.transcript = new Transcript((m) => this.post(m));
    this.status = { models: [], commands: [], remote: { state: 'off' }, busy: false, starting: true, sessionId: resumeId, cwd };
    panel.webview.onDidReceiveMessage((m: ViewToHost) => this.onView(m).catch((e) => this.fail(e)));
    panel.onDidDispose(() => this.dispose());
    this.subs.push(onAuthChange((a) => (a.loggedIn ? this.onSignedIn() : this.needSignIn('You are signed out of Claude.'))));
  }

  get sessionId() {
    return this.status.sessionId;
  }

  /**
   * Load stored history (when resuming) and start the claude.exe process. A
   * reopened session that is not on screen (e.g. restored with the window)
   * starts its process only when you first look at it.
   */
  async start() {
    if (knownAuth()?.loggedIn === false) this.needSignIn('You are signed out of Claude.');
    if (this.resumeId) await this.loadHistory(this.resumeId);
    // An untrusted folder: ask first, and launch once you answer (or send a message).
    if (await this.askTrustIfNeeded()) {
      this.status.starting = false;
      this.pushStatus();
      return;
    }
    if (this.activeElsewhere) {
      this.status.starting = false;
      this.pushStatus();
      return; // starts only if you choose to continue it here
    }
    if (!this.resumeId || this.panel.visible) {
      this.spawn();
      return;
    }
    this.status.starting = false;
    this.pushStatus();
    const sub = this.panel.onDidChangeViewState(() => {
      if (!this.panel.visible || this.q || this.disposed) return;
      sub.dispose();
      this.spawn();
    });
    this.subs.push(sub);
  }

  /** Start the process if needed and wait until it accepts control requests. */
  private async ensureProcess(): Promise<Query> {
    if (!this.q) this.spawn();
    const q = this.q!;
    await q.initializationResult();
    return q;
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
      // Not finished when last saved: it may still be running in another window, or it was cut off.
      for (const t of this.transcript.threads.values())
        if (t.status === 'running' && t.id !== 'main') this.transcript.updateThread(t.id, { status: 'unknown', endedAt: undefined });
      const age = info?.lastModified ? Date.now() - info.lastModified : Infinity;
      if (age < ACTIVE_ELSEWHERE_MS) {
        this.activeElsewhere = true;
        this.transcript.updateThread('main', { status: 'unknown' });
        const ago = age < 60_000 ? 'less than a minute ago' : `${Math.round(age / 60_000)} minutes ago`;
        this.transcript.notice(
          'main',
          'warn',
          `This conversation was last updated ${ago}, so it is probably still open in another window (for example the official extension). This panel shows what was saved so far and does not update live. Sending a message here would continue it in two places at once.`,
        );
      }
    } catch (e) {
      this.transcript.notice('main', 'error', `Could not load history: ${(e as Error).message}`);
    }
  }

  private hooks = (): SessionHooks => ({
    canUseTool: (name, input, ctx) => this.canUseTool(name, input, ctx),
    stderr: (d) => this.onStderr(d),
  });

  private trustWarned = false;
  private restrictedNoticeShown = false;
  /** Loaded from a conversation that was updated moments ago, probably in another window. */
  private activeElsewhere = false;
  private onStderr(d: string) {
    log(`[${this.sessionId ?? 'new'}] ${d.trimEnd()}`);
    // Claude Code prints this when the folder was never trusted; project
    // permission rules are then ignored, so the user gets extra prompts.
    if (!this.trustWarned && /has not been trusted/.test(d)) {
      this.trustWarned = true;
      void this.askTrustIfNeeded(true);
    }
  }

  private spawn() {
    this.status.starting = true;
    this.pushStatus();
    const input = this.inputStream();
    const trust = this.trustGranted;
    this.trustGranted = undefined;
    const warm = this.resumeId || trust ? undefined : this.warm.take(this.cwd, this.hooks(), this.picks);
    const extra: Partial<Options> = this.resumeId ? { resume: this.resumeId } : {};
    // Claude Code's launch-time attestation that you accepted a trust dialog for this folder;
    // Claude Code then records the trust itself. (Not in the SDK's published types yet.)
    if (trust) (extra as any).workspaceTrust = { accepted: true, directory: trust };
    this.q = warm ? warm.query(input) : query({ prompt: input, options: buildOptions(this.cwd, this.hooks, extra, this.picks) });
    // The model picker shows what the process was started with (checked against the model list once it loads).
    this.status.modelChoice = launchSettings(this.picks).model ?? this.status.modelChoice;
    if (trust) {
      log(`[${this.sessionId ?? 'new'}] launching with trust attestation for ${trust}`);
      void this.verifyTrust(this.q!, trust);
    }
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
    } else if (m.type === 'system' && m.subtype === 'session_title_changed' && typeof m.title === 'string' && m.title.trim()) {
      this.setTitle(m.title.trim().slice(0, 200));
    } else if (m.type === 'auth_status' && m.error) {
      this.needSignIn(`Claude Code reported a sign-in problem: ${m.error}`);
    }
    const r = this.transcript.handle(m);
    if (r.auth) this.needSignIn(`Your Claude sign-in is no longer valid (${r.auth}).`);
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
    if (m.subtype === 'success') notify('done', `Claude finished${this.status.title ? `: ${this.status.title}` : ''}`, this.attended(), () => this.show('main'));
  }

  /** You are looking at this panel right now. */
  private attended() {
    return vscode.window.state.focused && this.panel.active;
  }

  private show(threadId: string) {
    this.panel.reveal();
    this.post({ t: 'focusThread', threadId });
  }

  // ---- folder trust --------------------------------------------------------

  /** Show the trust card if this folder is untrusted and you have not said "don't ask". Returns true if shown. */
  private async askTrustIfNeeded(fromWarning = false): Promise<boolean> {
    if (this.trustItem) return false;
    if (!vscode.workspace.isTrusted) {
      // You chose not to trust this workspace in VS Code: no Claude trust card, no attestation.
      if (!this.restrictedNoticeShown) {
        this.restrictedNoticeShown = true;
        this.transcript.notice(
          'main',
          'info',
          "This VS Code window is in Restricted Mode, so this folder's own Claude settings (.claude/, .mcp.json) are not used. To use them, trust the workspace in VS Code first.",
        );
      }
      return false;
    }
    const root = (this.trustRootDir ??= await trustRoot(this.cwd));
    const trusted = isTrusted(root);
    if (trusted !== false && !fromWarning) return false;
    if (neverAsk(root)) return false;
    this.trustItem = this.transcript.nextId('trust');
    this.transcript.put('main', { kind: 'trust', id: this.trustItem, folder: root, state: 'pending' });
    return true;
  }

  private async answerTrust(id: string, choice: 'trust' | 'notNow' | 'never') {
    const item = this.transcript.findItem('main', id);
    if (item?.kind !== 'trust' || (item.state !== 'pending' && item.state !== 'failed')) return;
    if (choice === 'trust') {
      this.transcript.put('main', { ...item, state: 'trusted' });
      this.trustGranted = item.folder;
      this.warm.discard(); // the spare started untrusted
      if (this.q) this.restartProcess();
      else this.spawn();
      return;
    }
    if (choice === 'never') await rememberNeverAsk(item.folder);
    this.transcript.put('main', { ...item, state: 'declined' });
    if (!this.q) this.spawn();
  }

  /** Deny everything still waiting for an answer and mark the cards as cancelled. */
  private cancelPending(message: string) {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message });
      const item = this.transcript.findItem(p.threadId, id);
      if (item && 'state' in item) this.transcript.put(p.threadId, { ...item, state: 'cancelled' } as Item);
    }
    this.pending.clear();
  }

  /** Close the running claude.exe and start it again on the same conversation. */
  private restartProcess() {
    this.cancelPending('Claude Code restarted.');
    const old = this.q;
    this.q = undefined;
    try {
      old?.close();
    } catch {
      /* already gone */
    }
    this.spawn();
  }

  /**
   * Claude Code records the trust while it initializes, which can take a while
   * on a busy machine: wait for initialization, then check for up to 30 s.
   */
  private async verifyTrust(q: Query, folder: string) {
    try {
      await q.initializationResult();
      log(`[${this.sessionId ?? 'new'}] initialized (trust requested)`);
    } catch (e) {
      log(`trust: initialization failed: ${(e as Error).message}`);
    }
    for (let i = 0; i < 15; i++) {
      if (this.disposed || this.q !== q) return; // closed or restarted: that launch no longer matters
      if (isTrusted(folder) !== false) {
        log(`trust recorded for ${folder}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const item = this.trustItem && this.transcript.findItem('main', this.trustItem);
    if (item && item.kind === 'trust') this.transcript.put('main', { ...item, state: 'failed' });
    log(`trust attestation for ${folder} was not recorded`);
  }

  // ---- sign-in -------------------------------------------------------------

  private needSignIn(reason: string) {
    if (this.signInItem && (this.transcript.findItem('main', this.signInItem) as any)?.state !== 'done') return;
    this.signInItem = this.transcript.nextId('signin');
    this.transcript.put('main', { kind: 'signin', id: this.signInItem, reason, state: 'pending' });
    notify('needsYou', 'Claude needs you to sign in again', this.attended(), () => this.show('main'));
  }

  private async onSignedIn() {
    if (!this.signInItem) return;
    const item = this.transcript.findItem('main', this.signInItem);
    if (item?.kind !== 'signin' || item.state === 'done') return;
    this.transcript.put('main', { ...item, state: 'done' });
    // Restart the process so it picks up the new credentials; the conversation continues.
    if (this.q) this.restartProcess();
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
    // A choice the picker does not list (e.g. a remembered model this version no longer offers) shows as the model in use.
    if (!match) this.status.modelChoice = this.status.models.find((m: any) => m.value === s.applied?.model)?.value;
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
        // "Always allow" options are offered only when Claude Code allows them, and never switch to an unsafe mode.
        const suggestions = ctx.suppressAlwaysAllowRule ? [] : (ctx.suggestions ?? []).filter((u) => u.type !== 'setMode' || SAFE_MODES.has(u.mode));
        const explanation = [ctx.description, ctx.decisionReason, ctx.blockedPath ? `Path: ${ctx.blockedPath}` : ''].filter(Boolean).join('\n');
        item = {
          kind: 'permission',
          id,
          tool: ctx.displayName || toolName,
          title: ctx.title,
          explanation: explanation || undefined,
          detail: describeForPermission(toolName, input),
          suggestions: suggestions.map(permissionLabel),
          defaultToNo: ctx.defaultToNo,
          state: 'pending',
        };
        this.pending.set(id, { kind: 'permission', threadId, input, suggestions, resolve });
      }
      this.transcript.put(threadId, item);
      const who = threadId === 'main' ? 'Claude' : `Subagent “${this.transcript.threads.get(threadId)?.title ?? ''}”`;
      const what = item.kind === 'question' ? 'has a question for you' : item.kind === 'plan' ? 'wants you to approve a plan' : `needs your approval: ${toolName}`;
      notify('needsYou', `${who} ${what}`, this.attended(), () => this.show(threadId));
      ctx.signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        this.transcript.put(threadId, { ...item, state: 'cancelled' } as Item);
        resolve({ behavior: 'deny', message: 'Cancelled.' });
      });
    });
  };

  private settle<K extends Pending['kind']>(id: string, kind: K): Extract<Pending, { kind: K }> | undefined {
    const p = this.pending.get(id);
    if (p?.kind !== kind) return undefined;
    this.pending.delete(id);
    return p as Extract<Pending, { kind: K }>;
  }

  // ---- messages from the webview -----------------------------------------

  private async onView(m: ViewToHost) {
    switch (m.t) {
      case 'ready':
        this.viewReady = true;
        this.post({ t: 'snapshot', snapshot: { ...this.transcript.snapshotParts(), status: this.status, config: readConfig().view } }, true);
        for (const o of this.outbox.splice(0)) this.post(o);
        if (this.prefill) {
          this.post({ t: 'prefill', text: this.prefill });
          this.prefill = undefined;
        }
        return;
      case 'send':
        if (this.activeElsewhere && !this.q) {
          const choice = await vscode.window.showWarningMessage(
            'Continue this conversation here?',
            { modal: true, detail: 'It was updated a few minutes ago and is probably still open in another window. If it is, both would continue the same conversation at once. Close it there first, or start a new session instead.' },
            'Continue here',
          );
          if (choice !== 'Continue here') {
            this.post({ t: 'prefill', text: m.text });
            return;
          }
          this.activeElsewhere = false;
        }
        return this.send(m.text, m.images);
      case 'rewind':
        return this.rewind(m.uuid, m.mode);
      case 'trust':
        return this.answerTrust(m.id, m.choice);
      case 'signIn': {
        if (this.signInItem) {
          const it = this.transcript.findItem('main', this.signInItem);
          if (it?.kind === 'signin') this.transcript.put('main', { ...it, state: 'working' });
        }
        const ok = await signIn();
        if (!ok && this.signInItem) {
          const it = this.transcript.findItem('main', this.signInItem);
          if (it?.kind === 'signin') this.transcript.put('main', { ...it, state: 'pending' });
        }
        return;
      }
      case 'interrupt':
        await this.q?.interrupt();
        return;
      case 'stopTask':
        await this.q?.stopTask(m.taskId);
        return;
      case 'permission': {
        const p = this.settle(m.id, 'permission');
        if (!p) return;
        const item = this.transcript.findItem(p.threadId, m.id);
        if (m.allow) {
          const valid = Number.isInteger(m.suggestion) && m.suggestion! >= 0 && m.suggestion! < p.suggestions.length;
          const upd = valid ? [p.suggestions[m.suggestion!]] : undefined;
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
        const p = this.settle(m.id, 'question');
        if (!p) return;
        const item = this.transcript.findItem(p.threadId, m.id);
        if (m.answers) p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers: m.answers } });
        else p.resolve({ behavior: 'deny', message: 'The user declined to answer.' });
        if (item) this.transcript.put(p.threadId, { ...item, state: m.answers ? 'answered' : 'cancelled', answers: m.answers ?? undefined } as Item);
        return;
      }
      case 'plan': {
        const p = this.settle(m.id, 'plan');
        if (!p) return;
        const item = this.transcript.findItem(p.threadId, m.id);
        if (m.approve) {
          p.resolve({ behavior: 'allow', updatedInput: p.input });
          if (m.mode) await this.setMode(m.mode);
        } else p.resolve({ behavior: 'deny', message: m.feedback?.trim() || 'The user wants to keep planning.' });
        if (item) this.transcript.put(p.threadId, { ...item, state: m.approve ? 'approved' : 'rejected' } as Item);
        return;
      }
      case 'setModel':
        if (typeof m.value !== 'string' || !this.status.models.some((x) => x.value === m.value)) return;
        await this.q?.setModel(m.value);
        this.status.modelChoice = m.value;
        this.picks.model = m.value;
        rememberLastUsed({ model: m.value });
        await this.refreshSettings();
        this.pushStatus();
        void this.refreshContext();
        return;
      case 'setMode':
        await this.setMode(m.value);
        // Only a mode you picked yourself carries over to new tabs (not one a plan approval switched to).
        if (this.status.permissionMode === m.value) rememberLastUsed({ permissionMode: m.value });
        return;
      case 'setEffort':
        if (typeof m.value !== 'string' || !this.status.models.some((x) => x.effortLevels.includes(m.value))) return;
        await this.q?.applyFlagSettings({ effortLevel: m.value as any });
        this.picks.effort = m.value;
        rememberLastUsed({ effort: m.value });
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
      case 'report':
        if (typeof m.text === 'string' && (m.text.trim() || validImages(m.images).length)) await this.host.saveReport(this, m.text.slice(0, 100_000), validImages(m.images));
        return;
      case 'log':
        log(`[view] ${m.text}`);
        return;
      case 'runUpdate':
        await vscode.commands.executeCommand('claudePanel.checkForUpdates');
        return;
    }
  }

  private async setMode(mode: string) {
    if (!SAFE_MODES.has(mode)) {
      log(`refused permission mode ${JSON.stringify(mode).slice(0, 40)}`);
      return;
    }
    await this.q?.setPermissionMode(mode as any);
    this.status.permissionMode = mode;
    this.picks.permissionMode = mode;
    this.pushStatus();
  }

  /** Open the report form in this panel. */
  showReportForm() {
    this.panel.reveal();
    this.post({ t: 'showReport' });
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

  send(text: string, images: ImageAttachment[] = []) {
    images = validImages(images);
    if (!text.trim() && !images.length) return;
    const uuid = randomUUID();
    this.transcript.addUser(text, uuid, images.map((i) => `data:${i.mediaType};base64,${i.data}`));
    const content = images.length
      ? [
          ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
          ...(text.trim() ? [{ type: 'text' as const, text }] : []),
        ]
      : text;
    this.queue.push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage);
    this.setBusy(true);
    if (!this.q) this.spawn(); // process ended (crash or idle exit): resume the same conversation
    this.wake?.();
  }

  /**
   * Rewind: "code" restores files to how they were when that message was sent,
   * "fork" opens a new conversation branching just before it (with the
   * message ready to edit), "both" does both. Files changed by hand or by
   * shell commands are not tracked by Claude Code and are not restored.
   */
  private async rewind(uuid: string, mode: 'code' | 'fork' | 'both') {
    const item = this.transcript.items.get('main')?.find((i) => i.kind === 'user' && i.uuid === uuid);
    if (item?.kind !== 'user') return;
    if (mode !== 'fork') {
      if (this.status.busy) {
        void vscode.window.showWarningMessage('Stop Claude before rewinding code.');
        return;
      }
      const q = await this.ensureProcess();
      const dry = await q.rewindFiles(uuid, { dryRun: true });
      if (!dry.canRewind) {
        void vscode.window.showErrorMessage(`Can't rewind code: ${dry.error ?? 'there is no checkpoint for this message'}.`);
        return;
      }
      const files = dry.filesChanged ?? [];
      if (!files.length) {
        void vscode.window.showInformationMessage('No files were changed by Claude after this message.');
      } else {
        const rel = (f: string) => path.relative(this.cwd, f) || f;
        const list = files.slice(0, 15).map(rel).join('\n') + (files.length > 15 ? `\n… and ${files.length - 15} more` : '');
        const choice = await vscode.window.showWarningMessage(
          `Restore ${files.length} file${files.length > 1 ? 's' : ''} to how ${files.length > 1 ? 'they were' : 'it was'} before this message?`,
          { modal: true, detail: `${list}\n\n+${dry.insertions ?? 0} / −${dry.deletions ?? 0} lines. Changes made by hand or by shell commands are not undone.` },
          'Rewind code',
        );
        if (choice !== 'Rewind code') return;
        const r = await q.rewindFiles(uuid);
        if (!r.canRewind) {
          void vscode.window.showErrorMessage(`Rewind failed: ${r.error ?? 'unknown error'}`);
          return;
        }
        this.transcript.notice('main', 'info', `Rewound code to before “${item.text.slice(0, 60)}${item.text.length > 60 ? '…' : ''}” (${files.length} file${files.length > 1 ? 's' : ''}).`);
      }
    }
    if (mode !== 'code') {
      let forkId: string | undefined;
      if (item.forkPoint && this.sessionId) {
        forkId = (await forkSession(this.sessionId, { dir: this.cwd, upToMessageId: item.forkPoint })).sessionId;
      }
      this.host.openSession(forkId, this.cwd, item.text);
      this.host.sessionsChanged();
    }
  }

  setTitleFromHost(title: string) {
    this.titleFetched = true;
    this.setTitle(title);
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
    for (const d of this.subs) d.dispose();
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
  const valid: Record<string, (v: unknown) => boolean> = {
    renderMath: (v) => typeof v === 'boolean',
    showThinking: (v) => typeof v === 'boolean',
    enterToSend: (v) => typeof v === 'boolean',
    toolActivity: (v) => v === 'hidden' || v === 'summary' || v === 'detailed',
  };
  for (const [k, v] of Object.entries(patch)) if (valid[k]?.(v)) await c.update(k, v, vscode.ConfigurationTarget.Global);
}

async function findFiles(q: string, cwd: string): Promise<string[]> {
  const pattern = q ? `**/*${q.replace(/[\\[\]{}*?]/g, '')}*` : '**/*';
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(cwd, pattern), '**/{node_modules,.git,dist,out}/**', 30);
  return uris.map((u) => path.relative(cwd, u.fsPath).replace(/\\/g, '/')).sort((a, b) => a.length - b.length);
}
