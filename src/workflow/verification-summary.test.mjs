import { beforeEach, expect, it, vi } from 'vitest';
import { readTestAnalysis } from './junit-snapshot.mjs';
import { readCoverageSnapshot } from './coverage-snapshot.mjs';
import { readMutationSnapshot } from './mutation-snapshot.mjs';
import { checkText, producerEvent } from './result-readers.mjs';
import { readChecks } from './rulebook.mjs';
import { FAILED, PASSED, rerunCommand, verificationSummary } from './verification-summary.mjs';
import { verificationInputs } from '../../tests/fixtures/workflow/events.mjs';
import { LINES, NO_EVENT } from './compact-report.mjs';

vi.mock('./junit-snapshot.mjs', { spy: true });
vi.mock('./coverage-snapshot.mjs', { spy: true });
vi.mock('./mutation-snapshot.mjs', { spy: true });
vi.mock('./result-readers.mjs', { spy: true });
vi.mock('./rulebook.mjs', { spy: true });

const DIR = '.katatay/state/topic';
const context = (more = {}) => ({ branch: 'topic', dir: DIR, rerunOf: name => `run ${name}`, ...more });
const raw = name => ({ role: 'raw', title: `${name} raw`, snapshot: `${name}.raw` });
const analysis = name => ({ role: 'analysis', title: `${name} analysis`, snapshot: `${name}.json` });
const ok = (name, outcome = 'clean', more = {}) => ({ name, status: 'ok', reason: outcome, evidence: [], summary: { outcome }, ...more });
const skipped = (name, reason) => ({ name, status: 'skipped', reason, evidence: [], summary: {} });
const testsOk = (total = 120) => ({ name: 'tests', status: 'ok', reason: 'Check passed.', evidence: [raw('junit'), analysis('junit')],
  summary: { total, passed: total, failed: 0, skipped: 0, inverted: 0, omittedFiles: 0 } });
const coverageOk = () => ({ name: 'coverage', status: 'ok', reason: 'every folder is at or above its minimum',
  evidence: [raw('lcov'), analysis('coverage')], summary: { folders: [] } });
const mutationOk = (survived, more = {}) => ({ name: 'mutation', status: 'ok', reason: 'measured',
  evidence: [raw('mutation'), analysis('mutation')],
  summary: { totalMutants: survived + 10, killed: 10, survived, unproved: 0, ignored: 0, errored: 0 }, ...more });
const event = (name, results, more = {}) => ({ seq: 7, event: name, payload: { ...verificationInputs, treeFingerprint: 't', results, ...more } });
const survivor = (file, line, mutator, replacement) => ({ file, location: { start: { line } }, mutator, replacement });

beforeEach(() => {
  vi.clearAllMocks();
  readCoverageSnapshot.mockReturnValue({ touched: { covered: 10, total: 10, uncovered: [] } });
  readMutationSnapshot.mockReturnValue({ findings: { survivors: [] } });
  readTestAnalysis.mockReturnValue({ cases: [], leftOut: [] });
  checkText.mockReturnValue('');
});

