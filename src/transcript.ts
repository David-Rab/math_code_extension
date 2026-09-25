// Turns the SDK message stream (live or loaded from history) into threads of
// display items. Pure logic, no VS Code dependency, so it can be tested by
// replaying recorded streams.
import type { HostToView, Item, Snapshot, ThreadMeta, ToolCall } from './shared/protocol';

type Emit = (msg: HostToView) => void;

const AGENT_TOOLS = new Set(['Agent', 'Task']);

// Message kinds we understand but deliberately do not display. Anything not
// handled and not listed here is shown as an "unsupported" card, so new
// Claude Code features never disappear silently.
const IGNORED_SYSTEM = new Set([
  'status',
  'thinking_tokens',
  'background_tasks_changed',
  'hook_started',
  'hook_progress',
  'hook_response',
  'hook_callback',
  'files_persisted',
  'memory_recall',
  'elicitation_complete',
  'commands_changed',
  'session_state_changed',
  'mirror_error',
]);
const IGNORED_TYPES = new Set(['keep_alive', 'tool_progress', 'auth_status', 'prompt_suggestion', 'tool_use_summary']);

export class Transcript {
  readonly threads = new Map<string, ThreadMeta>();
  readonly items = new Map<string, Item[]>();
  readonly drafts = new Map<string, string>();
  private toolIndex = new Map<string, { threadId: string; itemId: string }>();
  private taskToThread = new Map<string, string>(); // task_id / agentId -> thread id
  private seq = 0;

  constructor(private emit: Emit = () => {}) {
    this.ensureThread('main', { title: 'Main', status: 'done' });
  }

  snapshotParts(): Omit<Snapshot, 'status' | 'config'> {
    return {
      threads: [...this.threads.values()],
      items: Object.fromEntries(this.items),
      drafts: Object.fromEntries(this.drafts),
    };
  }

  nextId(prefix: string) {
    return `${prefix}-${++this.seq}`;
  }

  threadForAgent(agentId: string | undefined): string {
    return (agentId && this.taskToThread.get(agentId)) || 'main';
  }

  setMainRunning(running: boolean) {
    this.updateThread('main', { status: running ? 'running' : 'done' });
  }

  ensureThread(id: string, meta: Partial<ThreadMeta>): ThreadMeta {
    let t = this.threads.get(id);
    if (!t) {
      t = { id, title: 'Subagent', status: 'running', ...meta };
      this.threads.set(id, t);
      this.items.set(id, []);
      this.emit({ t: 'thread', thread: t });
    }
    return t;
  }

  updateThread(id: string, patch: Partial<ThreadMeta>) {
    const t = this.threads.get(id);
    if (!t) return;
    Object.assign(t, patch);
    this.emit({ t: 'thread', thread: t });
  }

  /** Append an item, or replace the existing item with the same id. */
  put(threadId: string, item: Item) {
    if (!this.items.has(threadId)) this.ensureThread(threadId, {});
    const list = this.items.get(threadId)!;
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item;
    else list.push(item);
    this.emit({ t: 'item', threadId, item });
  }

  findItem(threadId: string, id: string): Item | undefined {
    return this.items.get(threadId)?.find((x) => x.id === id);
  }

  notice(threadId: string, level: 'info' | 'warn' | 'error', text: string) {
    this.put(threadId, { kind: 'notice', id: this.nextId('n'), level, text });
  }

  addUser(text: string) {
    this.put('main', { kind: 'user', id: this.nextId('u'), text });
  }

  /** The task a subagent was given, shown once at the top of its tab. */
  private addPrompt(threadId: string, prompt: unknown) {
    if (typeof prompt !== 'string' || !prompt) return;
    if (this.items.get(threadId)?.some((x) => x.kind === 'prompt')) return;
    this.put(threadId, { kind: 'prompt', id: this.nextId('p'), text: prompt });
  }

  private setDraft(threadId: string, text: string | null) {
    if (text === null) {
      if (!this.drafts.has(threadId)) return;
      this.drafts.delete(threadId);
    } else this.drafts.set(threadId, text);
    this.emit({ t: 'draft', threadId, text });
  }

  private threadOf(parentToolUseId: string | null | undefined): string {
    if (!parentToolUseId) return 'main';
    if (!this.threads.has(parentToolUseId)) this.ensureThread(parentToolUseId, {});
    return parentToolUseId;
  }

  /**
   * Feed one SDK message. `history` is true when replaying a stored
   * transcript, where the user's own prompts must be shown (live, the view
   * adds them itself when you press send).
   */
  handle(m: any, history = false): { unknown?: boolean } {
    switch (m.type) {
      case 'stream_event':
        this.onStreamEvent(m);
        return {};
      case 'assistant':
        this.onAssistant(m);
        return {};
      case 'user':
        this.onUser(m, history);
        return {};
      case 'system':
        return this.onSystem(m);
      case 'result':
        this.onResult(m);
        return {};
      case 'rate_limit_event':
        return {};
      default:
        if (IGNORED_TYPES.has(m.type)) return {};
        this.unknown(m);
        return { unknown: true };
    }
  }

