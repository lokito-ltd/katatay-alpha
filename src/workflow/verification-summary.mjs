/**
 * The verification as the operator sees it: the outcome, then each check
 * under what it needs from them, then one link to the `verified` or
 * `verify_failed` event that holds the rest.
 *
 * The sections come in this order, and one with nothing in it is left out:
 * failures, findings, reused results, warnings, where review should look,
 * skipped checks, and passed checks. A failed or reporting check gives its
 * counts and its first NAMED items. A passed check is one line and nothing
 * else: the operator reads the list for what is not on it.
 *
 * Everything here is read from the event and the snapshots its unified
 * results name, never from what verify printed. The turn end repeats a
 * failure it did not run again from the event alone, and a summary read from
 * the event always matches what its link opens. The one exception is a
 * referee step that kept no output of its own, such as `state:verify`: its
 * items are the last lines of the event's `tail`, where verify stopped.
 *
 * Unlike the other compact reports this one has no ceiling in lines. A
 * project can configure any number of checks, and each is owed its line.
 */
import { join } from 'node:path';
import { fileFor } from './chain.mjs';
import { compactReport, NAMED, row, trimmed, wrap } from './compact-report.mjs';
import { lineRanges } from './coverage.mjs';
import { readTestAnalysis } from './junit-snapshot.mjs';
import { readMutationSnapshot } from './mutation-snapshot.mjs';
import { checkText, coverageMeasurement, mutationReferences, producerEvent, usable } from './result-readers.mjs';
import { readSavedCheck, resultIn } from './verification-results.mjs';
import { TEST_QUALITY_RESULTS } from './result-format.mjs';
import { allChecks, readChecks } from './rulebook.mjs';
import { command } from './commands.mjs';
import { readBaseline } from './phase.mjs';

export const PASSED = 'Verification passed.';
export const FAILED = 'Verification failed.';

