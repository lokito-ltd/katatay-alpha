#!/usr/bin/env node
/**
 * The change report. On a verified tree the `record` moment builds it to
 * decide whether to declare or hold, and keeps the full report in a snapshot
 * the decision's event names. `workflow report` prints the compact summary
 * (`../workflow/change-summary.mjs`): the one recorded for this tree, or a
 * preview when no decision exists.
 *
 * Everything in it is measured by the harness: git against the change's
 * baseline, the logbook, the requirement catalogue and the language adapter. None
 * of it comes from the agent. The agent is asked afterwards for its reasons,
 * such as why a line cannot be covered, and those are labelled as its own, so
 * a reader never takes an explanation for a measurement.
 *
 * The two things it needs from the past are in the logbook: the triage, taken
 * while the failures still existed, with the baseline's list of tests the
 * `tests:` line counts against, and the plan's one mutation run. The rest is
 * worked out fresh each time, so it is always about the tree in front of the
 * operator.
 *
 * It opens with a summary of counts, one headline per section, and the
 * sections follow with the detail behind each number. Each section is built
 * by a function of plain data, so a test can reach it without git.
 *
 * Options: `--json` prints `{ lines, summary, gaps, incomplete, problems }`
 * for the `record` moment, which decides from `gaps` whether to declare at
 * once, and keeps `summary`, the headline lines, with the declaration. The
 * change file opens with those lines, and the record step checks they match.
 * `problems` gives each unreadable section with its reason.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalogue, type Requirement } from '../requirements/parse.js';
import { loadCatalogueAt } from '../requirements/guard.js';
import { current } from '../workflow/state.mjs';
import { TargetError } from '../workflow/target.mjs';
import { allChecks, followUpsFile, readChecks, readMutation, MUTATION_SWITCHED_OFF } from '../workflow/rulebook.mjs';
import { gitLines, gitText } from '../workflow/git.mjs';
import { reviewSuppressions, branchChanges, implementationChanges, isCode, isFrozen, isTest } from '../workflow/frozen.mjs';
import { renderAreas, reviewAreas } from '../workflow/areas.mjs';
import { configuredCoverage, COVERAGE_SWITCHED_OFF, lineRanges } from '../workflow/coverage.mjs';
import { readMutationSnapshot } from '../workflow/mutation-snapshot.mjs';
import { touchedFiles } from '../workflow/touched.mjs';
import { agentWarnings } from '../workflow/agent.mjs';
import { readBaseline, receiptFor, triageBlock, triageIn } from '../workflow/phase.mjs';
import { command } from '../workflow/commands.mjs';
import { survivorReport } from './mutation-display.mjs';
import { unprovedCount } from './mutation-report.mjs';
import { matchesAcceptance } from '../workflow/adapter.mjs';
import { taggedTests, type TaggedTest } from './tags.js';
import { sentence, TEST_QUALITY_RESULTS } from '../workflow/result-format.mjs';
import { coverageMeasurement, junitReports, measuredTree, mutationReferences, producerEvent, requireUsable, resultNamed, testMeasurement, usable } from '../workflow/result-readers.mjs';
import { readSavedCheck } from '../workflow/verification-results.mjs';
import { parseReports, type TestRun } from './test-run.js';
import { triageEvidence } from '../workflow/triage-snapshot.mjs';
import { changedLinesOf, countTests, type TestCount } from './test-list.js';
import type { MutationOutcome } from './mutants.js';
import { changeReportEvidence, changeSummary, outcomeTitle, recordedDecision } from '../workflow/change-summary.mjs';
import { fileFor } from '../workflow/chain.mjs';

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

export interface Size {
  code: { added: number; deleted: number };
  tests: { added: number; modified: number; removed: number };
}

/**
 * How big the change is, in counts only.
 *
 * `status` is `git diff --name-status --no-renames` against the baseline, and
 * `numstat` the same with `--numstat`: without renames, a moved file reads as
 * one removed and one added, which is what it is to a reviewer counting files.
 * `untracked` maps each file git has not been told about to its line count,
 * because `git diff` never mentions those, and a brand-new module is all
 * added lines.
 *
 * Code is implementation code: what the adapter calls code and the freeze does
 * not hold. Tests are the adapter's test files. Everything else, docs and
 * config, is left out of both counts.
 */