it('lays out the busiest pass: findings, reused, warnings, review, skipped, then passed', () => {
  readCoverageSnapshot.mockReturnValue({ touched: { covered: 6, total: 10,
    uncovered: [{ file: 'tools/a.mjs', lines: [3, 4, 5, 9] }, { file: 'tools/b.mjs', lines: [1, 2, 3] }] } });
  readMutationSnapshot.mockImplementation((branch, references) => (references.raw === 'audit.raw' ? null : { findings: { survivors: [
    survivor('tools/a.mjs', 3, 'EqualityOperator', 'a !== b'),
    survivor('tools/a.mjs', 4, 'ConditionalExpression', 'true'),
    survivor('tools/a.mjs', 5, 'StringLiteral', '""'),
    survivor('tools/b.mjs', 1, 'BlockStatement', '{}'),
    survivor('tools/b.mjs', 2, 'ArrowFunction'),
    survivor('tools/b.mjs', 3, 'MethodExpression', 'items.filter(item => item.ready)\n  .map(item => item.name)'),
  ] } }));
  checkText.mockImplementation(result => (result.name === 'boundaries' ? 'tools/a.mjs → app/x.ts\n\ntools/b.mjs → app/y.ts\n' : 'audit finding'));
  const summary = verificationSummary(event('verified', [
    ok('req:lint'),
    ok('boundaries', 'findings', { evidence: [raw('boundaries')], reason: 'findings (exit 1)' }),
    { ...ok('audit', 'findings', { evidence: [raw('audit')], reason: 'Runs once per approved plan.' }), status: 'reused', source: { seq: 4, fingerprint: 'f'.repeat(64) } },
    skipped('build', 'skipped in CI (skipInCi: true)'),
    testsOk(), coverageOk(), mutationOk(6),
  ]), context({
    warnings: ["settings: claude: ~/.claude/settings.json registers a PreToolUse hook `node ~/bin/approve.mjs` for ExitPlanMode. It can answer the plan dialog."],
    review: ['The rulebook. A floor changed here changes what passes.', '- .katatay/rulebook.json'],
  }));
  expect(summary).toBe([
    'Verification passed.',
    '',
    'Findings:',
    'boundaries: FINDINGS',
    'findings (exit 1)',
    'tools/a.mjs → app/x.ts',
    'tools/b.mjs → app/y.ts',
    '',
    'coverage: FINDINGS',
    '7 / 10 touched lines run by no test',
    'tools/a.mjs: 3-5, 9',
    'tools/b.mjs: 1-3',
    '',
    'mutation: FINDINGS',
    '6 survived · 10 killed · 16 mutants',
    'tools/a.mjs:3 EqualityOperator → a !== b',
    'tools/a.mjs:4 ConditionalExpression → true',
    'tools/a.mjs:5 StringLiteral → ""',
    'tools/b.mjs:1 BlockStatement → {}',
    'tools/b.mjs:2 ArrowFunction',
    '[…] Output trimmed. All 6 survivors are in the details file.',
    '',
    'Reused:',
    'audit: REUSED',
    'Stale: these results are from verified #4, on an earlier tree, and were not',
    'measured again.',
    'Run it again on its own: `run audit`.',
    'Runs once per approved plan.',
    'audit finding',
    '',
    'Warnings:',
    'settings: claude: ~/.claude/settings.json registers a PreToolUse hook `node',
    '~/bin/approve.mjs` for ExitPlanMode. It can answer the plan dialog.',
    '',
    'Review:',
    'The rulebook. A floor changed here changes what passes.',
    '- .katatay/rulebook.json',
    '',
    'Skipped:',
    'build: SKIPPED — skipped in CI (skipInCi: true)',
    '',
    'Passed:',
    'req:lint: PASSED',
    'tests: PASSED',
    '',
    `Details: ${DIR}/0007__verified.json`,
  ].join('\n'));
});

it('lays out the busiest failure: failures first, with left-out files before failed tests, then skipped and passed', () => {
  readTestAnalysis.mockReturnValue({
    leftOut: [{ file: 'tools/c.test.mjs' }],
    cases: [
      { file: 'tools/a.test.mjs', name: 'group > passes', status: 'passed' },
      ...Array.from({ length: 6 }, (_, i) => ({ file: 'tools/b.test.mjs', name: `fails ${i + 1}`, status: 'failed' })),
    ],
  });
  const failedTests = { name: 'tests', status: 'failed', reason: 'Check failed.', evidence: [raw('junit'), analysis('junit')],
    summary: { total: 40, passed: 34, failed: 6, skipped: 0, inverted: 0, omittedFiles: 1 } };
  const failedCoverage = { name: 'coverage', status: 'failed', reason: 'a folder is below its minimum', evidence: [],
    summary: { folders: [{ folder: 'modules/', lines: { percent: 93.1, target: 94.5 }, branches: { percent: 99, target: 98.5 } }] } };
  const summary = verificationSummary(event('verify_failed', [ok('req:lint'), skipped('build', 'An earlier step stopped verification.'), failedTests, failedCoverage, skipped('mutation', 'An earlier step stopped verification.')], { tail: 'verify: failed at tests.' }), context());
  expect(summary).toBe([
    'Verification failed.',
    '',
    'Failures:',
    'tests: FAILED',
    '6 / 40 failed, 1 file left out of the report',
    'tools/c.test.mjs — left out of the report',
    'tools/b.test.mjs — fails 1',
    'tools/b.test.mjs — fails 2',
    'tools/b.test.mjs — fails 3',
    'tools/b.test.mjs — fails 4',
    '[…] Output trimmed. All 7 failures are in the details file.',
    '',
    'coverage: FAILED',
    '1 minimum not met',
    'modules/ lines 93.1%, minimum 94.5%',
    '',
    'Skipped:',
    'build: SKIPPED — An earlier step stopped verification.',
    'mutation: SKIPPED — An earlier step stopped verification.',
    '',
    'Passed:',
    'req:lint: PASSED',
    '',
    `Details: ${DIR}/0007__verify_failed.json`,
  ].join('\n'));
});

