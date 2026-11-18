import { describe, expect, it } from 'vitest';
import { NOTHING_NEW, readReport, recordContext, recordDecision, repeatedRecordContext, reportSection, SHOW, WRITE_COMMIT_MESSAGE } from './record.mjs';

const report = (gaps, incomplete = []) => ({ lines: ['Change report', '  risk LOW'], summary: ['risk LOW'], gaps, incomplete });

describe('what record decides', () => {
  it('declares when the report finds no gaps', () => {
    expect(recordDecision({ report: report({ uncoveredLines: 0, uncaughtMutants: 0 }), held: false, acted: false })).toBe('declare');
    expect(recordDecision({ report: report({}), held: false, acted: false })).toBe('declare');
  });

  it('holds gaps nobody acted on, and declares them once the agent acted', () => {
    for (const gaps of [{ uncoveredLines: 2, uncaughtMutants: 0 }, { uncoveredLines: 0, uncaughtMutants: 1 }, { uncaughtMutants: 1 }]) {
      expect(recordDecision({ report: report(gaps), held: false, acted: false })).toBe('hold');
      expect(recordDecision({ report: report(gaps), held: false, acted: true })).toBe('declare');
    }
  });

  it.each([true, false])('stops for absent and incomplete reports even after a hold (held=%s)', held => {
    for (const acted of [true, false]) {
      expect(recordDecision({ report: null, held, acted })).toBe('stop');
      expect(recordDecision({ report: report({ uncoveredLines: 0, uncaughtMutants: 0 }, ['coverage']), held, acted })).toBe('stop');
    }
  });

  it('declares measured gaps on a second record with complete evidence', () => {
    expect(recordDecision({ report: report({ uncoveredLines: 3, uncaughtMutants: 1 }), held: true, acted: false })).toBe('declare');
  });
});