export function sizeOf(status: string[], numstat: string[], untracked: Record<string, number>): Size {
  const size: Size = { code: { added: 0, deleted: 0 }, tests: { added: 0, modified: 0, removed: 0 } };
  const isImplementation = (file: string) => isCode(file) && !isFrozen(file);
  for (const line of status) {
    const [mark, file] = line.split('\t');
    if (file === undefined || !isTest(file)) continue;
    if (mark === 'A') size.tests.added += 1;
    else if (mark === 'D') size.tests.removed += 1;
    else size.tests.modified += 1;
  }
  for (const line of numstat) {
    const [added, deleted, file] = line.split('\t');
    // A binary file reads `-` for both counts. It has no lines to count.
    if (file === undefined || !isImplementation(file) || added === '-') continue;
    size.code.added += Number(added);
    size.code.deleted += Number(deleted);
  }
  for (const [file, lines] of Object.entries(untracked)) {
    if (isTest(file)) size.tests.added += 1;
    else if (isImplementation(file)) size.code.added += lines;
  }
  return size;
}

// ---------------------------------------------------------------------------
// Surprises
// ---------------------------------------------------------------------------

interface Bucket { failed: number; total: number; failures?: string[] }

export interface Surprises {
  level: string;
  predicted: Omit<Bucket, 'failures'>;
  surprise: Bucket;
  overPredicted: { count: number; total: number; tests?: string[] };
  /** Test files the triage run left out. */
  notRun: { predicted: string[] | number; unpredicted: string[] | number };
}

/** The classified failures, when the plan has been triaged. */
export function surprisesOf(triage: { payload: Record<string, any> } | null): Surprises | null {
  if (!triage) return null;
  const { level, predicted, surprise, overPredicted, notRun } = triage.payload;
  return { level, predicted, surprise, overPredicted, notRun };
}

function renderSurprises(s: Surprises | null): string[] {
  if (s === null) return ['  No triage was recorded for this plan.'];
  return triageBlock(s).map((line) => (line === '' ? '' : `  ${line}`));
}

/**
 * How well the plan predicted, in words: `exact`, the misses, or `not
 * triaged`. The level is a separate word on the same line, because a failing
 * invariant can make an exact prediction HIGH.
 */
export function predictionOf(s: Surprises | null | undefined): string {
  if (s === undefined) return '?';
  if (s === null) return 'not triaged';
  const misses = [
    ...(s.surprise.failed > 0 ? [plural(s.surprise.failed, 'surprise')] : []),
    ...(s.overPredicted.count > 0 ? [plural(s.overPredicted.count, 'over-prediction')] : []),
  ];
  return misses.length === 0 ? 'exact' : misses.join(', ');
}

// ---------------------------------------------------------------------------
// Requirements: what changed, and gaps in their testing
// ---------------------------------------------------------------------------

export type Evidence = 'solid' | 'untested';

export interface RequirementChange {
  id: string;
  /** What happened to it, in words: `added`, `reworded`, `active → withdrawn`, `scenarios changed`. */
  kinds: string[];
}

export interface RequirementsReport {
  changed: RequirementChange[];
  scenarios: { added: number; reworded: number; retired: number };
  /** Each scenario of a changed, still-standing requirement, with how it is tested. */
  evidence: { id: string; evidence: Evidence }[];
}

const RETIRED = new Set(['superseded', 'withdrawn']);

/** Only acceptance tests that can run and fail count as evidence. */
export function evidenceOf(tests: TaggedTest[]): Evidence {
  return tests.some((test) => test.notEvidence === null && matchesAcceptance(test.file)) ? 'solid' : 'untested';
}