it('shows a referee step that kept no output by the last lines of verify\'s tail, without its closing line', () => {
  const tail = ['req:lint — catalogue OK', 'state: one', 'state: two', 'state: three', 'state: four', 'state: five', '', 'verify: failed at state:verify.'].join('\n');
  const failed = { name: 'state:verify', status: 'failed', reason: 'Check failed.', evidence: [], summary: {} };
  const summary = verificationSummary(event('verify_failed', [failed, skipped('tests', 'stopped')], { tail }), context());
  expect(summary).toContain('state:verify: FAILED\nCheck failed.\nstate: one\nstate: two\nstate: three\nstate: four\nstate: five\n'
    + '[…] Output trimmed. The last 6 lines of verify\'s output are in the details file.\n');
  expect(summary).not.toContain('catalogue OK');
  expect(summary).not.toContain('verify: failed at');
  const short = verificationSummary(event('verify_failed', [failed], { tail: 'state: broken\nverify: failed at state:verify.' }), context());
  expect(short).toContain('state:verify: FAILED\nCheck failed.\nstate: broken\n\n');
});

it('lists a failed check by its own diagnostics before the tail', () => {
  const failed = { name: 'compile', status: 'failed', reason: 'Check failed.', evidence: [], summary: { diagnostics: 'a.ts:1 bad\nb.ts:2 worse' } };
  const summary = verificationSummary(event('verify_failed', [failed], { tail: 'from the tail' }), context());
  expect(summary).toContain('compile: FAILED\nCheck failed.\na.ts:1 bad\nb.ts:2 worse\n');
  expect(summary).not.toContain('from the tail');
});

it('says verify itself failed when no check did, or when it recorded no checks, with the tail as its items', () => {
  const none = verificationSummary({ seq: 2, event: 'verify_failed', payload: { treeFingerprint: 't', results: [], tail: 'Verify executable could not start.' } }, context());
  expect(none).toBe(['Verification failed.', '', 'Failures:', 'verify: FAILED', 'No check failed: verify itself did.',
    'Verify executable could not start.', '', `Details: ${DIR}/0002__verify_failed.json`].join('\n'));
  const owned = verificationSummary(event('verify_failed', [ok('req:lint')], { tail: 'verify returned unusable check evidence: gone' }), context());
  expect(owned).toContain('Failures:\nverify: FAILED\nNo check failed: verify itself did.\nverify returned unusable check evidence: gone\n');
});

it('says why the tests cannot be named, and keeps their counts, when the analysis cannot be read', () => {
  readTestAnalysis.mockImplementation(() => { throw Error('the analysis is gone'); });
  const failed = { name: 'tests', status: 'failed', reason: 'Check failed.', evidence: [raw('junit')],
    summary: { total: 3, passed: 2, failed: 1, skipped: 0, inverted: 0, omittedFiles: 0 } };
  expect(verificationSummary(event('verify_failed', [failed]), context()))
    .toContain('tests: FAILED\n1 / 3 failed\nThe tests cannot be listed: the analysis is gone\n');
  const diagnosed = { name: 'tests', status: 'failed', reason: 'Check failed.', evidence: [], summary: { diagnostics: 'no report' } };
  expect(verificationSummary(event('verify_failed', [diagnosed]), context())).toContain('tests: FAILED\nCheck failed.\nno report\n');
});

it('says why survivors cannot be listed, and keeps their counts, when the mutation snapshot cannot be read', () => {
  readMutationSnapshot.mockImplementation(() => { throw Error('the findings are gone'); });
  expect(verificationSummary(event('verified', [mutationOk(2)]), context()))
    .toContain('mutation: FINDINGS\n2 survived · 10 killed · 12 mutants\nThe survivors cannot be listed: the findings are gone\n');
});

