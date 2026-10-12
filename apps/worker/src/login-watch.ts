/**
 * Google login watch (M9 #2).
 *
 * Company Google accounts are often made to sign in again every day or so. When
 * that happens the Application Default Credentials the worker borrows stop
 * working, and every task it claims would fail with an auth error. So in vertex
 * mode the worker re-checks the login every AGENT_AUTH_RECHECK_MS by minting an
 * access token: the same refresh Claude Code does on each spawn, without a model
 * call (free).
 *
 *   - Login gone (Google says the grant is expired/revoked, or no login is found
 *     twice in a row; one bad read can be gcloud rewriting the file): stop
 *     offering Claude (the worker stays registered and keeps heartbeating, so the
 *     setup checklist shows why) and record the failure in credential health,
 *     which sends ONE notification per expiry.
 *   - Login back (the operator signed in again; the file is mounted live): record
 *     recovery, and let a real preflight bring Claude back.
 *   - Network trouble or an error that isn't about the login: nothing changes.
 *   - A credential type this check can't refresh itself (workload identity
 *     federation, impersonation): said once in the log; only failed tasks reveal
 *     an expiry then.
 *
 * A task that fails with a Google auth error calls `confirm()`, which checks at
 * once: the task is reported as "login expired" (and the worker stops claiming
 * immediately) only if Google confirms it.
 */
import type { VertexCheckCode } from '@asf/shared';
import { googleLoginFix } from '@asf/shared';

export type LoginCheckResult = { ok: true; account?: string } | { ok: false; code: VertexCheckCode; reason: string; kind?: string };
export type LoginCheck = () => Promise<LoginCheckResult>;

export interface LoginWatchDeps {
  check: LoginCheck;
  /** Hold / release the anthropic runtimes (RuntimeOffer.suspend / resume). */
  suspend: (reason: string) => void;
  resume: () => void;
  /** Credential health in the registry: one notification per failure streak. `reason` excludes the fix; `fix` says what to do. */
  record: (h: { ok: boolean; reason: string | null; fix?: string }) => Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  worker: string;
  intervalMs: number;
  now?: () => number;
  /** Pause before re-reading a login file that was missing or unreadable. */
  sleep?: (ms: number) => Promise<void>;
}

export const NO_LOGIN_RECHECK_MS = 2_000;

export class LoginWatch {
  private lastAt = 0;
  private expired: string | null = null;
  private recorded: string | null = null;
  private unsupportedLogged = false;
  private running: Promise<boolean> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly d: LoginWatchDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get isExpired(): boolean { return this.expired !== null; }
  /** Why Claude is held, for /health. */
  get reason(): string | null { return this.expired; }

  /**
   * Call on every heartbeat with the current anthropic mode (null = unknown: the
   * api is unreachable, keep what we have). Checks when due; returns true when
   * the offered runtimes may have changed (re-register).
   */
  async tick(mode: string | null): Promise<boolean> {
    if (mode !== 'vertex') {
      if (this.expired !== null && mode !== null) {
        // Moved off Vertex: the old expiry no longer applies; the normal preflight decides.
        this.expired = null;
        this.d.resume();
        await this.recordOk();
        return true;
      }
      return false;
    }
    if (this.running || this.now() - this.lastAt < this.d.intervalMs) return false;
    return this.run();
  }

  /** Check on the next tick. */
  poke(): void { this.lastAt = 0; }

  /**
   * A task just failed with what looks like a Google auth error: check now.
   * True only when Google confirms the login is gone (the caller then reports the
   * task as "login expired"; otherwise the task keeps its own error).
   */
  async confirm(): Promise<boolean> {
    if (this.running) await this.running; else await this.run();
    return this.expired !== null;
  }

  private run(): Promise<boolean> {
    const p = this.check().finally(() => { this.running = null; });
    this.running = p;
    return p;
  }

  private async check(): Promise<boolean> {
    this.lastAt = this.now();
    let r = await this.d.check();
    // gcloud rewrites the file while you sign in, a bind mount can blink: re-read once.
    if (!r.ok && r.code === 'no_login') { await this.sleep(NO_LOGIN_RECHECK_MS); r = await this.d.check(); }
    if (r.ok) {
      if (this.expired === null) return false;
      this.d.log('google login works again; re-checking Claude', { account: r.account });
      this.expired = null;
      this.d.resume();
      await this.recordOk();
      return true;
    }
    if (r.code === 'unsupported_login') {
      if (!this.unsupportedLogged) this.d.log(`google login can't be watched for expiry here (${r.kind ?? 'unknown'} credential); an expiry will show up as failed tasks instead`);
      this.unsupportedLogged = true;
      return false;
    }
    if (r.code !== 'no_login' && r.code !== 'login_expired') {
      this.d.log(`google login check inconclusive (${r.code}): ${r.reason}`);
      return false;
    }
    const first = this.expired === null;
    const what = r.code === 'no_login' ? 'no Google login was found' : 'Google says the login has expired or was revoked';
    const short = `Claude on Google Cloud stopped working on worker ${this.d.worker}: ${what}.`;
    const fix = googleLoginFix(this.d.worker, r.kind);
    this.expired = `${short} ${fix}`;
    if (first) this.d.log('google login gone; no longer taking Claude tasks', { code: r.code });
    this.d.suspend(this.expired);
    if (this.recorded !== short) {
      await this.d.record({ ok: false, reason: short, fix }).then(() => { this.recorded = short; }, (e) => this.d.log(`could not record login health: ${e}`));
    }
    return first;
  }

  private async recordOk(): Promise<void> {
    await this.d.record({ ok: true, reason: null }).then(() => { this.recorded = null; }, () => {});
  }
}
