import { render } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HostToView, ImageAttachment, Item, Snapshot, Status, ThreadMeta, Todo, ViewConfig, ViewToHost, Question } from '../src/shared/protocol';
import { renderMarkdown, setRenderMath, setMacros, splitDraft } from './markdown';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const send = (m: ViewToHost) => vscode.postMessage(m);

// ---------------------------------------------------------------------------
// Store: host messages are buffered and applied once per animation frame, so
// a burst of streamed tokens costs one render, not hundreds.

interface State extends Snapshot {
  active: string;
  unread: Record<string, boolean>;
  showMap: boolean;
}

let state: State = {
  threads: [],
  items: {},
  drafts: {},
  todos: {},
  status: { models: [], commands: [], remote: { state: 'off' }, busy: false, starting: true },
  config: { renderMath: true, toolActivity: 'summary', showThinking: false, enterToSend: true, mathMacros: {} },
  active: 'main',
  unread: {},
  showMap: false,
};
let setVersion: (n: number) => void = () => {};
let version = 0;
let queue: HostToView[] = [];
let scheduled = false;
const fileListeners = new Set<(q: string, files: string[]) => void>();
const prefillListeners = new Set<(text: string) => void>();

window.addEventListener('error', (e) => send({ t: 'log', text: `error: ${e.message} at ${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => send({ t: 'log', text: `unhandled rejection: ${String(e.reason)}` }));

window.addEventListener('message', (e: MessageEvent<HostToView>) => {
  if (e.data.t === 'fileMatches') {
    for (const l of fileListeners) l(e.data.query, e.data.files);
    return;
  }
  if (e.data.t === 'prefill') {
    for (const l of prefillListeners) l(e.data.text);
    return;
  }
  queue.push(e.data);
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
});

function flush() {
  scheduled = false;
  const batch = queue;
  queue = [];
  let s = state;
  for (const m of batch) s = apply(s, m);
  state = s;
  setRenderMath(state.config.renderMath);
  setMacros(state.config.mathMacros);
  setVersion(++version);
}

function apply(s: State, m: HostToView): State {
  switch (m.t) {
    case 'snapshot': {
      const saved = vscode.getState() ?? {};
      const active = m.snapshot.threads.some((t) => t.id === saved.active) ? saved.active : 'main';
      return { ...m.snapshot, todos: m.snapshot.todos ?? {}, active, unread: {}, showMap: s.showMap };
    }
    case 'thread': {
      const i = s.threads.findIndex((t) => t.id === m.thread.id);
      const threads = i >= 0 ? s.threads.map((t, j) => (j === i ? { ...m.thread } : t)) : [...s.threads, { ...m.thread }];
      return { ...s, threads, items: s.items[m.thread.id] ? s.items : { ...s.items, [m.thread.id]: [] } };
    }
    case 'item': {
      const list = s.items[m.threadId] ?? [];
      let i = -1;
      for (let j = list.length - 1; j >= 0; j--)
        if (list[j].id === m.item.id) {
          i = j;
          break;
        }
      const next = i >= 0 ? list.map((x, j) => (j === i ? m.item : x)) : [...list, m.item];
      const unread = m.threadId !== s.active && i < 0 ? { ...s.unread, [m.threadId]: true } : s.unread;
      return { ...s, items: { ...s.items, [m.threadId]: next }, unread };
    }
    case 'draft': {
      const drafts = { ...s.drafts };
      if (m.text === null) delete drafts[m.threadId];
      else drafts[m.threadId] = m.text;
      return { ...s, drafts };
    }
    case 'todos':
      return { ...s, todos: { ...s.todos, [m.threadId]: m.todos } };
    case 'focusThread':
      return s.threads.some((t) => t.id === m.threadId) ? { ...s, active: m.threadId, unread: { ...s.unread, [m.threadId]: false } } : s;
    case 'showAgentMap':
      return { ...s, showMap: true };
    case 'status':
      return { ...s, status: { ...s.status, ...m.status } };
    case 'config':
      return { ...s, config: m.config };
    default:
      return s;
  }
}

function setShowMap(on: boolean) {
  state = { ...state, showMap: on };
  setVersion(++version);
}

function setActive(id: string) {
  state = { ...state, active: id, showMap: false, unread: { ...state.unread, [id]: false } };
  vscode.setState({ ...(vscode.getState() ?? {}), active: id });
  setVersion(++version);
}

function setConfig(patch: Partial<ViewConfig>) {
  state = { ...state, config: { ...state.config, ...patch } };
  setRenderMath(state.config.renderMath);
  setVersion(++version);
  send({ t: 'setConfig', config: patch });
}

// ---------------------------------------------------------------------------

function App() {
  const [, force] = useState(0);
  setVersion = force;
  useEffect(() => send({ t: 'ready' }), []);
  useEffect(() => {
    // Remember the session so VS Code can restore this panel after a restart.
    if (state.status.sessionId) vscode.setState({ ...(vscode.getState() ?? {}), sessionId: state.status.sessionId, cwd: state.status.cwd });
  }, [state.status.sessionId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
        setShowMap(!state.showMap);
        e.preventDefault();
        return;
      }
      if (!e.altKey || (e.key !== '[' && e.key !== ']' && !/^[1-9]$/.test(e.key))) return;
      const ids = state.threads.map((t) => t.id);
      let i = ids.indexOf(state.active);
      if (e.key === '[') i = Math.max(0, i - 1);
      else if (e.key === ']') i = Math.min(ids.length - 1, i + 1);
      else i = Math.min(ids.length - 1, Number(e.key) - 1);
      setActive(ids[i]);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const s = state;
  const thread = s.threads.find((t) => t.id === s.active) ?? s.threads[0];
  if (!thread) return <div class="empty">Starting…</div>;
  return (
    <div class="app">
      <Tabs threads={s.threads} active={thread.id} unread={s.unread} items={s.items} />
      <ThreadView key={thread.id} thread={thread} items={s.items[thread.id] ?? []} draft={s.drafts[thread.id]} config={s.config} />
      {s.showMap && <AgentMap threads={s.threads} items={s.items} active={thread.id} />}
      <Attention active={thread.id} />
      <Progress todos={s.todos[thread.id] ?? []} threadId={thread.id} />
      <Composer status={s.status} thread={thread} config={s.config} />
      <StatusBar status={s.status} config={s.config} />
    </div>
  );
}

// --- tabs ------------------------------------------------------------------

function needsYou(items: Item[] | undefined) {
  return !!items?.some((i) => (i.kind === 'permission' || i.kind === 'question' || i.kind === 'plan') && i.state === 'pending');
}

function Tabs({ threads, active, unread, items }: { threads: ThreadMeta[]; active: string; unread: Record<string, boolean>; items: Record<string, Item[]> }) {
  if (threads.length < 2) return null;
  return (
    <div class="tabs" onWheel={(e) => ((e.currentTarget as HTMLElement).scrollLeft += (e as WheelEvent).deltaY)}>
      <MapButton threads={threads} items={items} />
      {threads.map((t, i) => (
        <button
          key={t.id}
          class={`tab ${t.id === active ? 'active' : ''} ${t.id === 'main' ? 'main' : ''}`}
          title={[t.title, t.agentType, t.model, t.background ? 'background' : ''].filter(Boolean).join(' · ') + (i < 9 ? `  (Alt+${i + 1})` : '')}
          onClick={() => setActive(t.id)}
          style={t.id === 'main' ? undefined : { '--agent-hue': String(hue(t.id)) }}
        >
          <StatusDot status={t.status} />
          <span class="tab-title">{t.title}</span>
          {needsYou(items[t.id]) ? <span class="badge-attn" title="Waiting for you">!</span> : unread[t.id] ? <span class="badge-unread" /> : null}
        </button>
      ))}
    </div>
  );
}

// --- agent map -----------------------------------------------------------------

type MapState = 'waiting' | 'running' | 'failed' | 'idle';

function mapState(threads: ThreadMeta[], items: Record<string, Item[]>): MapState {
  if (threads.some((t) => needsYou(items[t.id]))) return 'waiting';
  if (threads.some((t) => t.id !== 'main' && t.status === 'error')) return 'failed';
  if (threads.some((t) => t.id !== 'main' && t.status === 'running')) return 'running';
  return 'idle';
}

const MAP_TITLES: Record<MapState, string> = {
  waiting: 'An agent is waiting for you · open the agent map',
  running: 'Agents are working · open the agent map',
  failed: 'An agent failed · open the agent map',
  idle: 'Open the agent map',
};

function MapButton({ threads, items }: { threads: ThreadMeta[]; items: Record<string, Item[]> }) {
  const st = mapState(threads, items);
  const running = threads.filter((t) => t.id !== 'main' && t.status === 'running').length;
  return (
    <button class={`tab map-button ${st}`} title={MAP_TITLES[st] + ' (Ctrl+Shift+M)'} onClick={() => setShowMap(!state.showMap)}>
      <span class="map-glyph">⌬</span>
      <span class={`map-dot ${st}`} />
      {running > 0 ? <span class="tab-title">{running}</span> : null}
    </button>
  );
}

function elapsed(t: ThreadMeta, now: number): string {
  if (!t.startedAt) return '';
  const s = Math.max(0, Math.round(((t.endedAt ?? now) - t.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function AgentMap({ threads, items, active }: { threads: ThreadMeta[]; items: Record<string, Item[]>; active: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setShowMap(false);
    window.addEventListener('keydown', esc);
    return () => (clearInterval(t), window.removeEventListener('keydown', esc));
  }, []);
  const children = (id: string) => threads.filter((t) => t.id !== 'main' && (t.parentId ?? 'main') === id);
  const actions = (id: string) => (items[id] ?? []).reduce((n, i) => n + (i.kind === 'tools' ? i.tools.length : 0), 0);
  const node = (t: ThreadMeta): preact.JSX.Element => {
    const kids = children(t.id);
    const waiting = needsYou(items[t.id]);
    return (
      <li key={t.id}>
        <div
          class={`map-node ${t.id === active ? 'current' : ''} ${waiting ? 'waiting' : ''}`}
          style={t.id === 'main' ? undefined : { '--agent-hue': String(hue(t.id)) }}
          onClick={() => setActive(t.id)}
          title="Open this tab"
        >
          <StatusDot status={t.status} />
          <div class="map-text">
            <div class="map-title">
              {t.id === 'main' ? 'Main agent' : t.title}
              {waiting && <span class="badge-attn">needs you</span>}
            </div>
            <div class="muted map-meta">
              {[t.agentType, t.model, t.background ? 'background' : '', statusWord(t.status), t.id === 'main' ? '' : elapsed(t, now), `${actions(t.id)} actions`].filter(Boolean).join(' · ')}
            </div>
          </div>
          {t.id !== 'main' && t.status === 'running' && t.taskId && (
            <button
              class="secondary small"
              onClick={(e) => {
                e.stopPropagation();
                send({ t: 'stopTask', taskId: t.taskId! });
              }}
            >
              Stop
            </button>
          )}
        </div>
        {kids.length > 0 && <ul>{kids.map(node)}</ul>}
      </li>
    );
  };
  const main = threads.find((t) => t.id === 'main');
  const orphans = threads.filter((t) => t.id !== 'main' && t.parentId && !threads.some((p) => p.id === t.parentId));
  return (
    <div class="map-overlay" onClick={(e) => e.target === e.currentTarget && setShowMap(false)}>
      <div class="map-card">
        <div class="map-header">
          <strong>Agent map</strong>
          <span class="muted">{threads.length - 1} subagent{threads.length === 2 ? '' : 's'}</span>
          <span class="grow" />
          <button class="link" onClick={() => setShowMap(false)}>
            Close (Esc)
          </button>
        </div>
        <ul class="map-tree">
          {main && node(main)}
          {orphans.map(node)}
        </ul>
      </div>
    </div>
  );
}

// --- progress list ---------------------------------------------------------

function Progress({ todos, threadId }: { todos: Todo[]; threadId: string }) {
  const [open, setOpen] = useState(false);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  if (done === todos.length && !open) {
    return (
      <div class="progress done" onClick={() => setOpen(true)} title="Show the list">
        ✓ All {todos.length} steps done
      </div>
    );
  }
  return (
    <div class="progress" key={threadId}>
      <button class="progress-line" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Show the whole list'}>
        <span class="progress-count">
          {done}/{todos.length}
        </span>
        <span class="progress-bar">
          <span style={{ width: `${(100 * done) / todos.length}%` }} />
        </span>
        <span class="progress-current">{current ? `▶ ${current.activeForm || current.content}` : 'Progress'}</span>
        <span class="muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul class="progress-list">
          {todos.map((t) => (
            <li key={t.id} class={t.status}>
              <span class="check">{t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐'}</span> {t.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function hue(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function StatusDot({ status }: { status: ThreadMeta['status'] }) {
  if (status === 'running') return <span class="dot running" title="Running" />;
  if (status === 'error') return <span class="dot error" title="Failed" />;
  if (status === 'stopped') return <span class="dot stopped" title="Stopped" />;
  return <span class="dot done" title="Idle / finished" />;
}

function Attention({ active }: { active: string }) {
  const waiting = state.threads.filter((t) => t.id !== active && needsYou(state.items[t.id]));
  if (!waiting.length) return null;
  return (
    <div class="attention">
      {waiting.map((t) => (
        <button key={t.id} class="link" onClick={() => setActive(t.id)}>
          ⚠ {t.id === 'main' ? 'Main agent' : `“${t.title}”`} is waiting for you — show
        </button>
      ))}
    </div>
  );
}

// --- thread ----------------------------------------------------------------

// Only the latest PAGE items render at first; earlier ones load as you scroll
// up. Per-tab scroll position and page count survive switching tabs.
const PAGE = 40;
const FIRST = 8;
const memory = new Map<string, { top: number; limit: number }>();

function ThreadView({ thread, items, draft, config }: { thread: ThreadMeta; items: Item[]; draft?: string; config: ViewConfig }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<number | null>(null); // distance from bottom to keep while loading earlier items
  // A freshly opened tab draws its last few items first, then fills in up to
  // PAGE in the background, so the view appears at once even for long sessions.
  const [limit, setLimit] = useState(() => memory.get(thread.id)?.limit ?? FIRST);
  const [showJump, setShowJump] = useState(false);
  const shown = useMemo(() => mergeActivity(items, config), [items, config.showThinking, config.toolActivity]);
  const visible = shown.length > limit ? shown.slice(shown.length - limit) : shown;
  const hidden = shown.length - visible.length;

  const loadEarlier = (to = limit + PAGE) => {
    const el = ref.current;
    if (!el || hidden <= 0 || anchor.current !== null) return;
    anchor.current = el.scrollHeight - el.scrollTop;
    memory.set(thread.id, { top: el.scrollTop, limit: to });
    setLimit(to);
  };
  useEffect(() => {
    if (limit >= PAGE || hidden <= 0) return;
    const t = setTimeout(() => loadEarlier(PAGE), 30);
    return () => clearTimeout(t);
  }, [limit, hidden > 0]);

  useLayoutEffect(() => {
    const el = ref.current!;
    const saved = memory.get(thread.id);
    if (saved) {
      el.scrollTop = saved.top;
      stick.current = el.scrollHeight - el.clientHeight - saved.top < 40;
      setShowJump(!stick.current);
    } else el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.clientHeight - el.scrollTop < 40;
    memory.set(thread.id, { top: el.scrollTop, limit });
    if (showJump === stick.current) setShowJump(!stick.current);
    if (el.scrollTop < 400) loadEarlier();
  };

  return (
    <div class="thread" ref={ref} onScroll={onScroll} onClick={onLinkClick}>
      {thread.id !== 'main' && <SubagentHeader thread={thread} />}
      {hidden > 0 && (
        <button class="show-earlier" onClick={() => loadEarlier()}>
          Show earlier ({hidden} more)
        </button>
      )}
      {visible.map((it) => (
        <ItemView key={it.id} item={it} config={config} />
      ))}
      {draft !== undefined && <Draft text={draft} math={config.renderMath} />}
      {thread.status === 'running' && draft === undefined && <div class="working">{thread.id === 'main' ? 'Working…' : 'Subagent working…'}</div>}
      {showJump && (
        <button class="jump" onClick={() => ((stick.current = true), (ref.current!.scrollTop = ref.current!.scrollHeight), setShowJump(false))}>
          ↓ Latest
        </button>
      )}
    </div>
  );
}

/**
 * Drop items that render as nothing (hidden thinking / activity), and merge
 * consecutive activity groups so a run of tool calls reads as one line.
 */
function mergeActivity(items: Item[], config: ViewConfig): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (it.kind === 'thinking' && !config.showThinking) continue;
    if (it.kind === 'tools') {
      if (config.toolActivity === 'hidden') continue;
      const last = out[out.length - 1];
      if (last?.kind === 'tools') {
        out[out.length - 1] = { ...last, tools: [...last.tools, ...it.tools] };
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

function onLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a[data-href]');
  if (!a) return;
  e.preventDefault();
  send({ t: 'openLink', href: a.getAttribute('data-href')! });
}

function SubagentHeader({ thread }: { thread: ThreadMeta }) {
  return (
    <div class="sub-header" style={{ '--agent-hue': String(hue(thread.id)) }}>
      <div>
        <strong>{thread.title}</strong>
        <span class="muted">
          {' '}
          · {[thread.agentType, thread.model, thread.background ? 'background' : ''].filter(Boolean).join(' · ')} · {statusWord(thread.status)}
        </span>
      </div>
      {thread.status === 'running' && thread.taskId && (
        <button class="secondary small" onClick={() => send({ t: 'stopTask', taskId: thread.taskId! })}>
          Stop this subagent
        </button>
      )}
    </div>
  );
}

function statusWord(s: ThreadMeta['status']) {
  return { running: 'running', done: 'finished', error: 'failed', stopped: 'stopped' }[s];
}

// Streaming reply: finished paragraphs render once (memoized, cached HTML);
// only the paragraph being written re-renders per frame.
const DraftBlock = memo(({ text }: { text: string; math: boolean }) => <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />);

function Draft({ text, math }: { text: string; math: boolean }) {
  const { blocks, tail } = (window as any).__fullDraft ? { blocks: [], tail: text } : splitDraft(text); // __fullDraft: benchmark baseline
  return (
    <div class="msg assistant streaming">
      {blocks.map((b, i) => (
        <DraftBlock key={i} text={b} math={math} />
      ))}
      <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(tail, false) + '<span class="caret"></span>' }} />
    </div>
  );
}

const ItemView = memo(function ItemView({ item, config }: { item: Item; config: ViewConfig }) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} math={config.renderMath} />;
    case 'trust':
      return <TrustCard item={item} />;
    case 'signin':
      return (
        <div class={`card signin ${item.state === 'done' ? 'done' : 'pending'}`}>
          <div class="card-title">{item.state === 'done' ? '✓ Signed in — you can continue.' : item.reason}</div>
          {item.state !== 'done' && (
            <>
              <div class="muted">
                Signing in runs Claude Code's own sign-in in a terminal and opens your browser; the panel never sees your password or tokens.
              </div>
              <div class="buttons">
                <button disabled={item.state === 'working'} onClick={() => send({ t: 'signIn' })}>
                  {item.state === 'working' ? 'Waiting for the browser sign-in…' : 'Sign in'}
                </button>
              </div>
            </>
          )}
        </div>
      );
    case 'text':
      return (
        <div class="msg assistant">
          <Markdown text={item.text} math={config.renderMath} />
          <CopyButton text={item.text} />
        </div>
      );
    case 'thinking':
      return config.showThinking ? (
        <details class="thinking">
          <summary>Thinking</summary>
          <Markdown text={item.text} math={config.renderMath} />
        </details>
      ) : null;
    case 'tools':
      return <Tools item={item} mode={config.toolActivity} />;
    case 'agent': {
      const t = state.threads.find((x) => x.id === item.threadId);
      return (
        <button class="agent-link" style={{ '--agent-hue': String(hue(item.threadId)) }} onClick={() => setActive(item.threadId)}>
          <StatusDot status={t?.status ?? 'running'} />
          <span>
            Subagent <strong>{item.title}</strong>
            {item.agentType ? <span class="muted"> · {item.agentType}</span> : null}
          </span>
          <span class="muted">open tab →</span>
        </button>
      );
    }
    case 'prompt':
      return (
        <details class="prompt" open={item.text.length < 600}>
          <summary>Task given by the main agent</summary>
          <Markdown text={item.text} math={config.renderMath} />
        </details>
      );
    case 'permission':
      return <Permission item={item} />;
    case 'question':
      return <QuestionCard item={item} />;
    case 'plan':
      return <PlanCard item={item} math={config.renderMath} />;
    case 'notice':
      return <div class={`notice ${item.level}`}>{item.text}</div>;
    case 'unknown':
      return (
        <details class="unknown">
          <summary>Unsupported event from Claude Code: {item.label}</summary>
          <pre>{item.raw}</pre>
        </details>
      );
  }
});

function TrustCard({ item }: { item: Extract<Item, { kind: 'trust' }> }) {
  const answer = (choice: 'trust' | 'notNow' | 'never') => send({ t: 'trust', id: item.id, choice });
  if (item.state === 'trusted') return <div class="notice info">✓ You trust {item.folder}. Claude Code now uses its settings.</div>;
  if (item.state === 'declined') return <div class="notice info">Not trusted: Claude Code ignores the settings in {item.folder}.</div>;
  if (item.state === 'failed')
    return (
      <div class="card trust failed">
        <div class="card-title">Claude Code did not record the trust for {item.folder}.</div>
        <div class="muted">
          Try again (this restarts Claude Code for this session; the conversation continues). If it still fails: open a terminal there, run “claude”, accept
          the question, then type /exit.
        </div>
        <div class="buttons">
          <button onClick={() => answer('trust')}>Try again</button>
        </div>
      </div>
    );
  return (
    <div class="card trust pending">
      <div class="card-title">
        Do you trust the files in <strong>{item.folder}</strong>?
      </div>
      <div class="muted">
        Trusting lets Claude Code use this folder's own settings: permission rules and hooks in <code>.claude/</code>, and MCP servers in <code>.mcp.json</code>.
        Hooks and MCP servers run programs, so only trust folders whose contents you know. Without trust, Claude Code still works here but ignores those
        settings. Claude Code remembers the answer.
      </div>
      <div class="buttons">
        <button onClick={() => answer('trust')}>Trust this folder</button>
        <button class="secondary" onClick={() => answer('notNow')}>
          Not now
        </button>
        <button class="secondary" onClick={() => answer('never')}>
          Don't ask again for this folder
        </button>
      </div>
    </div>
  );
}

function UserMessage({ item, math }: { item: Extract<Item, { kind: 'user' }>; math: boolean }) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);
  const rewind = (mode: 'code' | 'fork' | 'both') => {
    setMenu(false);
    if (item.uuid) send({ t: 'rewind', uuid: item.uuid, mode });
  };
  return (
    <div class="msg user">
      {item.images && (
        <div class="images">
          {item.images.map((src, i) => (
            <img key={i} src={src} class="thumb" />
          ))}
        </div>
      )}
      {item.text && <Markdown text={item.text} math={math} />}
      {item.uuid && (
        <button
          class="rewind"
          title="Rewind to this message…"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(!menu);
          }}
        >
          ↶
        </button>
      )}
      {menu && (
        <div class="rewind-menu" onClick={(e) => e.stopPropagation()}>
          <div class="menu-item" onClick={() => rewind('fork')} title="Start a new conversation from just before this message, with it ready to edit">
            Fork conversation from here
          </div>
          <div class="menu-item" onClick={() => rewind('code')} title="Restore files Claude changed to how they were when you sent this">
            Rewind code to here
          </div>
          <div class="menu-item" onClick={() => rewind('both')}>
            Fork conversation and rewind code
          </div>
          <div class="menu-note">Changes made by hand or by shell commands are not undone.</div>
        </div>
      )}
    </div>
  );
}

const Markdown = ({ text, math }: { text: string; math: boolean }) => {
  const html = useMemo(() => renderMarkdown(text), [text, math]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
};

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      class="copy"
      title="Copy as Markdown (with LaTeX source)"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  );
}

function Tools({ item, mode }: { item: Extract<Item, { kind: 'tools' }>; mode: ViewConfig['toolActivity'] }) {
  const [open, setOpen] = useState(false);
  if (mode === 'hidden') return null;
  const running = item.tools.some((t) => t.status === 'running');
  const failed = item.tools.filter((t) => t.status === 'error').length;
  const counts = new Map<string, number>();
  for (const t of item.tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const summary = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
  const expanded = mode === 'detailed' || open;
  return (
    <div class="tools">
      <button class="tools-line" onClick={() => setOpen(!open)}>
        <span class={running ? 'spin' : ''}>{running ? '◌' : '⚙'}</span> {item.tools.length} action{item.tools.length > 1 ? 's' : ''}: {summary}
        {failed ? <span class="err"> · {failed} failed</span> : null}
      </button>
      {expanded && (
        <ul>
          {item.tools.map((t) => (
            <li key={t.id} class={t.status}>
              <span class="tool-name">{t.name}</span> {t.summary}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- interactive cards -----------------------------------------------------

function Permission({ item }: { item: Extract<Item, { kind: 'permission' }> }) {
  const [msg, setMsg] = useState('');
  const pending = item.state === 'pending';
  return (
    <div class={`card permission ${item.state}`}>
      <div class="card-title">
        {pending ? 'Allow' : { allowed: 'Allowed', denied: 'Denied', cancelled: 'Cancelled', pending: '' }[item.state]} <strong>{item.tool}</strong>
        {pending ? '?' : ''}
      </div>
      <pre class="detail">{item.detail}</pre>
      {pending && (
        <>
          <div class="buttons">
            <button onClick={() => send({ t: 'permission', id: item.id, allow: true })}>Allow</button>
            {item.suggestions.map((s, i) => (
              <button key={i} class="secondary" onClick={() => send({ t: 'permission', id: item.id, allow: true, suggestion: i })}>
                {s}
              </button>
            ))}
            <button class="danger" onClick={() => send({ t: 'permission', id: item.id, allow: false, message: msg })}>
              Deny
            </button>
          </div>
          <input class="reason" placeholder="Optional: tell Claude what to do instead (sent with Deny)" value={msg} onInput={(e) => setMsg((e.target as HTMLInputElement).value)} />
        </>
      )}
    </div>
  );
}

function QuestionCard({ item }: { item: Extract<Item, { kind: 'question' }> }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const pending = item.state === 'pending';
  const toggle = (q: Question, label: string) => {
    const cur = picked[q.question] ?? [];
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setPicked({ ...picked, [q.question]: next });
  };
  const answers = () => {
    const out: Record<string, string> = {};
    for (const q of item.questions) {
      const vals = [...(picked[q.question] ?? [])];
      if (other[q.question]?.trim()) vals.push(other[q.question].trim());
      out[q.question] = vals.join(', ');
    }
    return out;
  };
  const complete = item.questions.every((q) => (picked[q.question]?.length ?? 0) > 0 || other[q.question]?.trim());
  return (
    <div class={`card question ${item.state}`}>
      {item.questions.map((q) => (
        <div key={q.question} class="q">
          <div class="q-header">{q.header}</div>
          <div class="q-text">{q.question}</div>
          {pending ? (
            <>
              {q.options.map((o) => {
                const on = (picked[q.question] ?? []).includes(o.label);
                return (
                  <button key={o.label} class={`option ${on ? 'on' : ''}`} onClick={() => toggle(q, o.label)}>
                    <span class="opt-label">{q.multiSelect ? (on ? '☑' : '☐') : on ? '◉' : '○'} {o.label}</span>
                    <span class="opt-desc">{o.description}</span>
                  </button>
                );
              })}
              <input class="reason" placeholder="Other…" value={other[q.question] ?? ''} onInput={(e) => setOther({ ...other, [q.question]: (e.target as HTMLInputElement).value })} />
            </>
          ) : (
            <div class="answer">→ {item.answers?.[q.question] ?? '(no answer)'}</div>
          )}
        </div>
      ))}
      {pending && (
        <div class="buttons">
          <button disabled={!complete} onClick={() => send({ t: 'answer', id: item.id, answers: answers() })}>
            Submit
          </button>
          <button class="secondary" onClick={() => send({ t: 'answer', id: item.id, answers: null })}>
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

function PlanCard({ item, math }: { item: Extract<Item, { kind: 'plan' }>; math: boolean }) {
  const [fb, setFb] = useState('');
  const pending = item.state === 'pending';
  return (
    <div class={`card plan ${item.state}`}>
      <div class="card-title">Plan {pending ? '— approve?' : `(${item.state})`}</div>
      <Markdown text={item.plan} math={math} />
      {pending && (
        <>
          <div class="buttons">
            <button onClick={() => send({ t: 'plan', id: item.id, approve: true, mode: 'acceptEdits' })}>Approve, auto-accept edits</button>
            <button class="secondary" onClick={() => send({ t: 'plan', id: item.id, approve: true, mode: 'default' })}>
              Approve, ask before edits
            </button>
            <button class="danger" onClick={() => send({ t: 'plan', id: item.id, approve: false, feedback: fb })}>
              Keep planning
            </button>
          </div>
          <textarea class="reason" rows={2} placeholder="Feedback for Claude (sent with Keep planning)" value={fb} onInput={(e) => setFb((e.target as HTMLTextAreaElement).value)} />
        </>
      )}
    </div>
  );
}

// --- composer --------------------------------------------------------------

function Composer({ status, thread, config }: { status: Status; thread: ThreadMeta; config: ViewConfig }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState<string>(() => vscode.getState()?.draft ?? '');
  const [menu, setMenu] = useState<{ kind: '/' | '@'; items: string[]; sel: number; start: number } | null>(null);
  const history = useRef<string[]>([]);
  const histPos = useRef(-1);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [imageError, setImageError] = useState('');

  useEffect(() => {
    const onFiles = (_q: string, files: string[]) =>
      setMenu((m) => (m?.kind === '@' ? { ...m, items: files, sel: 0 } : m));
    const onPrefill = (t: string) => {
      update(t);
      requestAnimationFrame(() => ref.current?.focus());
    };
    fileListeners.add(onFiles);
    prefillListeners.add(onPrefill);
    return () => {
      fileListeners.delete(onFiles);
      prefillListeners.delete(onPrefill);
    };
  }, []);

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (files.length && !imgs.length) setImageError('Only PNG, JPEG, GIF and WebP images can be attached.');
    for (const f of imgs) {
      try {
        const att = await toAttachment(f);
        setImages((cur) => (cur.length >= 10 ? cur : [...cur, att]));
        setImageError('');
      } catch (e) {
        setImageError(String((e as Error).message ?? e));
      }
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()!).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };
  const onDrop = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 300) + 'px';
  }, [text]);

  const update = (v: string) => {
    setText(v);
    vscode.setState({ ...(vscode.getState() ?? {}), draft: v });
    const caret = ref.current?.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const slash = before.match(/^\/([\w:-]*)$/);
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (slash) {
      const q = slash[1].toLowerCase();
      const items = status.commands.filter((c) => c.toLowerCase().includes(q)).slice(0, 12);
      setMenu(items.length ? { kind: '/', items, sel: 0, start: 0 } : null);
    } else if (at) {
      setMenu({ kind: '@', items: menu?.kind === '@' ? menu.items : [], sel: 0, start: caret - at[1].length - 1 });
      send({ t: 'findFiles', query: at[1] });
    } else if (menu) setMenu(null);
  };

  const choose = (value: string) => {
    if (!menu) return;
    const el = ref.current!;
    const caret = el.selectionStart;
    const insert = menu.kind === '/' ? `/${value} ` : `@${value} `;
    const v = text.slice(0, menu.start) + insert + text.slice(caret);
    setMenu(null);
    update(v);
    requestAnimationFrame(() => el.setSelectionRange(menu.start + insert.length, menu.start + insert.length));
    el.focus();
  };

  const submit = () => {
    const v = text.trim();
    if (!v && !images.length) return;
    send({ t: 'send', text: v, images: images.length ? images : undefined });
    if (v) history.current.push(v);
    histPos.current = -1;
    update('');
    setImages([]);
    setActive('main');
  };

  const onKey = (e: KeyboardEvent) => {
    if (menu && menu.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setMenu({ ...menu, sel: (menu.sel + d + menu.items.length) % menu.items.length });
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        choose(menu.items[menu.sel]);
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        setMenu(null);
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Escape' && status.busy) {
      send({ t: 'interrupt' });
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp' && !text && history.current.length) {
      histPos.current = histPos.current < 0 ? history.current.length - 1 : Math.max(0, histPos.current - 1);
      update(history.current[histPos.current]);
      e.preventDefault();
      return;
    }
    const sendKey = config.enterToSend ? e.key === 'Enter' && !e.shiftKey && !e.isComposing : e.key === 'Enter' && (e.ctrlKey || e.metaKey);
    if (sendKey) {
      submit();
      e.preventDefault();
    }
  };

  const placeholder =
    thread.id === 'main' ? (status.busy ? 'Claude is working — messages you send now are queued' : 'Message Claude  (/ commands, @ files)') : 'Messages go to the main agent';
  return (
    <div class="composer">
      {menu && menu.items.length > 0 && (
        <div class="menu">
          {menu.items.map((it, i) => (
            <div key={it} class={`menu-item ${i === menu.sel ? 'sel' : ''}`} onMouseDown={(e) => (e.preventDefault(), choose(it))}>
              {menu.kind}
              {it}
            </div>
          ))}
        </div>
      )}
      {(images.length > 0 || imageError) && (
        <div class="attachments">
          {images.map((im, i) => (
            <span key={i} class="attachment">
              <img src={`data:${im.mediaType};base64,${im.data}`} />
              <button class="remove" title="Remove" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
          {imageError && <span class="err">{imageError}</span>}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder}
        onInput={(e) => update((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      />
      {status.busy ? (
        <button class="danger" title="Stop (Esc)" onClick={() => send({ t: 'interrupt' })}>
          ■ Stop
        </button>
      ) : null}
      <button title={config.enterToSend ? 'Send (Enter)' : 'Send (Ctrl+Enter)'} disabled={!text.trim() && !images.length} onClick={submit}>
        Send
      </button>
    </div>
  );
}

/**
 * Read an image file for sending. Images larger than Claude uses anyway
 * (longest side over 1568 px) are scaled down, which also keeps them under
 * the API's size limit.
 */
async function toAttachment(f: File): Promise<ImageAttachment> {
  const MAX = 1568;
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('Could not read the image.'));
    r.readAsDataURL(f);
  });
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('Could not decode the image.'));
    img.src = dataUrl;
  });
  const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  let type = f.type as ImageAttachment['mediaType'];
  let out = dataUrl;
  if (scale < 1 || f.size > 3_500_000) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    type = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    out = c.toDataURL(type, 0.9);
  }
  const data = out.slice(out.indexOf(',') + 1);
  if (data.length > 6_500_000) throw new Error('That image is too large to send, even after scaling down.');
  return { mediaType: type, data };
}

// --- status bar ------------------------------------------------------------

const MODES: [string, string][] = [
  ['default', 'Ask before edits'],
  ['acceptEdits', 'Accept edits'],
  ['plan', 'Plan mode'],
  ['auto', 'Auto'],
];

function fmtTokens(n?: number) {
  if (n === undefined) return '?';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function resetIn(t?: number) {
  if (!t) return '';
  const mins = Math.round((t * 1000 - Date.now()) / 60000);
  if (mins < 0) return '';
  return mins < 60 ? ` (resets in ${mins} min)` : mins < 48 * 60 ? ` (resets in ${Math.round(mins / 60)} h)` : ` (resets in ${Math.round(mins / 1440)} d)`;
}

function StatusBar({ status, config }: { status: Status; config: ViewConfig }) {
  const model = status.models.find((m) => m.value === status.modelChoice);
  const efforts = model?.effortLevels ?? status.models.find((m) => m.value === 'default')?.effortLevels ?? [];
  const modes = MODES.some(([v]) => v === status.permissionMode) || !status.permissionMode ? MODES : [...MODES, [status.permissionMode, status.permissionMode] as [string, string]];
  const ctxTitle = status.contextBreakdown?.map((c) => `${c.name}: ${fmtTokens(c.tokens)}`).join('\n');
  const rl = status.rateLimits;
  return (
    <div class="statusbar">
      {status.starting && <span class="muted spin-text">starting Claude Code…</span>}
      <select title="Model" value={status.modelChoice ?? ''} onChange={(e) => send({ t: 'setModel', value: (e.target as HTMLSelectElement).value })}>
        {!status.modelChoice && <option value="">{status.model ?? 'model'}</option>}
        {status.models.map((m) => (
          <option key={m.value} value={m.value} title={m.description}>
            {m.displayName}
          </option>
        ))}
      </select>
      {efforts.length > 0 && (
        <select title="Effort" value={status.effort ?? ''} onChange={(e) => send({ t: 'setEffort', value: (e.target as HTMLSelectElement).value })}>
          {!status.effort && <option value="">effort</option>}
          {efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      )}
      <select title="Permission mode" value={status.permissionMode ?? ''} onChange={(e) => send({ t: 'setMode', value: (e.target as HTMLSelectElement).value })}>
        {modes.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <span class="sep" />
      <span class="stat" title={`Context: ${fmtTokens(status.contextTokens)} of ${fmtTokens(status.contextMax)} tokens\n${ctxTitle ?? ''}`} onClick={() => send({ t: 'refreshStatus' })}>
        ctx {status.contextPercent ?? '–'}%
      </span>
      <span class="stat" title="Share of the last turn's input read from the prompt cache">
        cache {status.cacheHitPercent ?? '–'}%
      </span>
      {rl && (
        <span class="stat" title={`Plan usage — 5-hour window: ${rl.fiveHour?.utilization ?? '?'}%${resetIn(rl.fiveHour?.resetsAt)}\n7-day window: ${rl.sevenDay?.utilization ?? '?'}%${resetIn(rl.sevenDay?.resetsAt)}`}>
          5h {rl.fiveHour?.utilization ?? '–'}% · 7d {rl.sevenDay?.utilization ?? '–'}%
        </span>
      )}
      <span class="sep" />
      <button
        class={`toggle remote ${status.remote.state}`}
        title={status.remote.state === 'on' ? `Remote control on — ${status.remote.url ?? ''}\nClick to turn off` : 'Remote control off — click to turn on'}
        onClick={() => send({ t: 'setRemote', on: status.remote.state !== 'on' })}
      >
        ⇄ RC
      </button>
      {status.remote.state === 'on' && status.remote.url && (
        <a class="stat" data-href={status.remote.url} href="#" onClick={onLinkClick} title="Open this session on claude.ai">
          open
        </a>
      )}
      <button class={`toggle ${config.renderMath ? 'on' : ''}`} title="Render LaTeX math" onClick={() => setConfig({ renderMath: !config.renderMath })}>
        ∑
      </button>
      <select
        title="Tool activity"
        value={config.toolActivity}
        onChange={(e) => setConfig({ toolActivity: (e.target as HTMLSelectElement).value as ViewConfig['toolActivity'] })}
      >
        <option value="hidden">tools: hidden</option>
        <option value="summary">tools: summary</option>
        <option value="detailed">tools: detailed</option>
      </select>
      <span class="grow" />
      <button class="toggle" title="Report a problem with this panel" onClick={() => send({ t: 'reportProblem' })}>
        ⚑
      </button>
      {status.update ? (
        <button class="update" title={`Claude Code ${status.update.latest} is available (you have ${status.update.current})`} onClick={() => send({ t: 'runUpdate' })}>
          ↑ {status.update.latest}
        </button>
      ) : (
        <span class="muted" title="Claude Code version">
          {status.version ? `v${status.version}` : ''}
        </span>
      )}
    </div>
  );
}

render(<App />, document.getElementById('root')!);