it('shows a partial mutation run by its counts, and a partial test run with its reason', () => {
  const partial = { ...mutationOk(0), status: 'partial', reason: 'Mutation measurement is incomplete.',
    summary: { totalMutants: 4, killed: 1, survived: 0, unproved: 2, ignored: 0, errored: 1 } };
  const tests = { ...testsOk(5), status: 'partial', reason: 'not checked: inverted tests' };
  const summary = verificationSummary(event('verified', [tests, coverageOk(), partial]), context());
  expect(summary).toContain('Findings:\ntests: PARTIAL\nnot checked: inverted tests\n0 / 5 failed\n\nmutation: PARTIAL\n0 survived · 1 killed · 4 mutants · 2 unproved · 1 errored\n\n');
  expect(summary).toContain('Passed:\ncoverage: PASSED\n');
});

it('cuts a long replacement to one short line, and keeps the survivor\'s place whole', () => {
  readMutationSnapshot.mockReturnValue({ findings: { survivors: [survivor('src/workflow/a-rather-long-module-name.mjs', 120, 'ConditionalExpression', `${'x'.repeat(100)}\ny`)] } });
  const summary = verificationSummary(event('verified', [mutationOk(1)]), context());
  const row = summary.split('\n').find(line => line.startsWith('src/workflow/a-rather-long-module-name.mjs:120 ConditionalExpression → '));
  expect(row.endsWith('…')).toBe(true);
  expect([...row].length).toBeLessThanOrEqual(76 + 20);
});

it('says limitations and coverage with no baseline as warnings', () => {
  readCoverageSnapshot.mockReturnValue({ touched: null });
  const summary = verificationSummary(event('verified', [ok('lint', 'clean', { summary: { outcome: 'clean', limitations: ['the config was not found'] } }), coverageOk()]), context());
  expect(summary).toContain('Warnings:\nlint: the config was not found\n\ncoverage: there is no baseline to measure the new lines from.\n');
});

it('keeps every check of a summary longer than the usual ceiling', () => {
  const many = Array.from({ length: LINES * 2 }, (_, i) => ok(`check-${i}`));
  const summary = verificationSummary(event('verified', [...many]), context());
  for (const check of many) expect(summary).toContain(`\n${check.name}: PASSED\n`);
  expect(summary.endsWith(`Details: ${DIR}/0007__verified.json`)).toBe(true);
});

it('says no event was recorded instead of giving a link', () => {
  const summary = verificationSummary({ event: 'verified', payload: { ...verificationInputs, treeFingerprint: 't', results: [ok('a')] } }, context());
  expect(summary).toBe([PASSED, '', 'Passed:', 'a: PASSED', '', NO_EVENT].join('\n'));
  expect(FAILED).toBe('Verification failed.');
});

it('names the command that runs a reused check again on its own', () => {
  readChecks.mockReturnValue({ testQuality: [{ name: 'audit', command: 'npm run audit' }], codeQuality: [] });
  expect(rerunCommand('mutation')).toBe('workflow mutate');
  expect(rerunCommand('audit')).toBe('npm run audit');
  expect(rerunCommand('unknown')).toBe('workflow verify --rerun');
  readChecks.mockReturnValue({ testQuality: [{ name: 'audit' }], codeQuality: [] });
  expect(rerunCommand('audit')).toBe('workflow verify --rerun');
  readChecks.mockImplementation(() => { throw Error('no rulebook'); });
  expect(rerunCommand('audit')).toBe('workflow verify --rerun');
});

it('says why a partial mutation run is partial: proved nothing, in the tool\'s words, or stopped early', () => {
  const partial = summary => ({ ...mutationOk(0), status: 'partial', reason: 'Mutation measurement is incomplete: 0 mutants, 0 caught, 0 survived', summary });
  readMutationSnapshot.mockReturnValue({ outcome: 'nothing', findings: { survivors: [] },
    report: 'Mutation testing on the lines this change added or changed:\n  The run proves nothing this time.\n\n  No test imports the code.\n  Nothing was run.' });
  expect(verificationSummary(event('verified', [partial({ totalMutants: 0, killed: 0, survived: 0, unproved: 0, ignored: 0, errored: 0 })]), context()))
    .toContain('mutation: PARTIAL\n0 survived · 0 killed · 0 mutants\nThe run proves nothing this time. The tool said:\nNo test imports the code.\nNothing was run.\n\n');
  readMutationSnapshot.mockReturnValue({ outcome: 'survived', findings: { partial: true, survivors: [survivor('a.mjs', 2, 'BooleanLiteral', 'false')] } });
  expect(verificationSummary(event('verified', [partial({ totalMutants: 9, killed: 4, survived: 1, unproved: 4, ignored: 0, errored: 0 })]), context()))
    .toContain('mutation: PARTIAL\n1 survived · 4 killed · 9 mutants · 4 unproved\nThe run stopped before it tested every mutant.\na.mjs:2 BooleanLiteral → false\n\n');
  readMutationSnapshot.mockReturnValue({ outcome: 'clean', findings: { survivors: [] } });
  expect(verificationSummary(event('verified', [partial({ totalMutants: 3, killed: 1, survived: 0, unproved: 2, ignored: 0, errored: 0 })]), context()))
    .toContain('mutation: PARTIAL\n0 survived · 1 killed · 3 mutants · 2 unproved\n\n');
});