  private unknown(m: any) {
    const label = m.type + (m.subtype ? `:${m.subtype}` : '');
    this.put('main', { kind: 'unknown', id: this.nextId('x'), label, raw: JSON.stringify(m, null, 2).slice(0, 4000) });
  }

  private onStreamEvent(m: any) {
    const threadId = this.threadOf(m.parent_tool_use_id);
    const ev = m.event;
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') this.setDraft(threadId, '');
    else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta')
      this.setDraft(threadId, (this.drafts.get(threadId) ?? '') + ev.delta.text);
  }

  private onAssistant(m: any) {
    const threadId = this.threadOf(m.parent_tool_use_id);
    const content = Array.isArray(m.message?.content) ? m.message.content : [];
    for (const b of content) {
      if (b.type === 'text') {
        this.setDraft(threadId, null);
        if (b.text?.trim()) this.put(threadId, { kind: 'text', id: this.nextId('t'), text: b.text });
      } else if (b.type === 'thinking') {
        if (b.thinking?.trim()) this.put(threadId, { kind: 'thinking', id: this.nextId('k'), text: b.thinking });
      } else if (b.type === 'tool_use') {
        this.onToolUse(threadId, b);
      }
    }
    if (m.error) this.notice(threadId, 'error', `API error: ${m.error}`);
  }

  private onToolUse(threadId: string, b: any) {
    if (AGENT_TOOLS.has(b.name)) {
      const input = b.input ?? {};
      const title = input.description || input.name || 'Subagent';
      this.ensureThread(b.id, {
        title,
        agentType: input.subagent_type,
        model: input.model,
        parentId: threadId,
        status: 'running',
        background: !!input.run_in_background,
      });
      this.updateThread(b.id, { title, agentType: input.subagent_type, parentId: threadId });
      this.addPrompt(b.id, input.prompt);
      this.put(threadId, { kind: 'agent', id: `agent-${b.id}`, threadId: b.id, title, agentType: input.subagent_type });
      return;
    }
    const call: ToolCall = { id: b.id, name: b.name, summary: summarizeTool(b.name, b.input), status: 'running' };
    const list = this.items.get(threadId)!;
    const last = list[list.length - 1];
    if (last?.kind === 'tools') {
      const updated: Item = { ...last, tools: [...last.tools, call] };
      this.put(threadId, updated);
      this.toolIndex.set(b.id, { threadId, itemId: last.id });
    } else {
      const id = this.nextId('g');
      this.put(threadId, { kind: 'tools', id, tools: [call] });
      this.toolIndex.set(b.id, { threadId, itemId: id });
    }
  }

  private onUser(m: any, history: boolean) {
    const threadId = this.threadOf(m.parent_tool_use_id);
    const content = m.message?.content;
    if (typeof content === 'string') {
      this.onUserText(threadId, content, history, m);
      return;
    }
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    for (const b of content) {
      if (b.type === 'tool_result') this.onToolResult(b, m);
      else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length) this.onUserText(threadId, texts.join('\n'), history, m);
  }

