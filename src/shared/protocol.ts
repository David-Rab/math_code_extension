// Types shared by the extension host and the webview.

export type ThreadStatus = 'running' | 'done' | 'error' | 'stopped';

export interface ThreadMeta {
  id: string; // 'main' or the tool_use id of the Agent call that started it
  title: string;
  agentType?: string;
  model?: string;
  parentId?: string; // thread that launched it
  status: ThreadStatus;
  background?: boolean;
  taskId?: string; // for stopping a background subagent
}

export interface ToolCall {
  id: string;
  name: string;
  summary: string;
  status: 'running' | 'done' | 'error';
}

export interface QuestionOption { label: string; description: string }
export interface Question { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }

export type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tools'; id: string; tools: ToolCall[] }
  | { kind: 'agent'; id: string; threadId: string; title: string; agentType?: string }
  | { kind: 'prompt'; id: string; text: string } // the task a subagent was given
  | {
      kind: 'permission';
      id: string;
      tool: string;
      detail: string;
      suggestions: string[];
      state: 'pending' | 'allowed' | 'denied' | 'cancelled';
    }
  | { kind: 'question'; id: string; questions: Question[]; state: 'pending' | 'answered' | 'cancelled'; answers?: Record<string, string> }
  | { kind: 'plan'; id: string; plan: string; state: 'pending' | 'approved' | 'rejected' | 'cancelled' }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'unknown'; id: string; label: string; raw: string };

export interface ModelChoice {
  value: string;
  displayName: string;
  description: string;
  effortLevels: string[];
}

export interface RateWindow { utilization: number; resetsAt?: number }

export interface Status {
  sessionId?: string;
  title?: string;
  cwd?: string;
  version?: string;
  model?: string; // resolved model id currently in use
  modelChoice?: string; // value from the picker, when known
  models: ModelChoice[];
  permissionMode?: string;
  effort?: string | null;
  contextPercent?: number;
  contextTokens?: number;
  contextMax?: number;
  contextBreakdown?: { name: string; tokens: number }[];
  cacheHitPercent?: number; // share of last turn's input served from cache
  rateLimits?: { fiveHour?: RateWindow; sevenDay?: RateWindow };
  remote: { state: 'off' | 'connecting' | 'on' | 'error'; url?: string };
  commands: string[];
  busy: boolean;
  starting: boolean;
  update?: { latest: string; current: string };
}

export interface ViewConfig {
  renderMath: boolean;
  toolActivity: 'hidden' | 'summary' | 'detailed';
  showThinking: boolean;
  enterToSend: boolean;
  mathMacros: Record<string, string>;
}

export interface Snapshot {
  threads: ThreadMeta[];
  items: Record<string, Item[]>;
  drafts: Record<string, string>;
  status: Status;
  config: ViewConfig;
}

export type HostToView =
  | { t: 'snapshot'; snapshot: Snapshot }
  | { t: 'thread'; thread: ThreadMeta }
  | { t: 'item'; threadId: string; item: Item } // append, or replace the item with the same id
  | { t: 'draft'; threadId: string; text: string | null }
  | { t: 'status'; status: Partial<Status> }
  | { t: 'config'; config: ViewConfig }
  | { t: 'fileMatches'; query: string; files: string[] };

export type ViewToHost =
  | { t: 'ready' }
  | { t: 'send'; text: string }
  | { t: 'interrupt' }
  | { t: 'permission'; id: string; allow: boolean; suggestion?: number; message?: string }
  | { t: 'answer'; id: string; answers: Record<string, string> | null }
  | { t: 'plan'; id: string; approve: boolean; feedback?: string; mode?: string }
  | { t: 'stopTask'; taskId: string }
  | { t: 'setModel'; value: string }
  | { t: 'setMode'; value: string }
  | { t: 'setEffort'; value: string }
  | { t: 'setRemote'; on: boolean }
  | { t: 'setConfig'; config: Partial<ViewConfig> }
  | { t: 'openLink'; href: string }
  | { t: 'findFiles'; query: string }
  | { t: 'refreshStatus' }
  | { t: 'runUpdate' }
  | { t: 'log'; text: string };