it('shows a reused check by its producer\'s reason, and by the reuse reason when the producer cannot be read', () => {
  const reused = { ...ok('audit', 'findings', { reason: 'Runs once per approved plan.' }), status: 'reused', source: { seq: 4, fingerprint: 'f'.repeat(64) } };
  const producer = { seq: 4, event: 'verified', payload: { results: [ok('audit', 'findings', { reason: 'findings (exit 1)' })] } };
  producerEvent.mockReturnValueOnce(producer);
  const live = [producer];
  expect(verificationSummary(event('verified', [reused]), context({ live }))).toContain('`run audit`.\nfindings (exit 1)\n');
  expect(producerEvent).toHaveBeenCalledWith(reused, expect.objectContaining({ ...verificationInputs, live, branch: 'topic', before: 7 }));
  producerEvent.mockImplementationOnce(() => { throw Error('tampered'); });
  expect(verificationSummary(event('verified', [reused]), context({ live }))).toContain('`run audit`.\nRuns once per approved plan.\n');
  expect(verificationSummary(event('verified', [reused]), context())).toContain('`run audit`.\nRuns once per approved plan.\n');
});

// A pass reads the coverage analysis before its receipt, so an unreadable one
// fails verify first; here it is only not read as findings.
it('lists coverage as passed, not as findings, when its analysis cannot be read', () => {
  readCoverageSnapshot.mockImplementation(() => { throw Error('gone'); });
  const summary = verificationSummary(event('verified', [coverageOk()]), context());
  expect(summary).toContain('Passed:\ncoverage: PASSED\n');
  expect(summary).not.toContain('Findings:');
  expect(summary).not.toContain('touched lines');
  expect(summary).toContain('Warnings:\ncoverage: gone');
  expect(summary).not.toContain('no baseline');
});

it('lists a coverage failure with no folder below its minimum by its diagnostics, and trims many folders', () => {
  const failed = folders => ({ name: 'coverage', status: 'failed', reason: 'the coverage check failed', evidence: [],
    summary: { folders, diagnostics: 'the LCOV report is missing' } });
  const at = { folder: 'modules/', lines: { percent: 94.5, target: 94.5 }, branches: { percent: 99, target: 98.5 } };
  expect(verificationSummary(event('verify_failed', [failed([at])]), context()))
    .toContain('coverage: FAILED\nthe coverage check failed\nthe LCOV report is missing\n');
  const below = Array.from({ length: 6 }, (_, i) => ({ folder: `f${i}/`, lines: { percent: 1, target: 2 }, branches: { percent: 3, target: 3 } }));
  const many = verificationSummary(event('verify_failed', [failed([at, ...below])]), context());
  expect(many).toContain('coverage: FAILED\n6 minimums not met\nf0/ lines 1%, minimum 2%\n');
  expect(many).toContain('[…] Output trimmed. All 6 minimums are in the details file.');
  expect(many).not.toContain('modules/');
});

it('trims coverage findings past five files', () => {
  readCoverageSnapshot.mockReturnValue({ touched: { covered: 0, total: 6, uncovered: Array.from({ length: 6 }, (_, i) => ({ file: `f${i}.mjs`, lines: [1] })) } });
  expect(verificationSummary(event('verified', [coverageOk()]), context()))
    .toContain('6 / 6 touched lines run by no test\nf0.mjs: 1\nf1.mjs: 1\nf2.mjs: 1\nf3.mjs: 1\nf4.mjs: 1\n[…] Output trimmed. All 6 files are in the details file.\n');
});

