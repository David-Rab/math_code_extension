// Pinned sessions and session groups for the Sessions side bar. Kept in the
// extension's own storage: nothing is written into the conversations themselves.
import type { Memento } from 'vscode';

export interface Organizer {
  pins: string[]; // session ids, in the order they were pinned
  groups: Record<string, string>; // session id -> group name
}

const KEY = 'claudePanel.sessionOrganizer';
const ID = /^[0-9a-f-]{36}$/i;

export function cleanGroupName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const n = name.replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || undefined;
}

/** Keep only what the panel could have stored itself. */
export function cleanOrganizer(raw: unknown): Organizer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pins = Array.isArray(r.pins) ? [...new Set(r.pins.filter((x): x is string => typeof x === 'string' && ID.test(x)))] : [];
  const groups: Record<string, string> = {};
  if (r.groups && typeof r.groups === 'object')
    for (const [id, name] of Object.entries(r.groups as Record<string, unknown>)) {
      const n = cleanGroupName(name);
      if (ID.test(id) && n) groups[id] = n;
    }
  return { pins, groups };
}

export interface Arranged<S> {
  pinned: S[];
  groups: { name: string; sessions: S[] }[];
  rest: S[];
}

/**
 * How the side bar lists sessions: pinned ones first (in the order pinned),
 * then each group by name, then the others. Within a group and among the
 * others the given order (most recent first) is kept. A pinned session is
 * listed once, under the pins.
 */
export function arrange<S extends { id: string }>(sessions: S[], o: Organizer): Arranged<S> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const pinned = o.pins.map((id) => byId.get(id)).filter((s): s is S => !!s);
  const isPinned = new Set(pinned.map((s) => s.id));
  const groups = new Map<string, S[]>();
  const rest: S[] = [];
  for (const s of sessions) {
    if (isPinned.has(s.id)) continue;
    const g = o.groups[s.id];
    if (!g) rest.push(s);
    else groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  return {
    pinned,
    groups: [...groups].map(([name, list]) => ({ name, sessions: list })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    rest,
  };
}

let state: Memento | undefined;
let current: Organizer = { pins: [], groups: {} };

export function initOrganizer(globalState: Memento) {
  state = globalState;
  current = cleanOrganizer(globalState.get(KEY));
}

export function organizer(): Organizer {
  return current;
}

function save(next: Organizer) {
  current = cleanOrganizer(next);
  void state?.update(KEY, current);
}

export function setPinned(id: string, on: boolean) {
  const pins = current.pins.filter((x) => x !== id);
  save({ ...current, pins: on ? [...pins, id] : pins });
}

/** Put a session in a group, or take it out of its group with `undefined`. */
export function setGroup(id: string, group: string | undefined) {
  const groups = { ...current.groups };
  const name = cleanGroupName(group);
  if (name) groups[id] = name;
  else delete groups[id];
  save({ ...current, groups });
}

/** Rename a group, or dissolve it with `undefined` (its sessions go back to the plain list). */
export function renameGroup(from: string, to: string | undefined) {
  const name = cleanGroupName(to);
  const groups: Record<string, string> = {};
  for (const [id, g] of Object.entries(current.groups)) {
    if (g !== from) groups[id] = g;
    else if (name) groups[id] = name;
  }
  save({ ...current, groups });
}

/** A deleted session leaves nothing behind. */
export function forget(id: string) {
  if (!current.pins.includes(id) && !(id in current.groups)) return;
  const groups = { ...current.groups };
  delete groups[id];
  save({ pins: current.pins.filter((x) => x !== id), groups });
}

export function groupNames(): string[] {
  return [...new Set(Object.values(current.groups))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
