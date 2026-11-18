import { describe, expect, it } from 'vitest';
import type { Requirement } from '../requirements/parse.js';
import type { TaggedTest } from './tags.js';
import { findingsOf } from './mutation-report.mjs';
import { mutant, reportOf } from '../../tests/fixtures/workflow/mutation-report.mjs';
import {
  changeCoverage, coverageShare, evidenceOf, followUpsOf, gapsOf, leadsOf, mutationRunOf, renderReport,
  requirementsReport, sizeOf, summaryLines, surprisesOf, type ReportData, mutationHeadline,
  problemsOf,
} from './report.js';

/** A requirement as the parser gives one. The checksum only has to differ when
 *  the text does, so the text stands in for it. */
const req = (id: string, status: Requirement['status'], statement: string, scenarios: [string, string][] = []): Requirement => ({
  id, type: 'acceptance', slug: id.toLowerCase(), path: `requirements/acceptance/${id}.md`, status, statement, checksum: statement,
  scenarios: scenarios.map(([sid, text]) => ({ id: sid, text, checksum: text })), malformedScenarios: [],
});

const tagged = (file: string, ids: string[], notEvidence: TaggedTest['notEvidence'] = null): TaggedTest => ({
  file, title: ids.map((i) => `[${i}]`).join(' '), ids: [...new Set(ids.map((i) => i.split('.')[0]!))],
  scenarios: ids.filter((i) => i.includes('.')), bare: ids.filter((i) => !i.includes('.')), notEvidence,
});

const data = (over: Partial<ReportData> = {}): ReportData => ({ notChecked: [], incomplete: [], ...over });

/** A triage's buckets with `surprise` surprises and `over` over-predictions. */
const triaged = ({ level, surprise = 0, over = 0 }: { level: string; surprise?: number; over?: number }) => ({
  level, notRun: { predicted: [], unpredicted: [] },
  predicted: { failed: 2, total: 2, failures: [] },
  surprise: { failed: surprise, total: 50, failures: [] },
  overPredicted: { count: over, total: 2, tests: [] },
});

describe('the size of a change', () => {
  it('counts code lines added and deleted, and test files added, modified and removed', () => {
    const size = sizeOf(
      ['M\tmodules/a.ts', 'A\tmodules/a.test.ts', 'M\tmodules/b.test.ts', 'D\tmodules/c.test.ts', 'M\tREADME.md'],
      ['10\t2\tmodules/a.ts', '30\t0\tmodules/a.test.ts', '5\t5\tREADME.md', '-\t-\tlogo.png'],
      { 'modules/new.ts': 7, 'modules/new.test.ts': 12, 'notes.md': 3 },
    );
    expect(size).toEqual({ code: { added: 17, deleted: 2 }, tests: { added: 2, modified: 1, removed: 1 } });
  });
});

describe('the surprises at triage', () => {
  it('reads the buckets from the triage event', () => {
    const s = surprisesOf({ payload: {
      level: 'HIGH',
      notRun: { predicted: [], unpredicted: [] },
      predicted: { failed: 3, total: 4 },
      surprise: { failed: 2, total: 50, failures: ['x', 'y'] },
      overPredicted: { count: 1, total: 4, tests: ['o'] },
    } });
    expect(s).toEqual({
      level: 'HIGH',
      predicted: { failed: 3, total: 4 },
      surprise: { failed: 2, total: 50, failures: ['x', 'y'] },
      overPredicted: { count: 1, total: 4, tests: ['o'] },
      notRun: { predicted: [], unpredicted: [] },
    });
    const lines = renderReport(data({ surprises: s }));
    expect(lines).toEqual(expect.arrayContaining([
      "  I assessed the plan's missed predictions and test regressions.",
      '  risk: HIGH',
      '  surprises — the plan did not predict these:', '    x', '    y',
      '  over-predicted — the plan said these would fail, and they passed:', '    o',
      '  54 tests ran, 5 failed · predicted 3/4 failed · 2 surprises (50%) · 1 over-prediction (25%)',
    ]));
    // The plan named its predicted failures already.
    expect(lines).not.toContain('    p');
  });

  it('is nothing without a triage, and says so', () => {
    expect(surprisesOf(null)).toBeNull();
    expect(renderReport(data({ surprises: null }))).toContain('  No triage was recorded for this plan.');
  });

  it('names the files that never ran, once each', () => {
    const s = surprisesOf({ payload: { ...triaged({ level: 'HIGH' }), notRun: { predicted: ['p.test.ts'], unpredicted: ['u.test.ts'] } } });
    expect(renderReport(data({ surprises: s }))).toEqual(expect.arrayContaining([
      '  never ran, and the plan did not predict it — nothing in these was classified:', '    u.test.ts',
      '  predicted, and never ran:', '    p.test.ts',
    ]));
  });
});