/**
 * The requirements this change touched, compared with the catalogue at the
 * baseline, and the evidence for each scenario of those still standing.
 *
 * Scenarios are counted as added, reworded (same id, different text) or
 * retired: removed from their requirement, or belonging to one this change
 * superseded or withdrew. A requirement with no scenarios counts as one,
 * under its own id, because it is tested by tests tagged with that id.
 */
export function requirementsReport(before: Requirement[], after: Requirement[], tests: TaggedTest[]): RequirementsReport {
  const was = new Map(before.map((r) => [r.id, r]));
  const report: RequirementsReport = { changed: [], scenarios: { added: 0, reworded: 0, retired: 0 }, evidence: [] };
  const units = (r: Requirement) => (r.scenarios.length > 0 ? r.scenarios : [{ id: r.id, checksum: r.checksum, text: r.statement }]);

  for (const now of [...after].sort((a, b) => a.id.localeCompare(b.id))) {
    const old = was.get(now.id);
    const kinds: string[] = [];
    if (old === undefined) {
      kinds.push('added');
      if (!RETIRED.has(now.status)) report.scenarios.added += units(now).length;
    } else {
      if (old.statement !== now.statement) kinds.push('reworded');
      if (old.status !== now.status) kinds.push(`${old.status} → ${now.status}`);
      const oldUnits = new Map(units(old).map((s) => [s.id, s.checksum]));
      const newUnits = new Map(units(now).map((s) => [s.id, s.checksum]));
      let scenariosChanged = false;
      if (RETIRED.has(now.status) && !RETIRED.has(old.status)) {
        report.scenarios.retired += oldUnits.size;
      } else if (!RETIRED.has(now.status)) {
        for (const [id, sum] of newUnits) {
          if (!oldUnits.has(id)) { report.scenarios.added += 1; scenariosChanged = true; }
          else if (oldUnits.get(id) !== sum && id !== now.id) { report.scenarios.reworded += 1; scenariosChanged = true; }
        }
        for (const id of oldUnits.keys()) {
          if (!newUnits.has(id)) { report.scenarios.retired += 1; scenariosChanged = true; }
        }
      }
      // A statement reworded on a requirement with no scenarios is the one
      // unit it has, so it counts as a reworded scenario as well.
      if (now.scenarios.length === 0 && old.statement !== now.statement && !RETIRED.has(now.status)) report.scenarios.reworded += 1;
      if (scenariosChanged) kinds.push('scenarios changed');
    }
    if (kinds.length === 0) continue;
    report.changed.push({ id: now.id, kinds });
    if (RETIRED.has(now.status)) continue;
    for (const unit of units(now)) {
      const carriers = tests.filter((test) => test.scenarios.includes(unit.id) || test.bare.includes(unit.id));
      report.evidence.push({ id: unit.id, evidence: evidenceOf(carriers) });
    }
  }
  return report;
}

const thinOnes = (r: RequirementsReport) => r.evidence.filter((e) => e.evidence !== 'solid');

function renderRequirements(r: RequirementsReport): string[] {
  if (r.changed.length === 0) return ['  This change adds or alters no requirement.'];
  const lines = r.changed.map((c) => `  - ${c.id}: ${c.kinds.join(', ')}`);
  const thin = thinOnes(r);
  const solid = r.evidence.length - thin.length;
  lines.push(`  Of their ${plural(r.evidence.length, 'scenario')}, ${solid} ${solid === 1 ? 'has' : 'have'} acceptance evidence.`);
  for (const e of thin) lines.push(`  - ${e.id}: no acceptance evidence`);
  return lines;
}

// ---------------------------------------------------------------------------
// Coverage of the change
// ---------------------------------------------------------------------------

export interface ChangeCoverage {
  /** Touched lines a test ran, or `null` when the adapter does not say which
   *  lines ran, and only the uncovered ones are known. */
  covered: number | null;
  uncovered: { file: string; lines: number[] }[];
}

