/**
 * The minimum test coverage, checked against the report the rulebook's test
 * command writes.
 *
 * Coverage is the share of the code's lines and branches that some test runs.
 * `req:trace` proves one direction: every active requirement has a test.
 * Nothing proved the other, that the code written is reached by a test. Code no
 * test runs is either behaviour nobody checked or code no requirement asked
 * for, and both used to pass `workflow verify`.
 *
 * This does not ask for more coverage than there is. The minimums in
 * `.katatay/rulebook.json` are the figures measured when they were recorded, one
 * pair per folder, and the check fails when a folder falls below its own. So
 * the first change did not have to clean anything up, and no later change can
 * make things worse without the operator: no session may write that file (see
 * `SETTINGS_FILE` below).
 *
 * Be clear about what it shows. A covered line ran. Nothing here says anything
 * was asserted about it: a test gutted down to `expect(x).toBeTruthy()` keeps
 * its coverage in full.
 *
 * Per folder, not one figure for the whole repository, because the folders
 * differ too much for one number to hold any of them. Code that tests run only
 * in a separate process, such as pages behind a server or hooks started as
 * programs, sits near 0%, because coverage cannot see there. Against a single
 * overall figure, a well-tested folder falling from 94% to 80% would be hidden
 * by everything else.
 *
 * The suite does not run a second time for this. The test command clears old
 * source coverage and runs the tests. The quality check's command supplies
 * LCOV on stdout. The referee parses it once with `lcov.mjs`, checks folder
 * minimums, and saves its analysis to the entry's output file. Inside verify
 * it also keeps the raw LCOV and the analysis as snapshots, which the
 * verification's event names (`coverage-snapshot.mjs`). Everything after
 * verify reads those. The output file is a working copy, and changing it later
 * changes no verification.
 *
 * The lines no test ran feed the second thing here, `touchedCoverage`: the
 * new lines a change added that no test runs. The minimums only stop a folder
 * falling, so a new untested function in a well-covered folder passed them
 * unremarked. That half reports and never blocks.
 *
 * `.mjs` and beside the other workflow tools because `areas.mjs` flags the
 * settings file for review, and the two have to agree on its name.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, COVERAGE_OFF, coverageMinimumProblems, readChecks, TargetError } from './rulebook.mjs';
import { isCode, isFrozen, isTest } from './frozen.mjs';
import { gitLines } from './git.mjs';
import { parseLcov } from './lcov.mjs';
import { touchedFiles } from './touched.mjs';
import { readAdapter } from './adapter.mjs';
import { executeCheck } from './checks.mjs';
import { assertSameIdentity, checkIdentity, checkOutputDocument, inRoot, invalidateOutput, saveCheckOutput } from './check-output.mjs';
import { coverageDocumentFields, validateCoverageMeasurement } from './result-format.mjs';
import { versionedReader } from './json-fields.mjs';

/** Returns the coverage check, or undefined when the rulebook switches it off. */
export const configuredCoverage = (root = process.cwd()) => readChecks(root).testQuality.find((check) => check.name === 'coverage');
export const COVERAGE_SWITCHED_OFF = `not checked: coverage (checks.testQuality.coverage is "${COVERAGE_OFF}")`;

/** The coverage line for a change that touches no executable code line. */
export const NO_CODE_TOUCHED = 'Coverage: this change adds or changes no code, so no new line needs a test.';

/** The change's executable touched lines, counted once across overlapping
 * ranges. Blank lines and comments are absent from LCOV and never counted. */
export function analysedChange(answer, targets) {
  const uncovered = untestedTouched(answer, targets);
  const hit = new Map();
  const byFile = new Map(answer.files.map((entry) => [entry.file, entry.coveredLines]));
  for (const { file, lines } of targets) {
    const found = hit.get(file) ?? new Set();
    for (const line of byFile.get(file) ?? []) if (!lines || (line >= lines[0] && line <= lines[1])) found.add(line);
    hit.set(file, found);
  }
  const covered = [...hit.values()].reduce((sum, lines) => sum + lines.size, 0);
  return { covered, total: covered + uncovered.reduce((sum, entry) => sum + entry.lines.length, 0), uncovered };
}