describe('how a scenario is tested', () => {
  it('counts eligible acceptance tests at either speed', () => {
    const proof = (file: string) => tagged(file, ['AC0001.1']);
    expect(evidenceOf([])).toBe('untested');
    for (const file of ['a.test.ts', 'a.integration.test.ts', 'a.e2e.test.ts']) {
      expect(evidenceOf([proof(file)])).toBe('untested');
    }
    for (const file of ['a.acceptance.test.ts', 'tests/e2e/a.acceptance.test.ts']) {
      expect(evidenceOf([proof(file)])).toBe('solid');
    }
  });

  it('leaves a scenario untested when all its acceptance cases are skipped or inverted', () => {
    expect(evidenceOf([
      tagged('a.acceptance.test.ts', ['AC0001.1'], 'skipped'),
      tagged('b.acceptance.test.ts', ['AC0001.1'], 'inverted'),
    ])).toBe('untested');
  });
});

describe('the requirements a change touched', () => {
  const before = [
    req('AC0001', 'active', 'One.', [['AC0001.1', 'first'], ['AC0001.2', 'second']]),
    req('AC0002', 'active', 'Two.', [['AC0002.1', 'only']]),
    req('AC0003', 'active', 'Three.'),
    req('AC0004', 'active', 'Untouched.', [['AC0004.1', 'same']]),
  ];
  const after = [
    req('AC0001', 'active', 'One, reworded.', [['AC0001.1', 'first, reworded'], ['AC0001.3', 'third']]),
    req('AC0002', 'withdrawn', 'Two.', [['AC0002.1', 'only']]),
    req('AC0003', 'active', 'Three, reworded.'),
    req('AC0004', 'active', 'Untouched.', [['AC0004.1', 'same']]),
    req('AC0005', 'accepted', 'New.', [['AC0005.1', 'new one']]),
  ];
  const tests = [
    tagged('tests/acceptance/one.test.ts', ['AC0001.1']),
    tagged('modules/one.test.ts', ['AC0001.3']),
    tagged('tests/acceptance/skipped.test.ts', ['AC0001.3'], 'skipped'),
    tagged('tests/e2e/three.test.ts', ['AC0003']),
  ];
  const report = requirementsReport(before, after, tests);

  it('names each changed requirement and what happened to it, and leaves the rest out', () => {
    expect(report.changed).toEqual([
      { id: 'AC0001', kinds: ['reworded', 'scenarios changed'] },
      { id: 'AC0002', kinds: ['active → withdrawn'] },
      { id: 'AC0003', kinds: ['reworded'] },
      { id: 'AC0005', kinds: ['added'] },
    ]);
  });

  it('counts scenarios added, reworded and retired, a withdrawn requirement retiring its own', () => {
    expect(report.scenarios).toEqual({ added: 2, reworded: 2, retired: 2 });
  });

  it('grades the evidence of every scenario of a changed requirement still standing, counting only tests that run', () => {
    expect(report.evidence).toEqual([
      { id: 'AC0001.1', evidence: 'solid' },
      { id: 'AC0001.3', evidence: 'untested' },
      { id: 'AC0003', evidence: 'untested' },
      { id: 'AC0005.1', evidence: 'untested' },
    ]);
  });

  it('lists the thin ones under the requirements, and counts them in the summary', () => {
    const text = renderReport(data({ requirements: report })).join('\n');
    expect(text).toContain('Of their 4 scenarios, 1 has acceptance evidence.');
    expect(text).toContain('- AC0001.3: no acceptance evidence');
    expect(text).toContain('- AC0003: no acceptance evidence');
    expect(text).toContain('- AC0005.1: no acceptance evidence');
    expect(summaryLines(data({ requirements: report }))).toContain('AC scenarios: 2 added, 2 reworded, 2 retired (3 without acceptance evidence)');
  });

  it('reports both evidenced scenarios without adding a gap to the summary', () => {
    const requirement = req('AC0001', 'active', 'One.', [['AC0001.1', 'first'], ['AC0001.2', 'second']]);
    const tests = requirement.scenarios.map(({ id }) => tagged('one.acceptance.test.ts', [id]));
    const report = data({ requirements: requirementsReport([], [requirement], tests) });
    expect(renderReport(report)).toContain('  Of their 2 scenarios, 2 have acceptance evidence.');
    expect(summaryLines(report)).toContain('AC scenarios: 2 added, 0 reworded, 0 retired');
  });

  it('says so when nothing changed', () => {
    const none = requirementsReport(before, before, []);
    expect(none.changed).toEqual([]);
    expect(renderReport(data({ requirements: none }))).toContain('  This change adds or alters no requirement.');
  });
});

