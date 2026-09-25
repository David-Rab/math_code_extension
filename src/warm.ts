// Keeps one claude.exe process started in the background, so a new session
// skips Claude Code's 8–30 s startup. The spare is bound to a panel only when
// taken, through a late-bound hooks holder.
import { startup, type WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import { buildOptions, type SessionHooks } from './session';
import { readConfig, log } from './config';

interface Spare {
  cwd: string;
  warm: Promise<WarmQuery | undefined>;
  ready?: WarmQuery;
  holder: { hooks?: SessionHooks };
}

export class WarmPool {
  private spare?: Spare;
  private timer?: NodeJS.Timeout;

  /** Adopt the spare process if it is ready and started in the same folder. */
  take(cwd: string, hooks: SessionHooks): WarmQuery | undefined {
    const s = this.spare;
    if (!s?.ready || s.cwd !== cwd) return undefined;
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
    if (this.spare?.cwd === cwd) return;
    this.discard();
    const holder: Spare['holder'] = {};
    const spare: Spare = { cwd, holder, warm: Promise.resolve(undefined) };
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