/** Runs once, interprets stdout, and publishes analysis. A command's exit 0
 * only says it supplied data; the referee decides whether the minimums hold.
 *
 * `publish`, given by verify, keeps the raw report and the analysis as
 * snapshots of that verification and returns their references, which come
 * back on the result as `snapshots`. `workflow coverage` by hand passes none,
 * so it leaves no snapshot that no event names.
 * @param {{ publish?: (raw: string, analysis: string) => { raw: string, analysis: string } }} [options]
 * @returns {ReturnType<typeof executeCheck> & { baseline?: string | null, snapshots?: { raw: string, analysis: string } }} */
export function runCoverageCheck(check, root = process.cwd(), { publish } = {}) {
  let result = { outcome: 'broken', code: null, text: '', reason: '' };
  try {
    invalidateOutput(check, root);
    // The file comparison needs valid code/test globs even when git lists no
    // code yet; an empty listing must not hide a missing code paths.
    readAdapter(root);
    const identity = checkIdentity(root);
    let stdout = '';
    result = executeCheck(check, { root, baseline: () => {
      if (!identity.baseline) throw new TargetError('coverage: no baseline is available for the command');
      return identity.baseline;
    }, capture: (out) => { stdout = out; } });
    let coverage;
    if (result.outcome === 'clean') {
      try {
        const answer = parseLcov(stdout, root, 'coverage command stdout');
        const report = Object.fromEntries(answer.files.map((entry) => [entry.file, entry]));
        const files = inRoot(root, () => codeFiles(root, rootsOf(check.minimum)));
        const { folders, failures } = checkCoverage({ report, minimum: check.minimum, files });
        const touched = identity.baseline === null ? null : inRoot(root, () => analysedChange(answer,
          touchedFiles(identity.baseline, root, (file) => isCode(file) && !isFrozen(file))));
        const measurement = { folders, failures, touched };
        validateCoverageMeasurement(measurement, failures.length === 0);
        coverage = measurement;
        result = { ...result, outcome: failures.length ? 'findings' : 'clean',
          reason: failures.length ? 'coverage minimums or measured files failed' : 'every folder is at or above its minimum',
          text: [result.text, ...renderFolders(folders), ...failures.map((failure) => `FAILED — ${failure}`)].filter(Boolean).join('\n') };
      } catch (error) {
        result = { ...result, outcome: 'broken', reason: `coverage could not be analysed: ${error.message}` };
      }
    }
    let snapshots;
    if (publish && coverage !== undefined) {
      // Checked before publishing, so a snapshot never describes a tree the
      // check did not measure. `saveCheckOutput` checks again for its file.
      assertSameIdentity(check, identity, root);
      snapshots = publish(stdout, checkOutputDocument(check, result, coverage));
    }
    saveCheckOutput(check, result, identity, root, coverage);
    return snapshots ? { ...result, snapshots, baseline: identity.baseline } : result;
  } catch (error) {
    return { ...result, outcome: 'broken', reason: `coverage could not be saved: ${error.message}` };
  }
}

/** The caller supplies the baseline in force when the command ran. */
export function coverageAnalysis(document, baseline, successful = true, at = 'coverage analysis') {
  try { return readCoverageDocument(document, at, baseline, successful); }
  catch (error) {
    if (error instanceof TargetError) throw error;
    throw new TargetError('coverage: saved analysis has an invalid shape: ' + error.message);
  }
}

const readCoverageDocument = versionedReader((document, at, baseline, successful) => {
  coverageDocumentFields(document, at);
  if (baseline !== null && !(typeof baseline === 'string' && baseline.length)) {
    throw new TargetError('coverage: the producing baseline is required');
  }
  const { result, measurement: c } = document;
  if (successful && result.outcome !== 'clean') throw new TargetError(`coverage: saved analysis is not successful (${result.reason})`);
  try { validateCoverageMeasurement(c, result.outcome === 'clean'); }
  catch (error) { throw new TargetError(`coverage: saved analysis has invalid coverage figures: ${error.message}`); }
  if ((c.touched === null) !== (baseline === null)) {
    throw new TargetError('coverage: saved analysis has invalid coverage figures: touched coverage disagrees with its baseline');
  }
  return c;
});

