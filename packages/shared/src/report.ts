import type { Run, RunTask, RunEvent } from './run.js';

/**
 * The story of a run in one place (M11 WP6): dispatch, each role task (what it
 * was asked/said/changed, cost, turns), the review loop with its verdicts, gate
 * decisions, needs-human Q&A, delivery, and a cost table by role and by cycle.
 *
 * PURE — takes data already stored (run + tasks + events + artifact versions),
 * returns Markdown + a one-paragraph summary (for a failure/cancel notification).
 * Tolerant of pre-M11 runs: provenance/diff/result fields are all optional.
 */
export interface ReportArtifact { name: string; taskId: string | null; attempt: number | null; source: string; content: string; }

export interface RunReportInput {
  run: Run;
  tasks: RunTask[];
  events: RunEvent[];
  artifacts: ReportArtifact[]; // every version (from listArtifactVersions)
}

const money = (n: number) => `$${n.toFixed(2)}`;
const ev = (events: RunEvent[], kind: string, taskId?: string) =>
  [...events].reverse().find((e) => e.kind === kind && (taskId === undefined || e.taskId === taskId));
const p = (e: RunEvent | undefined) => (e?.payload ?? {}) as Record<string, unknown>;

/** A one-paragraph plain-text summary — the headline for a notification. */
export function runReportSummary(input: RunReportInput): string {
  const { run, tasks, events } = input;
  const roleTasks = tasks.filter((t) => t.runtime !== 'publish');
  const loops = events.filter((e) => e.kind === 'review:loop').length;
  const disputed = ev(events, 'loop:disputed');
  const exhausted = ev(events, 'loop:exhausted');
  const failed = roleTasks.find((t) => t.state === 'failed');
  const bits: string[] = [`${run.ticketKey}: ${run.state}`];
  if (loops > 0) bits.push(`${loops} review ${loops === 1 ? 'cycle' : 'cycles'}`);
  if (disputed) bits.push(`disputed (${String(p(disputed).reason ?? 'repeat')}): ${String(p(disputed).verdictLine ?? '')}`.trim());
  else if (exhausted) bits.push(`loop exhausted at ${String(p(exhausted).iterations ?? '')}/${String(p(exhausted).max ?? '')}`);
  if (failed?.reason) bits.push(`${failed.role} failed: ${failed.reason}`);
  bits.push(`${money(run.costUsd)} of ${money(run.maxCostUsd)}`);
  return bits.join(' · ');
}