interface CoverageAnswer { files: { file: string; uncoveredLines: number[]; coveredLines?: number[] }[] }

/**
 * The touched code lines that can run, split into those some test ran and
 * those none did. `targets` are the touched ranges from `touched.mjs`: a
 * range, or a whole file git has not been told about.
 *
 * The share needs the lines that ran as well as those that did not, because a
 * touched range also holds blank lines and comments, which are neither. An
 * adapter that leaves out `coveredLines` still gives the uncovered ones, and
 * the share is then unknown rather than guessed.
 */
export function changeCoverage(answer: CoverageAnswer, targets: { file: string; lines?: [number, number] }[]): ChangeCoverage {
  const byFile = new Map(answer.files.map((f) => [f.file, f]));
  const inside = (n: number, lines?: [number, number]) => lines === undefined || (n >= lines[0] && n <= lines[1]);
  const uncovered = new Map<string, Set<number>>();
  const covered = new Map<string, Set<number>>();
  let known = true;
  for (const { file, lines } of targets) {
    const entry = byFile.get(file);
    if (entry === undefined) continue;
    const missed = entry.uncoveredLines.filter((n) => inside(n, lines));
    if (missed.length > 0) uncovered.set(file, new Set([...(uncovered.get(file) ?? []), ...missed]));
    if (entry.coveredLines === undefined) { known = false; continue; }
    const ran = entry.coveredLines.filter((n) => inside(n, lines));
    if (ran.length > 0) covered.set(file, new Set([...(covered.get(file) ?? []), ...ran]));
  }
  return {
    covered: known ? [...covered.values()].reduce((sum, set) => sum + set.size, 0) : null,
    uncovered: [...uncovered.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([file, set]) => ({ file, lines: [...set].sort((a, b) => a - b) })),
  };
}

const uncoveredCount = (c: ChangeCoverage) => c.uncovered.reduce((sum, { lines }) => sum + lines.length, 0);