describe('coverage of the change', () => {
  const answer = { files: [
    { file: 'modules/a.ts', uncoveredLines: [3, 9], coveredLines: [1, 2, 4, 20] },
    { file: 'modules/b.ts', uncoveredLines: [1], coveredLines: [] },
  ] };

  it('counts the touched lines that run and those that do not, inside the touched ranges', () => {
    const c = changeCoverage(answer, [{ file: 'modules/a.ts', lines: [2, 9] }, { file: 'modules/b.ts' }, { file: 'modules/gone.ts' }]);
    expect(c).toEqual({ covered: 2, uncovered: [{ file: 'modules/a.ts', lines: [3, 9] }, { file: 'modules/b.ts', lines: [1] }] });
    expect(coverageShare(c)).toBe('40% (2 of 5 lines)');
    expect(gapsOf(data({ coverage: c }))).toEqual({ uncoveredLines: 3 });
  });

  it('gives no share when the adapter does not say which lines ran', () => {
    const c = changeCoverage({ files: [{ file: 'modules/a.ts', uncoveredLines: [3] }] }, [{ file: 'modules/a.ts' }]);
    expect(c.covered).toBeNull();
    expect(coverageShare(c)).toBe('1 line uncovered');
  });

  it('rounds the share down, and says when nothing touched can run', () => {
    expect(coverageShare({ covered: 199, uncovered: [{ file: 'a', lines: [1] }] })).toBe('99% (199 of 200 lines)');
    expect(coverageShare({ covered: 0, uncovered: [] })).toBe('no lines that run');
  });

  it('lists the uncovered lines as ranges, and says when coverage was off', () => {
    const text = renderReport(data({ coverage: { covered: 1, uncovered: [{ file: 'modules/a.ts', lines: [3, 4, 5, 9] }] } }));
    expect(text).toContain('  - modules/a.ts: 4 lines no test runs (3-5, 9)');
    expect(renderReport(data({ coverage: null }))).toContain('  Coverage: not checked.');
  });
});

describe('the mutation run', () => {
  it('uses stored findings for counts and keeps the outcome for inconclusive runs', () => {
    const killed = ['1', '2', '3'].map(id => mutant('Killed', { id }));
    const findings = findingsOf(reportOf([...killed, mutant('Survived', { id: '4' })]));
    const run = mutationRunOf({ report: ' \ntext\n ', outcome: 'survived', findings, treeFingerprint: 'old' }, 'new')!;
    expect(run.report.split('\n')[0]).toBe('text');
    const earlierReport = renderReport(data({ mutation: run }));
    expect(earlierReport.join('\n')).toContain('ran once, on an earlier tree');
    expect(earlierReport).toContain('  text');
    expect(earlierReport.join('\n')).not.toContain('Unproved mutants:');
    expect(run.findings).toEqual(findings);
    expect(mutationHeadline(run)).toBe('mutants: 3 caught, 1 survived (earlier tree)');
    expect(mutationHeadline({ ...run, outcome: 'nothing' })).toBe('mutants: 3 caught, 1 survived (inconclusive run) (earlier tree)');
    const clean = mutationRunOf({ report: 'text', outcome: 'clean', treeFingerprint: 'same', findings: findingsOf(reportOf(killed)) }, 'same')!;
    expect(renderReport(data({ mutation: clean }))).toContain('  Mutation testing ran once, on this tree.');
    expect(mutationHeadline(clean)).toBe("mutants: 3 caught, 0 survived (by the tool's account)");
  });

  it.each([
    ['clean', 'Killed', 1, 0],
    ['survived', 'Survived', 1, 1],
    ['nothing', 'Survived', 1, 1],
    ['nothing', 'Survived', 0, 1],
    ['nothing', 'NoCoverage', 0, 1],
    ['nothing', 'Pending', 0, 1],
    ['clean', 'Timeout', 1, 0],
    ['nothing', 'RuntimeError', 0, 0],
    ['nothing', 'CompileError', 0, 0],
    ['clean', 'Ignored', 0, 0],
  ] as const)('counts uncaught mutants for %s with status %s and %i completed tests: %i', (outcome, status, testsCompleted, expected) => {
    const findings = findingsOf(reportOf([mutant(status, { testsCompleted })]));
    const mutation = mutationRunOf({ treeFingerprint: 't', report: 'r', outcome, findings }, 't');
    expect(gapsOf(data({ mutation }))).toEqual({ uncaughtMutants: expected });
  });

  it('counts confirmed and unproved mutants together and reports why the latter are unproved', () => {
    const statuses = ['Killed', 'Timeout', 'RuntimeError', 'CompileError', 'Ignored', 'Survived',
      'Pending', 'Pending', 'NoCoverage', 'NoCoverage', 'NoCoverage'];
    const mutants = statuses.map((status, i) => mutant(status, { id: String(i) }));
    mutants.push(mutant('Survived', { id: 'unfinished', testsCompleted: 0 }));
    const findings = findingsOf(reportOf(mutants));
    const mutation = mutationRunOf({ treeFingerprint: 'old', outcome: 'nothing', report: 'partial run', findings }, 'new');
    const report = data({ coverage: { covered: 0, uncovered: [] }, mutation });
    expect(gapsOf(report)).toEqual({ uncoveredLines: 0, uncaughtMutants: 7 });
    expect(summaryLines(report).join('\n')).toContain('2 caught, 1 survived, 6 unproved (inconclusive run) (earlier tree)');
    expect(renderReport(report)).toContain('  Unproved mutants: 3 reached by no test, 2 pending, 1 with no completed tests.');
  });

  it('is nothing when the plan has no run', () => {
    expect(mutationRunOf(null, 't')).toBeNull();
    expect(gapsOf(data({ coverage: null, mutation: null }))).toEqual({});
    expect(renderReport(data({ mutation: null }))).toContain('  Mutation testing: no run for this plan.');
  });
});