  private onUserText(threadId: string, text: string, history: boolean, m: any) {
    const local = text.match(/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/);
    if (local) {
      if (local[1].trim()) this.notice(threadId, 'info', local[1].trim());
      return;
    }
    if (/^\[Request interrupted by user/.test(text)) {
      this.notice(threadId, 'info', 'Stopped.');
      return;
    }
    const note = text.match(/^<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([^<]+)<\/status>/);
    if (note) {
      if (this.threads.has(note[1])) this.updateThread(note[1], { status: mapTaskStatus(note[2]) });
      return;
    }
    if (m.isSynthetic || m.isMeta || /^<(command-name|command-message|system-reminder|task-notification)/.test(text)) return;
    // Live, the view already shows what you typed. A subagent's first user
    // message is its task, shown from the Agent call instead.
    if (!history || threadId !== 'main') return;
    this.put('main', { kind: 'user', id: this.nextId('u'), text });
  }

  private onToolResult(b: any, m: any) {
    const ref = this.toolIndex.get(b.tool_use_id);
    if (ref) {
      const item = this.findItem(ref.threadId, ref.itemId);
      if (item?.kind === 'tools') {
        const tools = item.tools.map((t) => (t.id === b.tool_use_id ? { ...t, status: b.is_error ? ('error' as const) : ('done' as const) } : t));
        this.put(ref.threadId, { ...item, tools });
      }
      return;
    }
    const thread = this.threads.get(b.tool_use_id);
    if (thread) {
      const launchedAsync = typeof m.tool_use_result === 'object' && m.tool_use_result?.status === 'async_launched';
      const text = resultText(b.content);
      if (launchedAsync || /^Async agent launched/.test(text)) {
        this.updateThread(thread.id, { background: true });
        return;
      }
      this.updateThread(thread.id, { status: b.is_error ? 'error' : 'done' });
    }
  }

  private onSystem(m: any): { unknown?: boolean } {
    switch (m.subtype) {
      case 'init':
        return {};
      case 'task_started': {
        if (!m.tool_use_id) return {};
        const t = this.ensureThread(m.tool_use_id, { title: m.description || 'Subagent', agentType: m.subagent_type, status: 'running' });
        this.taskToThread.set(m.task_id, t.id);
        this.updateThread(t.id, { background: !!m.is_backgrounded, status: 'running', taskId: m.task_id });
        this.addPrompt(t.id, m.prompt);
        return {};
      }
      case 'task_updated': {
        const id = this.taskToThread.get(m.task_id);
        const s = m.patch?.status;
        if (id && s) this.updateThread(id, { status: mapTaskStatus(s) });
        return {};
      }
      case 'task_notification': {
        const id = m.tool_use_id || this.taskToThread.get(m.task_id);
        if (id && this.threads.has(id)) this.updateThread(id, { status: mapTaskStatus(m.status) });
        return {};
      }
      case 'task_progress':
        return {};
      case 'compact_boundary':
        this.notice('main', 'info', 'Conversation compacted.');
        return {};
      case 'api_retry':
        this.notice('main', 'warn', `API error, retrying (attempt ${m.attempt ?? '?'}${m.max_retries ? ` of ${m.max_retries}` : ''})…`);
        return {};
      case 'local_command_output':
        if (m.content) this.notice('main', 'info', String(m.content));
        return {};
      case 'informational':
      case 'notification':
        if (m.message || m.text) this.notice('main', 'info', String(m.message ?? m.text));
        return {};
      case 'permission_denied':
        this.notice(this.threadForAgent(m.agent_id), 'warn', `Denied: ${m.tool_name ?? 'tool'}${m.reason ? ` — ${m.reason}` : ''}`);
        return {};
      case 'model_refusal_fallback':
      case 'model_refusal_no_fallback':
        this.notice('main', 'warn', m.message ?? m.subtype.replace(/_/g, ' '));
        return {};
      case 'bridge_state':
        return {};
      default:
        if (IGNORED_SYSTEM.has(m.subtype)) return {};
        this.unknown(m);
        return { unknown: true };
    }
  }

  private onResult(m: any) {
    for (const [id, text] of this.drafts) if (text) this.put(id, { kind: 'text', id: this.nextId('t'), text });
    for (const id of [...this.drafts.keys()]) this.setDraft(id, null);
    if (m.subtype !== 'success' && m.subtype !== 'error_during_execution') {
      const why = (m.errors ?? []).join('; ') || m.subtype.replace(/_/g, ' ');
      this.notice('main', 'error', `Turn ended: ${why}`);
    } else if (m.is_error && m.result) this.notice('main', 'error', String(m.result));
  }
}

function mapTaskStatus(s: string): ThreadMeta['status'] {
  if (s === 'completed') return 'done';
  if (s === 'failed') return 'error';
  if (s === 'killed' || s === 'stopped' || s === 'cancelled') return 'stopped';
  return 'running';
}

function resultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return '';
}

function short(s: unknown, n = 90): string {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function base(p: unknown): string {
  return String(p ?? '').split(/[\\/]/).pop() ?? '';
}

export function summarizeTool(name: string, input: any): string {
  input = input ?? {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.description ? short(input.description) : short(input.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return base(input.file_path ?? input.notebook_path);
    case 'Glob':
    case 'Grep':
      return short(input.pattern);
    case 'WebFetch':
      return short(input.url);
    case 'WebSearch':
      return short(input.query);
    case 'Skill':
      return short(input.skill);
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return first ? short(first, 60) : '';
    }
  }
}

/** One-paragraph description of a tool call for a permission prompt. */
export function describeForPermission(name: string, input: any): string {
  input = input ?? {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return (input.description ? input.description + '\n' : '') + '$ ' + String(input.command ?? '');
    case 'Write':
      return `Create/overwrite ${input.file_path}`;
    case 'Edit':
      return `Edit ${input.file_path}`;
    case 'NotebookEdit':
      return `Edit notebook ${input.notebook_path}`;
    case 'WebFetch':
      return `Fetch ${input.url}`;
    default:
      return JSON.stringify(input, null, 2).slice(0, 1500);
  }
}
