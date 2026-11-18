/** Valid measurements for reader tests. Assertions about the producer's
 * arithmetic use literal expected summaries, not these fixture builders. */
import { writeTestAnalysis } from '../../../src/workflow/junit-snapshot.mjs';

export const testCase = (over = {}) => ({ file: 'suite.test.mjs', name: 'example', status: 'passed', message: null,
  ids: [], scenarios: [], bare: [], inverted: false, ...over });
export const testRun = (over = {}) => ({ cases: [], leftOut: [], exit: 0, ...over });

export function testResult(branch, reports, root, run = testRun()) {
  return { name: 'tests', status: 'ok', reason: 'Fixture test measurement.',
    evidence: [...reports.map(({ name, snapshot }) => ({ role: 'raw', title: `JUnit: ${name}`, snapshot })),
      { role: 'analysis', title: 'Test run', snapshot: writeTestAnalysis(branch, reports, run, root) }],
    summary: { total: run.cases.length, passed: run.cases.filter(c => c.status === 'passed').length,
      failed: run.cases.filter(c => c.status === 'failed').length, skipped: run.cases.filter(c => c.status === 'skipped').length,
      inverted: run.cases.filter(c => c.inverted).length, omittedFiles: run.leftOut.length } };
}

export const coverageSummary = c => ({ folders: c.folders.map(({ folder, lines, branches }) => ({ folder,
  lines: { percent: lines.measured / 10, target: lines.minimum / 10 },
  branches: { percent: branches.measured / 10, target: branches.minimum / 10 } })) });

export const mutationSummary = ({ counts: c }) => ({ totalMutants: c.total, killed: c.caught, survived: c.survived,
  unproved: c.unproven + c.statuses.NoCoverage + c.statuses.Pending,
  ignored: c.statuses.Ignored, errored: c.statuses.CompileError + c.statuses.RuntimeError });