it('cuts a replacement only past the room its row leaves, keeping room - 1 characters and the ellipsis', () => {
  const at = 'a.mjs:1 StringLiteral';
  const room = 76 - at.length - 3;
  const rowOf = text => {
    readMutationSnapshot.mockReturnValue({ findings: { survivors: [survivor('a.mjs', 1, 'StringLiteral', text)] } });
    return verificationSummary(event('verified', [mutationOk(1)]), context()).split('\n').find(line => line.startsWith(at));
  };
  expect(rowOf('x'.repeat(room))).toBe(`${at} → ${'x'.repeat(room)}`);
  expect(rowOf('x'.repeat(room + 1))).toBe(`${at} → ${'x'.repeat(room - 1)}…`);
  const long = 'src/workflow/a-module-whose-name-is-long-enough-to-use-up-the-row.mjs:1 ConditionalExpression';
  readMutationSnapshot.mockReturnValue({ findings: { survivors: [survivor('src/workflow/a-module-whose-name-is-long-enough-to-use-up-the-row.mjs', 1, 'ConditionalExpression', 'y'.repeat(40))] } });
  const kept = verificationSummary(event('verified', [mutationOk(1)]), context()).split('\n').find(line => line.startsWith(long));
  expect(kept).toBe(`${long} → ${'y'.repeat(19)}…`);
});

it('lists tests that failed only through files left out of the report', () => {
  readTestAnalysis.mockReturnValue({ leftOut: [{ file: 'a.test.mjs' }, { file: 'b.test.mjs' }], cases: [] });
  const failed = { name: 'tests', status: 'failed', reason: 'Check failed.', evidence: [raw('junit'), analysis('junit')],
    summary: { total: 4, passed: 4, failed: 0, skipped: 0, inverted: 0, omittedFiles: 2 } };
  expect(verificationSummary(event('verify_failed', [failed]), context()))
    .toContain('tests: FAILED\n0 / 4 failed, 2 files left out of the report\na.test.mjs — left out of the report\nb.test.mjs — left out of the report\n');
});

it('reads no test analysis, and no mutation snapshot, when nothing failed and nothing survived', () => {
  const summary = verificationSummary(event('verified', [{ ...testsOk(5), status: 'partial', reason: 'not checked' }, coverageOk(), mutationOk(0)]), context());
  expect(readTestAnalysis).not.toHaveBeenCalled();
  expect(readMutationSnapshot).not.toHaveBeenCalled();
  expect(summary).toContain('Passed:\ncoverage: PASSED\nmutation: PASSED\n');
});

it('lists a failed mutation run and a failed check by their diagnostics, and a check with no raw output without reading any', () => {
  const failedMutation = { name: 'mutation', status: 'failed', reason: 'mutation check broke', evidence: [], summary: { diagnostics: 'Stryker exploded' } };
  const failedCheck = { name: 'lint', status: 'failed', reason: 'Check failed.', evidence: [analysis('lint')], summary: { diagnostics: 'a.ts:1 bad' } };
  const summary = verificationSummary(event('verify_failed', [failedCheck, failedMutation]), context());
  expect(summary).toContain('lint: FAILED\nCheck failed.\na.ts:1 bad\n\nmutation: FAILED\nmutation check broke\nStryker exploded\n');
  expect(checkText).not.toHaveBeenCalled();
});

it('reads a check\'s output whenever it has a raw artifact, and says why when that output cannot be read', () => {
  checkText.mockReturnValue('  indented line   \nplain');
  const both = ok('lint', 'findings', { evidence: [raw('lint'), analysis('lint')], reason: 'findings (exit 1)' });
  expect(verificationSummary(event('verified', [both]), context())).toContain('lint: FINDINGS\nfindings (exit 1)\n  indented line\nplain\n');
  checkText.mockImplementation(() => { throw Error('the snapshot is gone'); });
  const failed = { name: 'lint', status: 'failed', reason: 'Check failed.', evidence: [raw('lint')], summary: {} };
  expect(verificationSummary(event('verify_failed', [failed], { tail: 'from the tail' }), context()))
    .toContain('lint: FAILED\nCheck failed.\nThe output cannot be listed: the snapshot is gone\n');
});

it('shows the raw check output alongside a separate schema diagnostic on a failed receipt', () => {
  checkText.mockReturnValue('First line of output.\nLast line of output.');
  const diagnostics = 'audit.json: check analysis.version is missing';
  const failed = { name: 'audit', status: 'failed', reason: 'Invalid evidence.', evidence: [raw('audit')], summary: { diagnostics } };
  const summary = verificationSummary(event('verify_failed', [failed]), context());
  expect(summary).toContain('First line of output.\nLast line of output.\n' + diagnostics);
  expect(summary.split(diagnostics)).toHaveLength(2);
});