describe('the follow-ups', () => {
  it('reads each item by its bold lead', () => {
    expect(leadsOf('# F\n\n- **Do a thing.** Because.\n  - **not top level**\n- **Another**\n')).toEqual(['Do a thing.', 'Another']);
  });

  // FOLLOW-UPS.md wraps at 80 columns, so a long lead runs onto the next line.
  // Read one line at a time, such an item was not seen at all, and removing it
  // went uncounted.
  it('reads a lead that wraps onto the next line, as one line', () => {
    const text = '- **A failed mutation run says nothing useful, and a cut-off run loses its\n  answer.** Found on the change.\n- **Short.** x\n';
    expect(leadsOf(text)).toEqual(['A failed mutation run says nothing useful, and a cut-off run loses its answer.', 'Short.']);
    expect(followUpsOf(text, '- **Short.** x\n').removed).toHaveLength(1);
  });

  it('says what was added and removed', () => {
    const f = followUpsOf('- **Old.** x\n- **Kept.** y\n', '- **Kept.** y\n- **New.** z\n');
    expect(f).toEqual({ added: ['New.'], removed: ['Old.'] });
    expect(renderReport(data({ followUps: f }))).toEqual(expect.arrayContaining(['Follow-ups', '  + New.', '  − Old.']));
  });
});