/** `55% (38 of 69 lines)`, rounded down so 99.6% never reads as all. */
export function coverageShare(c: ChangeCoverage): string {
  const missed = uncoveredCount(c);
  if (c.covered === null) return `${plural(missed, 'line')} uncovered`;
  const total = c.covered + missed;
  if (total === 0) return 'no lines that run';
  return `${Math.floor((c.covered * 100) / total)}% (${c.covered} of ${plural(total, 'line')})`;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

export interface MutationRun {
  findings: import('./mutation-report.mjs').Findings;
  report: string;
  outcome: Extract<MutationOutcome, 'clean' | 'survived' | 'nothing'>;
  earlier: boolean;
}

/** The plan's one mutation run, if a verified pass recorded one. */
export function mutationRunOf(run: (Pick<MutationRun, 'report' | 'outcome' | 'findings'> & { treeFingerprint: string }) | null,
  treeFingerprint: string, root = process.cwd()): MutationRun | null {
  if (!run) return null;
  return { report: survivorReport(run.report.trim(), run.findings.survivors, root), outcome: run.outcome, findings: run.findings, earlier: run.treeFingerprint !== treeFingerprint };
}

export function mutationHeadline(m: MutationRun): string {
  const { caught, survived } = m.findings.counts;
  const unproved = unprovedCount(m.findings.counts);
  const qualification = m.outcome === 'clean' ? " (by the tool's account)" : m.outcome === 'nothing' ? ' (inconclusive run)' : '';
  return `mutants: ${caught} caught, ${survived} survived${unproved > 0 ? `, ${unproved} unproved` : ''}${qualification}${m.earlier ? ' (earlier tree)' : ''}`;
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

/** The bold lead of each top-level item in the follow-ups file, `FOLLOW-UPS.md` here: `- **Lead.** …`. */
export const leadsOf = (text: string): string[] =>
  // The lead may wrap onto the next line, as the file wraps at 80 columns, so
  // it is read across line breaks and its whitespace joined into one space.
  [...text.matchAll(/^- \*\*([\s\S]+?)\*\*/gm)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());

/** Items added and removed, by their lead. A reworded lead reads as one of each. */
export function followUpsOf(before: string, after: string): { added: string[]; removed: string[] } {
  const was = new Set(leadsOf(before));
  const now = new Set(leadsOf(after));
  return { added: [...now].filter((l) => !was.has(l)), removed: [...was].filter((l) => !now.has(l)) };
}

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

/** Everything the report says, gathered. A section that could not be read is
 *  `undefined`, and its name is in `incomplete` with the reason. */
export interface ReportData {
  size?: Size;
  /** Tests counted one by one against the triage's list. Absent when the
   *  plan has no triage, and the summary then counts test files. */
  tests?: TestCount;
  areas?: { must: { text: string; items: string[] }[] };
  surprises?: Surprises | null;
  requirements?: RequirementsReport;
  /** `null` when coverage is switched off. */
  coverage?: ChangeCoverage | null;
  /** `null` when the plan has no mutation run. */
  mutation?: MutationRun | null;
  followUps?: { added: string[]; removed: string[] };
  /** Implementation files a test-only plan touched; empty for any other plan. */
  drift?: string[];
  notChecked: string[];
  warnings?: string[];
  incomplete: { section: string; reason: string }[];
  /** True when the receipt came from `workflow verify --rerun` and not from
   *  the turn-end hook. The rerun ran in someone's shell, whose environment
   *  can shape a pass, so the operator is told. */
  rerun?: boolean;
}

/** The headline counts, one line per group. The last line appears only when
 *  one of its items does. */
export function summaryLines(d: ReportData): string[] {
  const unknown = '?';
  const lines: string[] = [];

  // Two signals, said apart: how well the plan predicted, and which files are
  // protected. The level follows, because it adds test regressions to the
  // prediction. `risk HIGH · 5 high-risk files` read as one verdict.
  const first: string[] = [`prediction: ${predictionOf(d.surprises)}`];
  if (d.areas !== undefined) first.push(`protected files: ${new Set(d.areas.must.flatMap((a) => a.items)).size}`);
  if (d.surprises !== null) first.push(`risk: ${d.surprises?.level ?? unknown}`);
  lines.push(first.join(' · '));

  if (d.requirements !== undefined) {
    const { added, reworded, retired } = d.requirements.scenarios;
    const thin = thinOnes(d.requirements);
    lines.push(`AC scenarios: ${added} added, ${reworded} reworded, ${retired} retired${thin.length ? ` (${thin.length} without acceptance evidence)` : ''}`);
  }

  if (d.tests !== undefined) {
    const t = d.tests;
    lines.push(`tests: ${t.added} added, ${t.modified} modified, ${t.removed} removed`);
  } else if (d.size !== undefined) {
    // Before triage, only the file counts are available.
    const t = d.size.tests;
    lines.push(`test files: ${t.added} added, ${t.modified} modified, ${t.removed} removed`);
  }

  const quality: string[] = [];
  if (d.coverage) quality.push(`change coverage ${coverageShare(d.coverage)}`);
  if (d.mutation) quality.push(mutationHeadline(d.mutation));
  if (quality.length > 0) lines.push(quality.join(' · '));

  const last: string[] = [];
  if (d.followUps) last.push(`follow-ups +${d.followUps.added.length} −${d.followUps.removed.length}`);
  if (d.size) last.push(`code +${d.size.code.added} −${d.size.code.deleted} lines`);
  if (last.length > 0) lines.push(last.join(' · '));

  const extra: string[] = [];
  if (d.rerun) extra.push('verified by a rerun');
  // Named from the sections, not parsed from the reasons: a reason such as
  // `not checked: coverage (...)` or `skipped in CI (...)` does not start with
  // the check's name. `null` is what marks a section as not checked.
  const unchecked = [d.coverage === null && 'coverage', d.mutation === null && 'mutation'].filter((name) => name !== false);
  if (unchecked.length > 0) extra.push(`not checked: ${unchecked.join(', ')}`);
  if (d.warnings && d.warnings.length > 0) extra.push(plural(d.warnings.length, 'setup warning'));
  if (d.drift && d.drift.length > 0) extra.push(`test-only plan touched ${plural(d.drift.length, 'code file')}`);
  if (d.incomplete.length > 0) extra.push(`${plural(d.incomplete.length, 'section')} could not be read`);
  if (extra.length > 0) lines.push(extra.join(' · '));
  return lines;
}

/** The report as the operator reads it. */
export function renderReport(d: ReportData): string[] {
  const out: string[] = ['Change report', '', ...summaryLines(d).map((l) => `  ${l}`)];
  const section = (title: string, body: string[]) => { out.push('', title, ...body); };

  if (d.areas !== undefined) {
    const lines = renderAreas({ must: d.areas.must });
    section('High-risk areas changed', lines.length > 0 ? lines.slice(1) : ['  None.']);
  }
  if (d.surprises !== undefined) section('Surprises at triage', renderSurprises(d.surprises));
  if (d.requirements !== undefined) section('Requirements: what changed, and gaps in their testing', renderRequirements(d.requirements));

  const quality: string[] = [];
  if (d.coverage === null) quality.push('  Coverage: not checked.');
  else if (d.coverage !== undefined) {
    quality.push(`  Coverage of the lines this change touched: ${coverageShare(d.coverage)}.`);
    quality.push('  The folder minimums hold: verify fails below them.');
    for (const { file, lines } of d.coverage.uncovered) quality.push(`  - ${file}: ${plural(lines.length, 'line')} no test runs (${lineRanges(lines)})`);
  }
  if (d.mutation === null) quality.push('  Mutation testing: no run for this plan.');
  else if (d.mutation !== undefined) {
    quality.push(d.mutation.earlier
      ? `  Mutation testing ran once, on an earlier tree. Tests may have changed since, and nothing rechecked them; \`${command('mutate')}\` runs it again.`
      : '  Mutation testing ran once, on this tree.');
    for (const line of d.mutation.report.split('\n')) quality.push(`  ${line}`);
    const counts = d.mutation.findings.counts;
    if (unprovedCount(counts) > 0) {
      quality.push(`  Unproved mutants: ${counts.statuses.NoCoverage} reached by no test, ${counts.statuses.Pending} pending, ${counts.unproven} with no completed tests.`);
    }
  }
  if (quality.length > 0) section('Test quality of this change', quality);

  if (d.followUps !== undefined && (d.followUps.added.length > 0 || d.followUps.removed.length > 0)) {
    section('Follow-ups', [
      ...d.followUps.added.map((l) => `  + ${l}`),
      ...d.followUps.removed.map((l) => `  − ${l}`),
    ]);
  }
  if (d.drift && d.drift.length > 0) {
    section('Test-only plan, and these are not tests', d.drift.map((f) => `  - ${f}`));
  }
  if (d.notChecked.length > 0) section('Not checked', d.notChecked.map((n) => `  - ${n}`));
  if (d.warnings && d.warnings.length > 0) section('Setup warnings', d.warnings.map((w) => `  - ${w}`));
  if (d.incomplete.length > 0) section('Could not be read', d.incomplete.map(({ section: s, reason }) => `  - ${s}: ${reason}`));
  return out;
}

/** Omit unmeasured checks; zero is a measurement. */
export const gapsOf = (d: ReportData): import('../workflow/change-summary.mjs').Gaps => ({
  ...(d.coverage && { uncoveredLines: uncoveredCount(d.coverage) }),
  ...(d.mutation && { uncaughtMutants: d.mutation.findings.counts.survived + unprovedCount(d.mutation.findings.counts) }),
});

// ---------------------------------------------------------------------------
// Gathering, from git, the logbook and the adapter
// ---------------------------------------------------------------------------

const lineCount = (path: string): number => {
  const text = readFileSync(path, 'utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
};

/**
 * Gathers the report for the working tree under `root`, the current directory.
 *
 * Each section is read on its own, and one that fails is named in
 * `incomplete` with its reason rather than failing the rest: a report with a
 * hole that says so is still worth reading. The `record` moment requires every section.
 */
export function buildReport(root = process.cwd()): ReportData {
  const state = current();
  const base: string | null = state.baseline;
  const d: ReportData = { notChecked: [], incomplete: [] };
  const read = (section: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      d.incomplete.push({ section, reason: String((error as Error).message ?? error).trim().split('\n')[0] ?? '' });
    }
  };
  const from = base ?? state.target.ref;
  const changes = branchChanges(base);

  read('size', () => {
    const status = gitLines(['diff', '--name-status', '--no-renames', from], { cwd: root });
    const numstat = gitLines(['diff', '--numstat', '--no-renames', from], { cwd: root });
    const untracked = Object.fromEntries(gitLines(['ls-files', '--others', '--exclude-standard'], { cwd: root })
      .filter((f) => existsSync(join(root, f)))
      .map((f) => [f, lineCount(join(root, f))]));
    d.size = sizeOf(status, numstat, untracked);
  });

  read('high-risk areas', () => {
    const { ignores, suppressed } = reviewSuppressions({ base, added: changes.added, checks: allChecks(readChecks(root)) });
    d.areas = { must: reviewAreas({ ...changes, ignores, suppressed, root }).must };
  });

  const triage = triageIn(state.live);
  const evidence = triage && triageEvidence(state.branch, triage, root);
  d.surprises = surprisesOf(evidence);
  if (evidence?.problem) d.incomplete.push({ section: 'triage snapshot', reason: evidence.problem });

  const receipt = receiptFor(state.live, state);
  if (receipt?.payload.trigger === 'rerun') d.rerun = true;
  const reading = receipt && { live: state.live, branch: state.branch, root, before: receipt.seq,
    baseline: readBaseline(receipt.payload.baseline), rulebookFingerprint: receipt.payload.rulebookFingerprint };
  const restore = (prefix: string, error: unknown) =>
    new Error(`${prefix}${sentence((error as Error).message)} Restore the exact evidence or obtain a fresh workflow verification.`);
  let verifiedRun: TestRun | undefined;
  read('verified JUnit', () => {
    if (!receipt) throw new Error('No verification for the current tree and approval. Run workflow verification.');
    try {
      const tests = resultNamed(receipt.payload.results, 'tests');
      const reports = junitReports(tests, state.branch, root);
      const run = parseReports(reports, root);
      if (run.leftOut.length) throw new Error('Verified JUnit reports omit test files: ' + run.leftOut.map(f => f.file).join(', '));
      const producer = producerEvent(tests, reading);
      testMeasurement(tests, state.branch, root, producer ? resultNamed(producer.payload.results, 'tests').status : tests.status);
      verifiedRun = run;
    } catch (error) {
      throw restore(`Verification ${receipt.seq}: `, error);
    }
  });

  read('tests', () => {
    if (evidence?.problem) return; // Both sections require the same validated snapshot.
    if (!evidence) throw new Error('No triage under the current approval. Run triage to measure the baseline tests.');
    if (!verifiedRun) return;
    const list = evidence.identities;
    const diff = gitText(['diff', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', from], { cwd: root });
    const atBaseline = new Set(gitLines(['ls-tree', '-r', '--name-only', from], { cwd: root }));
    d.tests = countTests(
      list,
      verifiedRun,
      changedLinesOf(diff, isTest),
      (file) => atBaseline.has(file),
    );
  });

  read('requirements', () => {
    if (verifiedRun) d.requirements = requirementsReport(loadCatalogueAt(from), loadCatalogue(), taggedTests(verifiedRun));
  });

  // What the current verification measured, from the snapshots its event
  // names. The working output file is never read: it may have changed since.
  read('coverage', () => {
    if (configuredCoverage(root) === undefined) {
      d.coverage = null;
      d.notChecked.push(COVERAGE_SWITCHED_OFF);
      return;
    }
    if (!receipt) throw new Error('coverage: no verification for the current tree and approval. Run workflow verification.');
    let analysis;
    try {
      const result = requireUsable(resultNamed(receipt.payload.results, 'coverage'), 'coverage');
      analysis = coverageMeasurement(result, reading);
    } catch (error) {
      throw restore(`coverage: verification ${receipt.seq}: `, error);
    }
    if (analysis.touched === null) throw new Error('coverage: no baseline was available for touched-line analysis');
    d.coverage = analysis.touched;
  });

  read('mutation', () => {
    if (!readMutation(root)) {
      d.mutation = null;
      d.notChecked.push(MUTATION_SWITCHED_OFF);
      return;
    }
    if (!receipt) throw new Error('mutation: no verification for the current tree and approval. Run workflow verification.');
    const result = resultNamed(receipt.payload.results, 'mutation');
    if (result?.status === 'skipped') {
      d.mutation = null;
      d.notChecked.push(result.reason);
      return;
    }
    try {
      const usable = requireUsable(result, 'mutation');
      const run = readMutationSnapshot(state.branch, mutationReferences(usable), root);
      d.mutation = mutationRunOf({ ...run, treeFingerprint: measuredTree(usable, receipt.payload.treeFingerprint, reading) }, state.treeFingerprint, root);
    } catch (error) {
      throw restore(`mutation: verification ${receipt.seq}: `, error);
    }
  });

  for (const result of receipt?.payload.results ?? []) {
    if (TEST_QUALITY_RESULTS.includes(result.name) || !usable(result)) continue;
    read(result.name, () => readSavedCheck(result, state.branch, root));
  }

  read('follow-ups', () => {
    const file = followUpsFile(root);
    let before = '';
    try {
      before = gitText(['show', `${from}:${file}`], { cwd: root });
    } catch {
      // Not there at the baseline: every item is new.
    }
    const after = existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '';
    d.followUps = followUpsOf(before, after);
  });

  read('test-only drift', () => {
    d.drift = state.grant?.payload.testOnly ? implementationChanges(changes.changed) : [];
  });

  read('setup warnings', () => { d.warnings = agentWarnings(root); });
  return d;
}

/** Each section that could not be read, with its reason, one line each. */
export const problemsOf = (d: ReportData): string[] => d.incomplete.map(({ section, reason }) => `${section}: ${reason}`);

/**
 * What `workflow report` prints: the summary recorded with this tree's
 * `record` decision, linked to its event, or else a preview built from `d`
 * that no event stands behind. It writes nothing.
 */
export function standaloneSummary(d: ReportData, root = process.cwd()): string {
  const state = current();
  const event = recordedDecision(state.live, state);
  if (event) {
    try {
      const recorded = changeReportEvidence(state.branch, event, root);
      return changeSummary({ title: outcomeTitle({ decision: 'recorded', event: event.event }), summary: recorded.summary,
        link: join(state.dir, fileFor(event)) });
    } catch (error) {
      // A snapshot that cannot be read is said, and the preview follows.
      d.incomplete.push({ section: 'recorded change report', reason: (error as Error).message });
    }
  }
  return changeSummary({ title: outcomeTitle({ decision: 'preview' }), summary: summaryLines(d), problems: problemsOf(d), link: null });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const d = buildReport();
    const text = process.argv.includes('--json')
      ? JSON.stringify({ lines: renderReport(d), summary: summaryLines(d), gaps: gapsOf(d),
        incomplete: d.incomplete.map((i) => i.section), problems: problemsOf(d) })
      : standaloneSummary(d);
    // The exit waits for the answer to be written, as in `workflow mutate`: the
    // `record` moment reads it through a pipe.
    process.stdout.write(`${text}\n`, () => process.exit(0));
  } catch (error) {
    if (!(error instanceof TargetError)) throw error;
    console.error(`report: refused — ${error.message}`);
    process.exit(1);
  }
}