/**
 * Where the minimums are kept: `.katatay/rulebook.json`, under
 * `checks.testQuality.coverage.minimum`, in the rulebook beside the target the tools
 * measure from.
 *
 * They used to sit in a file of their own, `harness.settings.json`, which a
 * session could write. That was on purpose: a change that adds tested code has
 * to raise a minimum, and recording one is part of an honest change. But a
 * session that can raise a figure can lower one, and lowering it passed the
 * check with no test written. Review was the only thing in the way.
 *
 * The operator decided on 2026-10-12 to keep one config file, this one, which
 * the path hook closes to every session. So a minimum can no longer be lowered,
 * raised or removed from inside a session at all. The cost is the one the
 * earlier decision avoided: when a figure should rise, or a new measured folder
 * needs a minimum, the session prepares a patch and the operator applies it.
 */
export const SETTINGS_FILE = CONFIG;

const KINDS = [['lines', 'line'], ['branches', 'branch']];

/**
 * A share as tenths of a percent, rounded down: 250 of 266 is 939, shown as
 * 93.9%.
 *
 * Down, never to the nearest. A minimum is recorded from this figure, so
 * rounding 93.98 up to 94.0 would record a minimum the code that produced it
 * does not meet. Tenths, because a whole percent of a 900-line folder is nine
 * lines nobody would be asked about. And as a whole number, so that comparing
 * with a minimum never turns on how 93.9 happens to be stored as a fraction.
 *
 * Nothing to cover counts as fully covered, as it does in the report itself: a
 * folder of files with no branches in them has no untested branch.
 */
export const tenths = (covered, total) => (total === 0 ? 1000 : Math.floor((covered * 1000) / total));

/** Tenths as the figure people read: 939 is `93.9%`. */
export const percent = (value) => `${(value / 10).toFixed(1)}%`;

/**
 * The measured figure of every folder, and everything that fails.
 *
 * `report` has one entry per measured file, keyed by its path from the root
 * with `/`, each with `lines` and `branches` as `{ covered, total }`: the
 * parsed coverage report, keyed by file. The folder figures are summed
 * from the files, so a folder's figure is its covered lines over its lines, not an
 * average of its files' percentages, which would let a three-line file weigh
 * as much as a three-hundred-line one.
 *
 * It fails on three things besides a figure below its minimum.
 *
 * A folder with a minimum and no measured files. Narrowing what the coverage
 * tool's config includes would otherwise make a folder vanish from the report,
 * and a folder that is not there has nothing below its minimum.
 *
 * A measured file under no folder that has a minimum. A new folder would
 * otherwise be measured and never checked. The fix is a minimum for it,
 * which is an edit review is told to read.
 *
 * Minimums that are themselves wrong. See `coverageMinimumProblems`.
 *
 * A file belongs to the longest folder that holds it, so a minimum for
 * `src/` beside one for `src/workflow/` would count each file once.
 *
 * And it fails on a code file that is on disk and not in the report. `files`
 * is that list of code files (see `codeFiles`). Lowering a minimum is one way
 * to pass this check without writing a test, and the path hook closes it. The
 * other is to measure less: an exclusion in the coverage tool's config, or a
 * narrower inclusion, takes a file out of the report, and its uncovered lines
 * leave the folder's figure with it. A project can pin those lists with a test
 * of its config, but a test can be edited once the triage has run. Here the
 * report is compared with what is on disk, so a file that stopped being
 * measured fails the check whatever the config and its test say. Nothing
 * allows an exclusion: code is never left out of the figure, and a setting
 * that permitted it would be the hole again.
 *
 * @param {{ report: Record<string, any>, minimum: Record<string, { lines: number, branches: number }>, files?: string[] }} input
 * @returns {{ folders: { folder: string, files: number, lines: any, branches: any }[], failures: string[] }}
 */