describe('the summary', () => {
  it('opens the report with a line per group, counts only', () => {
    const d = data({
      size: { code: { added: 412, deleted: 87 }, tests: { added: 2, modified: 5, removed: 0 } },
      tests: { added: 3, modified: 11, removed: 1 },
      areas: { must: [{ text: 'why', items: ['tools/a.mjs', 'tools/b.mjs'] }, { text: 'other', items: ['tools/a.mjs'] }] },
      surprises: triaged({ level: 'HIGH', surprise: 3, over: 1 }),
      followUps: { added: ['a', 'b'], removed: ['c'] },
    });
    expect(summaryLines(d)).toEqual([
      'prediction: 3 surprises, 1 over-prediction · protected files: 2 · risk: HIGH',
      'tests: 3 added, 11 modified, 1 removed',
      'follow-ups +2 −1 · code +412 −87 lines',
    ]);
    expect(renderReport(d).slice(0, 5)).toEqual(['Change report', '', '  prediction: 3 surprises, 1 over-prediction · protected files: 2 · risk: HIGH', '  tests: 3 added, 11 modified, 1 removed', '  follow-ups +2 −1 · code +412 −87 lines']);
  });

  it('adds a last line only for what was not checked, warnings, test-only drift or a hole', () => {
    const d = data({
      mutation: null, notChecked: ['skipped in CI (skipInCi: true)'], warnings: ['a hook'], drift: ['modules/a.ts'],
      incomplete: [{ section: 'coverage', reason: 'no report' }],
    });
    expect(summaryLines(d).at(-1)).toBe('not checked: mutation · 1 setup warning · test-only plan touched 1 code file · 1 section could not be read');
    const text = renderReport(d).join('\n');
    expect(text).toContain('Not checked\n  - skipped in CI (skipInCi: true)');
    expect(text).toContain('Setup warnings\n  - a hook');
    expect(text).toContain('Test-only plan, and these are not tests\n  - modules/a.ts');
    expect(text).toContain('Could not be read\n  - coverage: no report');
    expect(summaryLines(data()).at(-1)).toBe('prediction: ? · risk: ?');
  });

  it('names each check that was not checked, by its section, whatever its reason says', () => {
    const both = data({
      coverage: null, mutation: null,
      notChecked: ['not checked: coverage (checks.testQuality.coverage is "none")', 'not checked: mutation (checks.testQuality.mutation is "none")'],
    });
    expect(summaryLines(both).at(-1)).toBe('not checked: coverage, mutation');
    expect(summaryLines(data({ coverage: null, notChecked: ['not checked: coverage (checks.testQuality.coverage is "none")'] })).at(-1))
      .toBe('not checked: coverage');
    expect(summaryLines(data({ coverage: undefined, mutation: undefined })).join('\n')).not.toContain('not checked');
  });

  // A rerun ran in someone's shell, and its environment can shape a pass.
  it('names a pass that came from a rerun on the last line, and only then', () => {
    expect(summaryLines(data({ rerun: true })).at(-1)).toBe('verified by a rerun');
    expect(summaryLines(data({ rerun: true, warnings: ['a hook'] })).at(-1)).toBe('verified by a rerun · 1 setup warning');
    expect(summaryLines(data()).join('\n')).not.toContain('rerun');
  });

  // How well the plan predicted and which files are protected are two
  // signals. `risk HIGH · 5 high-risk files` read as one verdict.
  it('opens with the prediction, the protected files and the level, apart', () => {
    const first = (over: Partial<ReportData>) => summaryLines(data({ areas: { must: [] }, ...over }))[0];
    expect(first({ surprises: triaged({ level: 'LOW' }) })).toBe('prediction: exact · protected files: 0 · risk: LOW');
    expect(first({ surprises: triaged({ level: 'MEDIUM', over: 2 }) })).toBe('prediction: 2 over-predictions · protected files: 0 · risk: MEDIUM');
    expect(first({ surprises: triaged({ level: 'MEDIUM', surprise: 1 }) })).toBe('prediction: 1 surprise · protected files: 0 · risk: MEDIUM');
    // A failing invariant makes an exact prediction HIGH, and the line shows both.
    expect(first({ surprises: triaged({ level: 'HIGH' }) })).toBe('prediction: exact · protected files: 0 · risk: HIGH');
    expect(first({ surprises: null })).toBe('prediction: not triaged · protected files: 0');
  });

  it('names no file as never ran when every test ran', () => {
    expect(renderReport(data({ surprises: triaged({ level: 'LOW' }) })).join('\n')).not.toContain('never ran');
  });

  it('counts tests when the triage stored its list, and labels test files before triage', () => {
    const size = { code: { added: 0, deleted: 0 }, tests: { added: 1, modified: 2, removed: 0 } };
    expect(summaryLines(data({ size, tests: { added: 4, modified: 9, removed: 1 } }))).toContain('tests: 4 added, 9 modified, 1 removed');
    expect(summaryLines(data({ size }))).toContain('test files: 1 added, 2 modified, 0 removed');
  });

  it('lists the high-risk areas with their reason, or says there are none', () => {
    const text = renderReport(data({ areas: { must: [{ text: 'These do the checking.', items: ['tools/a.mjs'] }] } }));
    expect(text).toEqual(expect.arrayContaining(['High-risk areas changed', '  These do the checking.', '  - tools/a.mjs']));
    expect(renderReport(data({ areas: { must: [] } }))).toEqual(expect.arrayContaining(['High-risk areas changed', '  None.']));
  });
});

describe('problemsOf', () => {
  it('gives each unreadable section with its reason, one line each', () => {
    expect(problemsOf(data({ incomplete: [{ section: 'coverage', reason: 'digest mismatch' }, { section: 'mutation', reason: 'missing' }] })))
      .toEqual(['coverage: digest mismatch', 'mutation: missing']);
    expect(problemsOf(data())).toEqual([]);
  });
});