/** The line verify ends a failure with. The summary names the check itself. */
const STOPPED = /^verify: failed at /;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lines = (text) => String(text ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');

/** A replacement on one line, cut so the row stays readable. */
function replacement(text, at) {
  const flat = row(text);
  const room = Math.max(20, 76 - at.length - 3);
  return [...flat].length > room ? `${[...flat].slice(0, room - 1).join('')}…` : flat;
}

/**
 * How to run a reused check again on its own: `workflow mutate` for mutation,
 * the rulebook's command for a configured check.
 */
export function rerunCommand(name, root = process.cwd()) {
  if (name === 'mutation') return command('mutate');
  try {
    const check = allChecks(readChecks(root)).find((item) => item.name === name);
    if (check?.command) return check.command;
  } catch {
    // An unreadable rulebook is reported by verify itself.
  }
  return `${command('verify')} --rerun`;
}

/** Items that cannot be read keep the counts and say why. */
const unreadable = (what, error) => [`The ${what} cannot be listed: ${error.message}`];

function testsDetail(result, context) {
  const s = result.summary;
  if (s.total === undefined) return { counts: result.reason, items: trimmed(lines(s.diagnostics), 'lines') };
  const counts = `${s.failed} / ${s.total} failed`
    + (s.omittedFiles ? `, ${plural(s.omittedFiles, 'file')} left out of the report` : '');
  if (s.failed === 0 && s.omittedFiles === 0) return { counts, items: [] };
  let run;
  try {
    run = readTestAnalysis(context.branch, result.evidence, context.root);
  } catch (error) {
    return { counts, items: unreadable('tests', error) };
  }
  // A file left out of the report can hide more than any one test, so it
  // comes first, where the trim cannot push it out.
  const rows = [
    ...run.leftOut.map((file) => `${file.file} — left out of the report`),
    ...run.cases.filter((test) => test.status === 'failed').map((test) => `${test.file} — ${test.name}`),
  ];
  return { counts, items: trimmed(rows, 'failures') };
}

function coverageDetail(result, context) {
  const s = result.summary;
  if (result.status === 'failed') {
    const below = (s.folders ?? []).flatMap((folder) => ['lines', 'branches']
      .filter((metric) => folder[metric].percent < folder[metric].target)
      .map((metric) => `${folder.folder} ${metric} ${folder[metric].percent}%, minimum ${folder[metric].target}%`));
    if (below.length) return { counts: `${plural(below.length, 'minimum')} not met`, items: trimmed(below, 'minimums') };
    return { counts: result.reason, items: trimmed(lines(s.diagnostics), 'lines') };
  }
  const touched = context.touched;
  if (!touched) return { counts: result.reason, items: [] };
  const missing = touched.uncovered.reduce((n, file) => n + file.lines.length, 0);
  return {
    counts: `${missing} / ${touched.total} touched lines run by no test`,
    items: trimmed(touched.uncovered.map((file) => `${file.file}: ${lineRanges(file.lines)}`), 'files'),
  };
}

/**
 * What the mutation tool said in its own words: the lines after the
 * referee's reading in a run's report, which `src/evidence/mutants.ts`
 * separates with a blank line.
 */
function toolSaid(report) {
  const all = String(report ?? '').split('\n');
  const blank = all.findIndex((line) => line.trim() === '');
  return blank < 0 ? [] : lines(all.slice(blank + 1).join('\n')).map((line) => line.trim());
}

function mutationDetail(result, context) {
  const s = result.summary;
  if (s.totalMutants === undefined) return { counts: result.reason, items: trimmed(lines(s.diagnostics), 'lines') };
  const counts = [`${s.survived} survived`, `${s.killed} killed`, `${s.totalMutants} mutants`,
    ...(s.unproved ? [`${s.unproved} unproved`] : []), ...(s.errored ? [`${s.errored} errored`] : [])].join(' · ');
  const partial = result.status === 'partial';
  if (!s.survived && !partial) return { counts, items: [] };
  let run;
  try {
    run = readMutationSnapshot(context.branch, mutationReferences(result), context.root);
  } catch (error) {
    return { counts, items: unreadable('survivors', error) };
  }
  const rows = run.findings.survivors.map((survivor) => {
    const at = `${survivor.file}:${survivor.location.start.line} ${survivor.mutator}`;
    return survivor.replacement === undefined ? at : `${at} → ${replacement(survivor.replacement, at)}`;
  });
  const survivors = trimmed(rows, 'survivors');
  // A partial run says why after its counts. The result's own reason only
  // repeats the counts. Unproved and errored mutants are in the counts line.
  if (partial && run.outcome === 'nothing') {
    return { counts: `${counts}\nThe run proves nothing this time. The tool said:`, items: [...trimmed(toolSaid(run.report), 'lines'), ...survivors] };
  }
  if (partial && run.findings.partial) return { counts: `${counts}\nThe run stopped before it tested every mutant.`, items: survivors };
  return { counts, items: survivors };
}

/**
 * Any other check: what it printed, its diagnostics, or, for a referee step
 * that kept neither, the end of the failed verify's tail.
 */
function generalDetail(result, context) {
  const s = result.summary;
  const reason = context.reasonOf(result);
  let output = [];
  if (result.evidence.some((item) => item.role === 'raw')) {
    try {
      output = lines(checkText(result, context.branch, context.root));
    } catch (error) {
      return { counts: reason, items: unreadable('output', error) };
    }
  }
  if (!output.length) output = lines(s.diagnostics);
  if (output.length || result.status !== 'failed') return { counts: reason, items: trimmed(output, 'lines') };
  // Verify stops at the first failure, so the end of its tail is closest to it.
  const tail = lines(context.tail).filter((line) => !STOPPED.test(line));
  const items = tail.length > NAMED
    ? [...tail.slice(-NAMED), `[…] Output trimmed. The last ${tail.length} lines of verify's output are in the details file.`]
    : tail;
  return { counts: result.reason, items };
}

const DETAIL = { tests: testsDetail, coverage: coverageDetail, mutation: mutationDetail };
const detailOf = (result, context) => (DETAIL[result.name] ?? generalDetail)(result, context);

/**
 * The reason a result gives: for a reused one, what its producer said, such
 * as `findings (exit 1)`. The reused result's own reason only says it was
 * reused, which the summary already says. A producer that cannot be read
 * leaves the reuse reason.
 */
function producerReason(result, { live, ...where }) {
  if (result.status !== 'reused' || !live) return result.reason;
  try {
    return resultIn(producerEvent(result, { live, ...where }), result.name)?.reason ?? result.reason;
  } catch {
    return result.reason;
  }
}

/** Whether a check that ran found something the operator should see. */
function hasFindings(result, context) {
  if (result.name === 'mutation') return result.summary.survived > 0;
  if (result.name === 'coverage') return (context.touched?.uncovered.length ?? 0) > 0;
  if (result.name === 'tests') return false;
  return result.summary.outcome === 'findings';
}

/** One check's block: its label line, its counts, its items. */
function block(result, label, context, extra = []) {
  const { counts, items } = detailOf(result, context);
  // A failed evidence read can carry both the command's output (or counts)
  // and a separate diagnostic explaining why those results cannot be used.
  if (result.status === 'failed' && result.summary.diagnostics) {
    const diagnostics = trimmed(lines(result.summary.diagnostics), 'lines');
    for (const diagnostic of diagnostics) {
      if (diagnostic !== counts && !items.includes(diagnostic)) items.push(diagnostic);
    }
  }
  return [`${result.name}: ${label}`, ...extra, ...(counts ? wrap(counts) : []), ...items];
}

/** Blocks under a heading, a blank line between two blocks of several lines. */
function section(heading, blocks) {
  if (!blocks.length) return null;
  return { lines: [heading, ...blocks.flatMap((lines, i) => (i > 0 ? ['', ...lines] : lines))] };
}

/** One-line entries under a heading. */
const list = (heading, entries) => (entries.length ? { lines: [heading, ...entries] } : null);

/**
 * The limitations results carry, and coverage that could not measure new
 * lines, said once each as warnings.
 */
function limitations(results, context) {
  const out = [];
  for (const result of results) {
    for (const limitation of result.summary?.limitations ?? []) out.push(`${result.name}: ${limitation}`);
    if (!usable(result)) continue;
    if (result.name === 'coverage' && context.touched === null && result.evidence.length) {
      out.push('coverage: there is no baseline to measure the new lines from.');
    }
    if (!TEST_QUALITY_RESULTS.includes(result.name)) {
      try { readSavedCheck(result, context.branch, context.root); }
      catch (error) { out.push(`${result.name}: ${error.message}`); }
    }
  }
  return out;
}

/**
 * The summary of a recorded verification.
 *
 * @param {{ seq?: number, event: string, payload: object }} event the
 *   `verified` or `verify_failed` event, or one without a `seq` when nothing
 *   was recorded
 * @param {{ branch: string, dir: string, root?: string, warnings?: string[],
 *   review?: string[], rerunOf?: (name: string) => string, live?: object[] }} context
 *   `warnings` are said as they are, wrapped; `review` lines are kept as they
 *   are. `rerunOf` names the command that runs a reused check on its own.
 *   `live` is the logbook's current events, where a reused result's
 *   producer is found; without it a reused check shows its reuse reason.
 */
export function verificationSummary(event, { branch, dir, root = process.cwd(), warnings = [], review = [], rerunOf, live = null } = {}) {
  const passed = event.event === 'verified';
  const results = event.payload.results;
  const { rulebookFingerprint, tail } = event.payload;
  const baseline = readBaseline(event.payload.baseline);
  const reading = { branch, root, live, before: event.seq ?? Infinity, baseline, rulebookFingerprint };
  const context = { ...reading, live: live ?? [], tail, reasonOf: result => producerReason(result, reading) };
  const evidenceWarnings = [];
  const coverage = resultIn(event, 'coverage');
  if (usable(coverage)) {
    try { context.touched = coverageMeasurement(coverage, context).touched; }
    catch (error) { evidenceWarnings.push(`coverage: ${error.message}`); }
  }
  const rerun = rerunOf ?? ((name) => rerunCommand(name, root));

  const failures = results.filter((result) => result.status === 'failed').map((result) => block(result, 'FAILED', context));
  // A failure no check owns, such as evidence that could not be read, is
  // said through verify's own tail, so a failed summary always names one.
  if (!passed && !failures.length) {
    failures.push(['verify: FAILED', 'No check failed: verify itself did.',
      ...trimmed(lines(event.payload.tail), 'lines')]);
  }
  const findings = results
    .filter((result) => result.status === 'partial' || (result.status === 'ok' && hasFindings(result, context)))
    .map((result) => (result.status === 'partial'
      // Mutation's counts already say what is unproved; another check's reason says why.
      ? block(result, 'PARTIAL', context, result.name === 'mutation' ? [] : wrap(result.reason))
      : block(result, 'FINDINGS', context)));
  const reused = results.filter((result) => result.status === 'reused').map((result) => block(result, 'REUSED', context, [
    ...wrap(`Stale: these results are from verified #${result.source.seq}, on an earlier tree, and were not measured again.`),
    ...wrap(`Run it again on its own: \`${rerun(result.name)}\`.`),
  ]));
  const warned = [...warnings, ...evidenceWarnings, ...limitations(results, context)].map((warning) => wrap(warning));
  const skipped = results.filter((result) => result.status === 'skipped')
    .flatMap((result) => wrap(`${result.name}: SKIPPED — ${result.reason}`));
  const clean = results.filter((result) => result.status === 'ok' && !hasFindings(result, context))
    .map((result) => `${result.name}: PASSED`);

  const blocks = [
    section('Failures:', failures),
    section('Findings:', findings),
    section('Reused:', reused),
    section('Warnings:', warned),
    list('Review:', review),
    list('Skipped:', skipped),
    list('Passed:', clean),
  ].filter(Boolean);
  const link = event.seq === undefined ? null : join(dir, fileFor(event));
  return compactReport({ title: passed ? PASSED : FAILED, blocks, link, limit: Infinity });
}
