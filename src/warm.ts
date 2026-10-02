// Keeps one claude.exe process started in the background, so a new session
// skips Claude Code's 8–30 s startup. The spare is bound to a panel only when
// taken, through a late-bound hooks holder.
import { startup, type WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import { buildOptions, launchSettings, type SessionHooks } from './session';
import { readConfig, log } from './config';
import type { LastUsed } from './prefs';

interface Spare {
  cwd: string;
  /** The model, effort and permission mode it was started with. */
  started: string;
  warm: Promise<WarmQuery | undefined>;
  ready?: WarmQuery;
  holder: { hooks?: SessionHooks };
}

export class WarmPool {
  private spare?: Spare;
  private timer?: NodeJS.Timeout;

  /**
   * Adopt the spare process if it is ready, started in the same folder, and
   * started with the model, effort and permission mode this session wants.
   */
  take(cwd: string, hooks: SessionHooks, picks: LastUsed = {}): WarmQuery | undefined {
    const s = this.spare;
    if (!s?.ready || s.cwd !== cwd || s.started !== JSON.stringify(launchSettings(picks))) return undefined;
    this.spare = undefined;
    s.holder.hooks = hooks;
    log('using pre-warmed process');
    return s.ready;
  }

  isReady(cwd: string) {
    return !!this.spare?.ready && this.spare.cwd === cwd;
  }

  fill(cwd: string) {
    if (!readConfig().prewarm) return;
    const started = JSON.stringify(launchSettings());
    if (this.spare?.cwd === cwd && this.spare.started === started) return;
    this.discard();
    const holder: Spare['holder'] = {};
    const spare: Spare = { cwd, started, holder, warm: Promise.resolve(undefined) };
    spare.warm = startup({ options: buildOptions(cwd, () => holder.hooks) })
      .then((w) => {
        if (this.spare === spare) spare.ready = w;
        else w.close();
        return w;
      })
      .catch((e) => {
        log(`pre-warm failed: ${(e as Error).message}`);
        if (this.spare === spare) this.spare = undefined;
        return undefined;
      });
    this.spare = spare;
  }

  /** Start the next spare shortly after one was used, off the critical path. */
  refillSoon(cwd: string) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fill(cwd), 5000);
  }

  /** The model, effort or permission mode for new tabs changed: replace a spare started with the old ones. */
  refresh() {
    if (this.spare) this.fill(this.spare.cwd);
  }

  discard() {
    const s = this.spare;
    this.spare = undefined;
    void s?.warm.then((w) => w?.close());
  }

  dispose() {
    clearTimeout(this.timer);
    this.discard();
  }
}