export function checkCoverage({ report, minimum, files = [] }) {
  const failures = coverageMinimumProblems(minimum, 'checks.testQuality.coverage.minimum');
  if (failures.length > 0) return { folders: [], failures };

  const names = Object.keys(minimum).sort((a, b) => b.length - a.length);
  const sums = new Map(Object.keys(minimum).map((folder) => [folder, {
    folder, files: 0, lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 },
  }]));

  const strays = [];
  const reported = new Set();
  for (const [file, entry] of Object.entries(report)) {
    reported.add(file);
    const folder = names.find((name) => file.startsWith(name));
    if (!folder) {
      strays.push(file);
      continue;
    }
    const sum = sums.get(folder);
    sum.files += 1;
    for (const [kind] of KINDS) {
      sum[kind].covered += entry[kind].covered;
      sum[kind].total += entry[kind].total;
    }
  }

  const folders = [];
  for (const sum of sums.values()) {
    if (sum.files === 0) {
      failures.push(`${sum.folder}: no file under it was measured, so its minimum checks nothing. `
        + 'Either the folder is gone, or the coverage tool\'s settings no longer reach it.');
      continue;
    }
    for (const [kind, word] of KINDS) {
      const { covered, total } = sum[kind];
      const measured = tenths(covered, total);
      const least = Math.round(minimum[sum.folder][kind] * 10);
      sum[kind] = { covered, total, measured, minimum: least };
      if (measured < least) {
        failures.push(`${sum.folder}: ${word} coverage is ${percent(measured)}, below the minimum of ${percent(least)} `
          + `(${covered} of ${total} ${kind} covered).`);
      }
    }
    folders.push(sum);
  }

  if (strays.length > 0) {
    failures.push(`measured, but under no folder that has a minimum in ${SETTINGS_FILE}: ${strays.sort().join(', ')}. `
      + 'Give the folder a minimum there.');
  }

  const unmeasured = files.filter((file) => !reported.has(file)).sort();
  if (unmeasured.length > 0) {
    failures.push(`code, but not in the coverage report: ${unmeasured.join(', ')}. `
      + 'The coverage tool\'s settings took it out of what is measured, '
      + 'or the report is older than the file: verify writes a new one. Code is never left out of the figure.');
  }
  return { folders, failures };
}

/**
 * The top-level folders the minimums cover: `src/` for `src/workflow/`.
 *
 * The code files are listed under these and not under the folders that have a
 * minimum. A new `src/something/` has no minimum yet, and listing only what
 * has one would leave its files out of the comparison in the one case where
 * nothing else would mention them, a folder both new and excluded.
 */
const rootsOf = (minimum) => (minimum !== null && typeof minimum === 'object' && !Array.isArray(minimum)
  ? [...new Set(Object.keys(minimum).map((folder) => `${folder.split('/')[0]}/`))].sort()
  : []);

/**
 * Every code file under the measured folders that is on disk and that git does
 * not ignore, tracked or not, tests left out. Untracked files count, so a new
 * file counts before it is committed.
 *
 * `isCode` and `isTest` come from `frozen.mjs`, which already says what a
 * code file and a test file are.
 *
 * @param {string} root
 * @param {string[]} roots folders from the root, each ending in `/`
 */
export function codeFiles(root, roots) {
  if (roots.length === 0) return [];
  return gitLines(['ls-files', '--cached', '--others', '--exclude-standard', '--', ...roots], { cwd: root })
    .filter((file) => isCode(file) && !isTest(file) && existsSync(join(root, file)));
}

/** One line per folder: what was measured, beside what it must not fall below.
 *  Printed on a pass as well, so a figure that has risen clear of its minimum
 *  is seen by whoever could raise the minimum to meet it. */
export function renderFolders(folders) {
  const width = Math.max(0, ...folders.map(({ folder }) => folder.length));
  return folders.map(({ folder, lines, branches }) =>
    `${folder.padEnd(width)}  lines ${percent(lines.measured).padStart(6)} (minimum ${percent(lines.minimum)})`
    + `  branches ${percent(branches.measured).padStart(6)} (minimum ${percent(branches.minimum)})`);
}

/** Run coverage by hand without rerunning tests. The analysis is the same
 * evidence verify writes for its consumers. */