describe('reading the report command', () => {
  it('takes the reasons the report gives for unreadable sections', () => {
    const answer = { ...report({ uncoveredLines: 0, uncaughtMutants: 0 }, ['coverage']), problems: ['coverage: missing'] };
    expect(readReport({ status: 0, stdout: JSON.stringify(answer) })).toEqual({ report: answer });
  });

  it('takes its JSON answer', () => {
    const answer = report({ uncoveredLines: 1, uncaughtMutants: 0 });
    expect(readReport({ status: 0, stdout: `${JSON.stringify(answer)}\n` })).toEqual({ report: answer });
  });

  it('gives the reason when there is no answer to take', () => {
    expect(readReport({ status: null, error: new Error('spawnSync ETIMEDOUT') })).toEqual({ failed: 'spawnSync ETIMEDOUT' });
    expect(readReport({ status: 1, stderr: 'one\ntwo\nreport: refused — no target\n' })).toEqual({ failed: 'one\ntwo\nreport: refused — no target' });
    expect(readReport({ status: 1, stderr: '' })).toEqual({ failed: 'it exited with 1' });
    expect(readReport({ status: 0, stdout: 'Change report' })).toEqual({ failed: 'it printed something that is not JSON' });
  });

  it.each([
    ['summary', undefined], ['summary', null], ['summary', []], ['summary', [' ', '\t']], ['summary', [1]],
    ['lines', [null]], ['lines', [' ']], ['incomplete', [42]], ['problems', [' ']], ['problems', 'coverage: missing'],
    ['gaps', null], ['gaps', []], ['gaps', undefined], ['gaps', { uncovered: 0, survived: false }],
    ...['uncoveredLines', 'uncaughtMutants'].flatMap(key => [null, false, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(value => ['gaps', { [key]: value }])),
  ])('treats a report with invalid %s (%j) as unavailable', (field, value) => {
    const answer = { ...report({ uncoveredLines: 0, uncaughtMutants: 0 }), [field]: value };
    const built = readReport({ status: 0, stdout: JSON.stringify(answer) });
    expect(built).toEqual({ failed: expect.stringContaining('report.' + field) });
  });
});

describe('what the agent is told on record', () => {
  const link = 'log/0005__declared.json';
  const reportFile = '.katatay/local/topic/change-report/x.json';

  it('shows the change summary first and says the change is declared', () => {
    const text = recordContext({ decision: 'declare', built: { report: report({ uncoveredLines: 0, uncaughtMutants: 0 }) }, held: false, link, reportFile });
    expect(text).toBe([SHOW, '', 'Change declared. The report found no gaps.', '', 'risk LOW', '', `Details: ${link}`, '',
      'The operator declared this change finished. Write the change file now. It opens with this section, straight after the title '
        + 'and before `## Why`, exactly as it stands here. The record step checks it against what was declared. Keep the section out of the chat reply:',
      '', '## Report', '', '```text', 'risk LOW', '```'].join('\n'));
  });

  it('shows the gaps that held a change, linked to the hold, and asks for nothing else', () => {
    const held = recordContext({ decision: 'hold', built: { report: report({ uncoveredLines: 1, uncaughtMutants: 1 }) }, held: false,
      link: 'log/0005__record_held.json', reportFile });
    expect(held).toBe([SHOW, '', 'Change held: 1 touched line no test runs, and 1 mutant no test caught.',
      'No test changed since the verification before. Type `record` again to declare it as it stands.', '', 'risk LOW', '',
      'Details: log/0005__record_held.json'].join('\n'));
  });

  it('says tests changed when a declaration follows the agent acting on gaps, and asks for no reasons', () => {
    const text = recordContext({ decision: 'declare', built: { report: report({ uncoveredLines: 2, uncaughtMutants: 0 }) }, held: false, acted: true, link, reportFile });
    expect(text).toContain('Change declared. Tests changed since the verification before, so the gaps do not hold it.');
    expect(text).not.toContain('your explanations');
    expect(text).toMatch(/\n\n## Report\n\n```text\nrisk LOW\n```$/);
  });

  it('lists each unreadable section with its reason, and declares nothing', () => {
    const incomplete = { ...report({ uncoveredLines: 0, uncaughtMutants: 0 }, ['coverage']), problems: ['coverage: analysis file is missing.'] };
    const hole = recordContext({ decision: 'stop', built: { report: incomplete }, held: false, acted: true });
    expect(hole).toBe([SHOW, '', 'Change not declared: 1 section of the change report could not be read.', '', 'risk LOW', '',
      'Could not be read:', '- coverage: analysis file is missing.', '', 'No logbook event was recorded.', '',
      'The change was not declared. Resolve the missing or invalid evidence before recording.'].join('\n'));
  });

  it('says a report that could not be built, line by line', () => {
    expect(recordContext({ decision: 'stop', built: { failed: 'it exited with 1' }, held: false })).toBe([SHOW, '',
      'Change not declared. The change report could not be built: it exited with 1', '', 'No logbook event was recorded.', '',
      'The change was not declared. Resolve the missing or invalid evidence before recording.'].join('\n'));
  });

  it('says the report could not be built, and asks for no reasons', () => {
    const text = recordContext({ decision: 'stop', built: { failed: 'it exited with 1' }, held: false });
    expect(text).toContain('The change report could not be built: it exited with 1');
    expect(text).toContain('Resolve the missing or invalid evidence');
    expect(text).not.toContain('your explanations');
  });

  it('shows the declaration without requesting another explanation when analysis is saved', () => {
    const text = recordContext({ decision: 'declare', built: { report: report({ uncoveredLines: 1, uncaughtMutants: 1 }) },
      held: true, savedAnalysis: 'Accepted analysis' });
    expect(text).toContain('The operator declared this change finished');
    expect(text).not.toContain('your explanations');
  });

  it('says a second record accepts the gaps, and asks for reasons from the full report', () => {
    const text = recordContext({ decision: 'declare', built: { report: report({ uncoveredLines: 1, uncaughtMutants: 0 }) }, held: true, acted: true, link, reportFile });
    expect(text).toContain('Change declared. You typed `record` again on the same tree, so you accept the gaps it shows.');
    expect(text).toContain(`your explanations and not measurements, say for each touched line no test runs why no test can, `
      + `and for each surviving mutant why it survived. For unproved mutants, explain the counts by status: reached by no test, pending, or no completed tests. Use the measured counts in the full report at ${reportFile}.\n\n`
      + 'The operator declared this change finished.');
    expect(text).toContain('straight after the title and before `## Why`');
  });

  it('repeats what a second record does after the accepted analysis on a hold', () => {
    const held = recordContext({ decision: 'hold', built: { report: report({ uncoveredLines: 1, uncaughtMutants: 0 }) }, held: false,
      savedAnalysis: 'Accepted analysis', link, reportFile });
    expect(held).toMatch(/\n\nAccepted analysis\n\nTell the operator to type `record` again to declare the change as it stands\.$/);
  });
});

describe('the report section of a change file', () => {
  it('holds the summary lines in a text block, under its heading', () => {
    expect(reportSection(['risk LOW · 0 high-risk files', 'tests: 1 added, 0 modified, 0 removed']))
      .toBe('## Report\n\n```text\nrisk LOW · 0 high-risk files\ntests: 1 added, 0 modified, 0 removed\n```');
  });
});

describe('a record repeated on a declared or recorded tree', () => {
  const declared = { summary: ['risk LOW'], link: '.katatay/state/topic/0005__declared.json' };
  const opening = [SHOW, '', 'Change declared on this tree. This is the report recorded with that decision.', '', 'risk LOW', '',
    `Details: ${declared.link}`, '', NOTHING_NEW, ''].join('\n');

  it('repeats the summary and the change-file instruction with its report section before the change file is written', () => {
    const text = repeatedRecordContext({ phase: 'declared', ...declared, changeFiles: [] });
    expect(text.startsWith(opening)).toBe(true);
    expect(text).toContain('Write the change file now.');
    expect(text.endsWith(`\n\n${reportSection(['risk LOW'])}`)).toBe(true);
  });

  it('says the next turn end records the change once the change file is written', () => {
    expect(repeatedRecordContext({ phase: 'declared', ...declared, changeFiles: ['x.md'] }))
      .toBe(`${opening}\nThe change file is written (x.md). The next turn end checks it and records the change.`);
  });

  it('asks for the commit message once the change is recorded', () => {
    expect(repeatedRecordContext({ phase: 'recorded', ...declared, changeFiles: ['x.md', 'y.md'] }))
      .toBe(`${opening}\nThe change is recorded by x.md, y.md, and every file is staged. ${WRITE_COMMIT_MESSAGE}`);
  });
});