export function runReportMarkdown(input: RunReportInput): string {
  const { run, tasks, events, artifacts } = input;
  const roleTasks = tasks.filter((t) => t.runtime !== 'publish').sort((a, b) => a.seq - b.seq);
  const publishTasks = tasks.filter((t) => t.runtime === 'publish').sort((a, b) => a.seq - b.seq);
  const L: string[] = [];
  const artifactFor = (taskId: string, name: string) => artifacts.find((a) => a.taskId === taskId && a.name === name)?.content ?? null;

  L.push(`# Run report — ${run.ticketKey}`, '');
  L.push(`**State:** ${run.state}${run.deliveryOutcome ? ` (${run.deliveryOutcome})` : ''}  `);
  L.push(`**Cost:** ${money(run.costUsd)} of ${money(run.maxCostUsd)} cap  `);
  L.push(`**Team:** ${run.teamName}  `);
  L.push(`**Dispatched by:** ${run.dispatchedBy ?? 'unknown'}  `);
  if (run.changeRequestUrl) L.push(`**Change request:** ${run.changeRequestUrl} (${run.changeRequestState ?? 'open'})  `);
  L.push('', `_${runReportSummary(input)}_`, '');

  // Timeline of role tasks.
  L.push('## Timeline', '');
  for (const t of roleTasks) {
    const origin = t.queuedBy && t.queuedBy !== 'plan' ? ` — via ${t.queuedBy}${t.queuedReason ? `: ${t.queuedReason}` : ''}` : '';
    L.push(`### ${t.seq}. ${String(t.role)}${t.attempt > 1 ? ` (attempt ${t.attempt})` : ''} — ${t.state}${origin}`);
    const result = p(ev(events, 'segment:result', t.id));
    const diff = p(ev(events, 'segment:diff', t.id));
    const started = p(ev(events, 'segment:started', t.id));
    const line: string[] = [];
    if (t.model) line.push(`model \`${t.model}\``);
    if (result.turns != null) line.push(`${result.turns} turns${started.maxTurns ? `/${started.maxTurns}` : ''}`);
    line.push(money(t.costUsd));
    if (result.terminalReason) line.push(`stopped: ${result.terminalReason}`);
    L.push(`- ${line.join(' · ')}`);
    if (typeof result.text === 'string' && result.text.trim()) {
      const said = result.text.trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
      L.push(`- said: ${said}`);
    }
    if (diff.filesChanged != null) L.push(`- changed: ${String(diff.filesChanged)} files (+${String(diff.insertions ?? 0)} −${String(diff.deletions ?? 0)})`);
    if (String(t.role) === 'reviewer') {
      const review = artifactFor(t.id, 'review.md');
      const verdict = review?.trim().split('\n')[0];
      if (verdict) L.push(`- verdict: **${verdict}**`);
    }
    L.push('');
  }

  // Review loop.
  const loops = events.filter((e) => e.kind === 'review:loop');
  const exhausted = ev(events, 'loop:exhausted');
  const disputed = ev(events, 'loop:disputed');
  if (loops.length || exhausted || disputed) {
    L.push('## Review loop', '');
    loops.forEach((e, i) => L.push(`- iteration ${String(p(e).iteration ?? i + 1)}: ${String(p(e).verdictLine ?? 'REQUEST_CHANGES')}`));
    if (exhausted) L.push(`- **exhausted** at ${String(p(exhausted).iterations)}/${String(p(exhausted).max)} — sent to a gate for a human decision`);
    if (disputed) L.push(`- **disputed** (${String(p(disputed).reason)}): ${String(p(disputed).verdictLine ?? '')} — parked for a human`);
    L.push('');
  }

  // Gates + human input.
  const gateEvents = events.filter((e) => e.kind === 'gate:resolved' || e.kind === 'needs_human:answered' || e.kind === 'needs_human:skipped');
  if (gateEvents.length) {
    L.push('## Human decisions', '');
    for (const e of gateEvents) {
      const pl = p(e);
      if (e.kind === 'gate:resolved') L.push(`- gate \`${String(pl.gate)}\`: **${String(pl.decision)}** by ${String(pl.by ?? 'operator')}${pl.note ? ` — ${String(pl.note)}` : ''}`);
      else if (e.kind === 'needs_human:answered') L.push(`- ${String(pl.role)} answered by ${String(pl.by ?? 'operator')}`);
      else L.push(`- ${String(pl.role)} skipped by ${String(pl.by ?? 'operator')}`);
    }
    L.push('');
  }

  // Publish.
  if (publishTasks.length) {
    L.push('## Delivery', '');
    for (const t of publishTasks) L.push(`- ${String(t.role)}: ${t.state}${t.reason ? ` — ${t.reason}` : ''}`);
    L.push('');
  }

  // Cost table: by role (summing attempts) and totals.
  L.push('## Cost', '', '| role | attempts | cost |', '|---|---|---|');
  const byRole = new Map<string, { attempts: number; cost: number }>();
  for (const t of tasks) {
    const k = String(t.role);
    const cur = byRole.get(k) ?? { attempts: 0, cost: 0 };
    cur.attempts += 1; cur.cost += t.costUsd;
    byRole.set(k, cur);
  }
  for (const [role, agg] of byRole) L.push(`| ${role} | ${agg.attempts} | ${money(agg.cost)} |`);
  const total = tasks.reduce((s, t) => s + t.costUsd, 0);
  const pct = run.maxCostUsd > 0 ? ` (${Math.round((total / run.maxCostUsd) * 100)}% of cap)` : '';
  L.push(`| **total** | | **${money(total)}**${pct} |`, '');

  return L.join('\n');
}