export function coverageCheck(root = process.cwd()) {
  if (!existsSync(join(root, SETTINGS_FILE))) return { ok: false, lines: [`refused — ${SETTINGS_FILE} is missing, so there are no minimums to check against.`] };
  try {
    const check = configuredCoverage(root);
    if (!check) return { ok: true, lines: [COVERAGE_SWITCHED_OFF] };
    const result = runCoverageCheck(check, root);
    return { ok: result.outcome === 'clean', lines: [result.text, result.reason].filter(Boolean) };
  } catch (error) { return { ok: false, lines: [`refused — ${error.message}`] }; }
}

/**
 * The touched lines no test ran, per file.
 *
 * `answer` is the parsed coverage report, and `targets` the touched
 * ranges from `./touched.mjs`. A whole-file target, a file git has not been
 * told about, takes every line no test ran. A touched file the answer does not
 * list is left out: `coverageCheck` already fails a code file missing from the
 * report, so saying it again here would be noise.
 *
 * `uncoveredLines` holds only lines that can run, so a blank line or a
 * comment in a touched range is never listed.
 *
 * @param {{ files: { file: string, uncoveredLines: number[] }[] }} answer
 * @param {{ file: string, lines?: [number, number] }[]} targets
 * @returns {{ file: string, lines: number[] }[]} sorted by file, lines ascending
 */
export function untestedTouched(answer, targets) {
  const uncovered = new Map(answer.files.map((entry) => [entry.file, entry.uncoveredLines]));
  const found = new Map();
  for (const { file, lines } of targets) {
    const missed = uncovered.get(file);
    if (missed === undefined) continue;
    const inside = lines === undefined ? missed : missed.filter((n) => n >= lines[0] && n <= lines[1]);
    if (inside.length === 0) continue;
    const set = found.get(file) ?? new Set();
    for (const n of inside) set.add(n);
    found.set(file, set);
  }
  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, set]) => ({ file, lines: [...set].sort((a, b) => a - b) }));
}

/** Sorted line numbers as runs: `[12, 13, 14, 30]` reads `12-14, 30`. */
export function lineRanges(lines) {
  const runs = [];
  for (const n of lines) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

const lineCount = (n) => `${n} ${n === 1 ? 'line' : 'lines'}`;

/**
 * What `untestedTouched` found, as the lines of the report.
 *
 * Each file on a line of its own, with the count first, so a file a test never
 * loads, which lists every line it has, still reads as one line.
 *
 * @param {{ file: string, lines: number[] }[]} gaps
 * @returns {string[]}
 */
export function renderUntested(gaps) {
  if (gaps.length === 0) return ['Coverage: every new line this change added runs under some test.'];
  const total = gaps.reduce((sum, { lines }) => sum + lines.length, 0);
  return [
    `Coverage: ${lineCount(total)} this change added that no test runs. For each, write`,
    '  the test that runs it, or say why none can, such as code that runs only',
    '  in a separate process, where coverage cannot see.',
    ...gaps.map(({ file, lines }) => `  - ${file}: ${lineCount(lines.length)} (${lineRanges(lines)})`),
  ];
}

/**
 * The coverage half of the test-quality report, for the verification that
 * just passed.
 *
 * `result` is that verify's coverage result, and `analysis` what turn end read
 * from the snapshot the result names. Nothing here reads a file: the check
 * already selected touched code lines outside the freeze, since lines in a
 * test say nothing about whether the code is tested.
 *
 * @param {{ outcome: string, reason: string } | undefined} result
 * @param {ReturnType<typeof coverageAnalysis> | null} analysis
 * @returns {string[]}
 */
export function touchedCoverage(result, analysis) {
  if (configuredCoverage() === undefined) return [`Coverage: ${COVERAGE_SWITCHED_OFF}.`];
  if (!result) return ['Coverage: verify supplied no coverage result.'];
  if (result.outcome === 'skipped') return [`Coverage: ${result.reason}`];
  if (!analysis) return ['Coverage: verify supplied no coverage analysis.'];
  if (analysis.touched === null) return ['Coverage: there is no baseline to measure the new lines from.'];
  // No executable line touched is a different fact from every touched line
  // covered, and reads as one only by accident.
  if (analysis.touched.total === 0) return [NO_CODE_TOUCHED];
  return renderUntested(analysis.touched.uncovered);
}