it('lists a check with findings but no output with no items, never the tail', () => {
  const summary = verificationSummary(event('verified', [ok('lint', 'findings', { reason: 'findings (exit 1)' })], { tail: 'from the tail' }), context());
  expect(summary).toContain('lint: FINDINGS\nfindings (exit 1)\n\n');
  expect(summary).not.toContain('from the tail');
  checkText.mockReturnValue(Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n'));
  expect(verificationSummary(event('verified', [ok('lint', 'findings', { evidence: [raw('lint')] })]), context()))
    .toContain('[…] Output trimmed. All 6 lines are in the details file.');
});

it('lists a tail of exactly five lines whole, and trims the lines of a failure with no checks', () => {
  const failed = { name: 'state:verify', status: 'failed', reason: 'Check failed.', evidence: [], summary: {} };
  const five = ['one', 'two', 'three', 'four', 'five'].join('\n');
  expect(verificationSummary(event('verify_failed', [failed], { tail: five }), context()))
    .toContain('state:verify: FAILED\nCheck failed.\none\ntwo\nthree\nfour\nfive\n\n');
  const none = verificationSummary({ seq: 2, event: 'verify_failed', payload: { treeFingerprint: 't', results: [], tail: Array.from({ length: 7 }, (_, i) => `l${i}`).join('\n') } }, context());
  expect(none).toContain('l4\n[…] Output trimmed. All 7 lines are in the details file.');
  const diagnosed = { name: 'tests', status: 'failed', reason: 'Check failed.', evidence: [], summary: { diagnostics: Array.from({ length: 6 }, (_, i) => `d${i}`).join('\n') } };
  expect(verificationSummary(event('verify_failed', [diagnosed]), context())).toContain('[…] Output trimmed. All 6 lines are in the details file.');
});

it('lists the tool\'s own lines only after the blank line that ends the referee\'s reading, and trims many', () => {
  const nothing = { ...mutationOk(0), status: 'partial', reason: 'Mutation measurement is incomplete.',
    summary: { totalMutants: 0, killed: 0, survived: 0, unproved: 0, ignored: 0, errored: 0 } };
  const said = report => {
    readMutationSnapshot.mockReturnValue({ outcome: 'nothing', findings: { survivors: [] }, report });
    return verificationSummary(event('verified', [nothing]), context());
  };
  expect(said('Mutation testing on the lines this change added or changed:\n  No blank line here.'))
    .toContain('The run proves nothing this time. The tool said:\n\n');
  expect(said('\n  The tool, first.')).toContain('The tool said:\nThe tool, first.\n');
  expect(said(`Heading\n\n${Array.from({ length: 7 }, (_, i) => `  t${i}`).join('\n')}`))
    .toContain('t4\n[…] Output trimmed. All 7 lines are in the details file.');
});

it('trims many diagnostic lines of a failed coverage or mutation result', () => {
  const diagnostics = Array.from({ length: 6 }, (_, i) => `d${i}`).join('\n');
  const coverage = { name: 'coverage', status: 'failed', reason: 'failed', evidence: [], summary: { diagnostics } };
  const mutation = { name: 'mutation', status: 'failed', reason: 'broke', evidence: [], summary: { diagnostics } };
  const summary = verificationSummary(event('verify_failed', [coverage, mutation]), context());
  expect(summary).toContain('coverage: FAILED\nfailed\nd0\nd1\nd2\nd3\nd4\n[…] Output trimmed. All 6 lines are in the details file.\n');
  expect(summary).toContain('mutation: FAILED\nbroke\nd0\nd1\nd2\nd3\nd4\n[…] Output trimmed. All 6 lines are in the details file.\n');
});

it('looks up a producer only for a reused result, and only with a live logbook', () => {
  const reused = { ...ok('audit', 'findings', { reason: 'Runs once per approved plan.' }), status: 'reused', source: { seq: 4, fingerprint: 'f'.repeat(64) } };
  verificationSummary(event('verified', [ok('lint', 'findings', { reason: 'findings (exit 1)' })]), context({ live: [] }));
  expect(verificationSummary(event('verified', [reused]), context())).toContain(reused.reason);
  expect(producerEvent).not.toHaveBeenCalled();
});
