// The model, effort and permission mode you last picked in a panel. New tabs
// start with them. Kept in the extension's own user-level storage, which a
// workspace folder cannot write.
import type { Memento } from 'vscode';

export interface LastUsed {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/** Only the modes the panel's own picker offers. Never bypassPermissions. */
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const KEY = 'claudePanel.lastUsed';

/** Keep only values the panel could have stored itself; drop everything else. */
export function cleanLastUsed(raw: unknown): LastUsed {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: LastUsed = {};
  // 'default' is the picker's "your Claude Code default": nothing to pass on.
  if (typeof r.model === 'string' && /^[\w.[\]:-]{1,80}$/.test(r.model) && r.model !== 'default') out.model = r.model;
  if (typeof r.effort === 'string' && EFFORTS.has(r.effort)) out.effort = r.effort;
  if (typeof r.permissionMode === 'string' && MODES.has(r.permissionMode)) out.permissionMode = r.permissionMode;
  return out;
}

let state: Memento | undefined;
let current: LastUsed = {};
const listeners = new Set<() => void>();

export function initPrefs(globalState: Memento) {
  state = globalState;
  current = cleanLastUsed(globalState.get(KEY));
}

export function lastUsed(): LastUsed {
  return current;
}

/** Runs after the remembered picks change. */
export function onLastUsedChange(l: () => void) {
  listeners.add(l);
}

export function rememberLastUsed(patch: LastUsed) {
  const next = cleanLastUsed({ ...current, ...patch });
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  void state?.update(KEY, next);
  for (const l of listeners) l();
}
