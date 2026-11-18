import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checksum } from './checksum.js';
import { runGuard, approvedElsewhereFor, approvedInPlanFor, departuresRecorded, reportRecorded, evaluate, failureReport, loadCatalogueAt, newestRecords, planAccountsFor, recordFidelity, recordedIn, refExists, split, type GuardInput, type RecordedRequirement } from './guard.js';
import type { Requirement, Scenario, Status } from './parse.js';
import { configureTarget, markTarget } from '../../tests/fixtures/workflow/target.mjs';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';
import { append, dirFor } from '../workflow/chain.mjs';
import { approval, triaged, verified } from '../../tests/fixtures/workflow/events.mjs';
import { current } from '../workflow/state.mjs';
import { reportSection } from '../workflow/record.mjs';

function req(id: string, statement: string, status: Status = 'accepted'): Requirement {
  return {
    id,
    type: id.startsWith('AC') ? 'acceptance' : 'invariant',
    slug: 'slug',
    path: `requirements/x/${id}__slug.md`,
    status,
    statement,
    checksum: checksum(statement),
    scenarios: [],
    malformedScenarios: [],
  };
}

function run(overrides: Partial<GuardInput>): ReturnType<typeof evaluate> {
  return evaluate({
    main: [],
    branch: [],
    accountedFor: new Set(),
    ...overrides,
  });
}

const ORIGINAL = 'AI output cannot mutate canonical data.';
const REWORDED = 'AI output usually cannot mutate canonical data.';
const CI = { CI: 'true' };

describe('guard', () => {
  it('needs approval and accounting to add a new requirement', () => {
    expect(run({ main: [], branch: [req('AC0001', ORIGINAL)] })).toEqual([
      { id: 'AC0001', severity: 'needs-approval', message: 'added as a new requirement' },
      { id: 'AC0001', severity: 'forbidden', message: 'added but no change file on this branch accounts for it' },
    ]);
  });

  it('treats a missing main as the baseline and permits everything', () => {
    expect(run({ main: null, branch: [req('AC0001', ORIGINAL)] })).toEqual([]);
  });

  it('forbids deletion outright, and fails on it in CI too', () => {
    const violations = run({ main: [req('AC0001', ORIGINAL)], branch: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'AC0001', severity: 'forbidden' });
    expect(violations[0]!.message).toContain('never deleted');
    expect(split(violations, CI)).toEqual({ failing: violations, forReview: [] });
  });

  it('permits renaming the slug, since identity is the id', () => {
    const before = req('AC0001', ORIGINAL);
    const after = { ...before, slug: 'a_much_better_slug', path: 'requirements/x/AC0001__a_much_better_slug.md' };
    expect(run({ main: [before], branch: [after] })).toEqual([]);
  });

  it('requires approval to renumber an id that exists on main', () => {
    const violations = run({
      main: [req('AC0001', ORIGINAL)],
      branch: [req('AC0009', ORIGINAL)],
      accountedFor: new Set(['AC0009']),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'AC0001', severity: 'needs-approval' });
    expect(violations[0]!.message).toContain('AC0001 → AC0009');
  });

  it('treats an id born on this branch and renumbered as new under its new id', () => {
    // AC0009 never reached main, so moving it to AC0010 changes nothing agreed.
    // AC0010 is still new, and an approval of it under its new id covers it.
    expect(run({
      main: [],
      branch: [req('AC0010', ORIGINAL)],
      accountedFor: new Set(['AC0010']),
      approvedInPlan: [{ id: 'AC0010', status: 'accepted', statement: ORIGINAL }],
    })).toEqual([]);
  });

  it('requires approval to reword an active requirement', () => {
    const violations = run({
      main: [req('INV0001', ORIGINAL, 'active')],
      branch: [req('INV0001', REWORDED, 'active')],
      accountedFor: new Set(['INV0001']),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'INV0001', severity: 'needs-approval' });
  });

  it('hands an accounted-for rewording of an active requirement to the reviewer in CI', () => {
    const violations = run({
      main: [req('INV0001', ORIGINAL, 'active')],
      branch: [req('INV0001', REWORDED, 'active')],
      accountedFor: new Set(['INV0001']),
    });
    expect(split(violations, CI)).toEqual({ failing: [], forReview: violations });
  });

  it('fails an unapproved rewording outside CI', () => {
    const violations = run({
      main: [req('INV0001', ORIGINAL, 'active')],
      branch: [req('INV0001', REWORDED, 'active')],
      accountedFor: new Set(['INV0001']),
    });
    expect(split(violations, {})).toEqual({ failing: violations, forReview: [] });
  });

  // Only `CI=true` is CI. Every other value is local, where the guard fails
  // on what CI would only hand to a reviewer, and reads the plan approvals.
  it('treats CI set to anything but true as local', () => {
    const violations = run({
      main: [req('INV0001', ORIGINAL, 'active')],
      branch: [req('INV0001', REWORDED, 'active')],
      accountedFor: new Set(['INV0001']),
    });
    const grant = () => ({ payload: { requirementChanges: [{ id: 'AC0001', status: 'active', statement: ORIGINAL }] } });
    for (const value of ['false', '0', '1', 'TRUE']) {
      const env = { CI: value };
      expect(split(violations, env), value).toEqual({ failing: violations, forReview: [] });
      expect(approvedInPlanFor(env, grant), value).toHaveLength(1);
      expect(approvedElsewhereFor(env, () => [grant()]), value).toHaveLength(1);
      expect(planAccountsFor(env, []), value).toBe(true);
    }
  });

  describe('approved in plan mode', () => {
    const reworded = {
      main: [req('INV0001', ORIGINAL, 'active')],
      branch: [req('INV0001', REWORDED, 'active')],
      accountedFor: new Set(['INV0001']),
    };

    it('permits a rewording the approved plan states exactly', () => {
      expect(run({ ...reworded, approvedInPlan: [{ id: 'INV0001', status: 'active', statement: REWORDED }] })).toEqual([]);
    });

    it('matches by fingerprint, so whitespace does not matter', () => {
      expect(run({ ...reworded, approvedInPlan: [{ id: 'INV0001', status: 'active', statement: `  ${REWORDED.replace(' ', '   ')}` }] }))
        .toEqual([]);
    });

    it('does not permit a statement edited after the plan approved it', () => {
      const violations = run({ ...reworded, approvedInPlan: [{ id: 'INV0001', status: 'active', statement: ORIGINAL }] });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ id: 'INV0001', severity: 'needs-approval' });
    });

    it('does not permit a status the plan did not approve', () => {
      const violations = run({ ...reworded, approvedInPlan: [{ id: 'INV0001', status: 'withdrawn', statement: REWORDED }] });
      expect(violations).toHaveLength(1);
    });

    it('does not let an approval for one requirement cover another', () => {
      const violations = run({ ...reworded, approvedInPlan: [{ id: 'INV0002', status: 'active', statement: REWORDED }] });
      expect(violations).toHaveLength(1);
    });

    it('permits a retirement the plan approved', () => {
      expect(run({
        main: [req('AC0001', ORIGINAL, 'active')],
        branch: [req('AC0001', ORIGINAL, 'withdrawn')],
        accountedFor: new Set(['AC0001']),
        approvedInPlan: [{ id: 'AC0001', status: 'withdrawn', statement: ORIGINAL }],
      })).toEqual([]);
    });

    it('never lifts a forbidden violation', () => {
      const violations = run({
        ...reworded,
        accountedFor: new Set(),
        approvedInPlan: [{ id: 'INV0001', status: 'active', statement: REWORDED }],
      });
      expect(violations).toEqual([expect.objectContaining({ id: 'INV0001', severity: 'forbidden' })]);
      expect(run({
        main: [req('AC0001', ORIGINAL, 'active')],
        branch: [],
        approvedInPlan: [{ id: 'AC0001', status: 'active', statement: ORIGINAL }],
      })).toEqual([expect.objectContaining({ severity: 'forbidden' })]);
    });

    it('does not cover renumbering an id main knows', () => {
      const violations = run({
        main: [req('AC0001', ORIGINAL, 'active')],
        branch: [req('AC0002', ORIGINAL, 'active')],
        accountedFor: new Set(['AC0002']),
        approvedInPlan: [{ id: 'AC0001', status: 'active', statement: ORIGINAL }],
      });
      expect(violations).toEqual([expect.objectContaining({ id: 'AC0001', severity: 'needs-approval' })]);
    });
  });

  describe('approvedInPlanFor', () => {
    const grant = () => ({ payload: { requirementChanges: [{ id: 'AC0001', status: 'active', statement: ORIGINAL, scenarios: [] }] } });

    it('reads the well-formed changes from the plan approval outside CI', () => {
      expect(approvedInPlanFor({}, grant)).toEqual([{ id: 'AC0001', status: 'active', statement: ORIGINAL, scenarios: [] }]);
    });

    it('reads nothing in CI, and does not even look at the logbook', () => {
      expect(approvedInPlanFor({ CI: 'true' }, () => { throw new Error('read the logbook in CI'); })).toEqual([]);
    });

    it('reads nothing when no plan is approved', () => {
      expect(approvedInPlanFor({}, () => null)).toEqual([]);
    });
  });

  describe('approved in another change this branch carries', () => {
    const reworded = {
      main: [req('INV0001', ORIGINAL, 'active')],
      branch: [req('INV0001', REWORDED, 'active')],
      accountedFor: new Set(['INV0001']),
    };
    const carried = (statement: string, status: Status = 'active') =>
      [{ id: 'INV0001', status, statement }];

    it('permits a rewording a carried-in approval states exactly', () => {
      expect(run({ ...reworded, approvedElsewhere: carried(REWORDED) })).toEqual([]);
    });

    it('does not permit a rewording the carried-in approval states differently', () => {
      expect(run({ ...reworded, approvedElsewhere: carried(ORIGINAL) }))
        .toEqual([expect.objectContaining({ id: 'INV0001', severity: 'needs-approval' })]);
      expect(run({ ...reworded, approvedElsewhere: carried(REWORDED, 'withdrawn') })).toHaveLength(1);
    });

    // The change it came from has to have written its own change file. Only
    // this branch's plan may stand in for one, and only until `record`.
    it('never accounts for a change, even while this branch\'s plan would', () => {
      const violations = run({ ...reworded, accountedFor: new Set(), approvedElsewhere: carried(REWORDED), planAccounts: true });
      expect(violations).toEqual([
        expect.objectContaining({ id: 'INV0001', severity: 'forbidden', message: expect.stringContaining('no change file') }),
      ]);
    });

    it('permits a renumber only when the carried-in approval names both ids', () => {
      const renumbered = {
        main: [req('AC0001', ORIGINAL, 'active')],
        branch: [req('AC0009', ORIGINAL, 'active')],
        accountedFor: new Set(['AC0009']),
      };
      expect(run({ ...renumbered, approvedElsewhere: [{ id: 'AC0009', renumberedFrom: 'AC0001', status: 'active', statement: ORIGINAL }] }))
        .toEqual([]);
      expect(run({ ...renumbered, approvedElsewhere: [{ id: 'AC0009', status: 'active', statement: ORIGINAL }] }))
        .toEqual([expect.objectContaining({ id: 'AC0001', severity: 'needs-approval' })]);
    });

    it('permits a change approved in either place, alongside one approved in the other', () => {
      expect(run({
        main: [req('INV0001', ORIGINAL, 'active'), req('INV0002', ORIGINAL, 'active')],
        branch: [req('INV0001', REWORDED, 'active'), req('INV0002', REWORDED, 'active')],
        accountedFor: new Set(['INV0001', 'INV0002']),
        approvedInPlan: [{ id: 'INV0001', status: 'active', statement: REWORDED }],
        approvedElsewhere: [{ id: 'INV0002', status: 'active', statement: REWORDED }],
      })).toEqual([]);
    });
  });

  describe('approvedElsewhereFor', () => {
    const grants = () => [
      { payload: { requirementChanges: [{ id: 'AC0001', status: 'active', statement: ORIGINAL, scenarios: [] }] } },
      { payload: { requirementChanges: [] } },
      { payload: { requirementChanges: [{ id: 'AC0002', status: 'withdrawn', statement: REWORDED, scenarios: [] }] } },
    ];

    it('reads the well-formed changes from every carried-in approval outside CI', () => {
      expect(approvedElsewhereFor({}, grants)).toEqual([
        { id: 'AC0001', status: 'active', statement: ORIGINAL, scenarios: [] },
        { id: 'AC0002', status: 'withdrawn', statement: REWORDED, scenarios: [] },
      ]);
    });

    it('reads nothing in CI, and does not even look at the logbooks', () => {
      expect(approvedElsewhereFor({ CI: 'true' }, () => { throw new Error('read the logbooks in CI'); })).toEqual([]);
    });

    it('reads nothing when no other change is carried', () => {
      expect(approvedElsewhereFor({}, () => [])).toEqual([]);
    });


  });

  it('requires approval to move a status backwards', () => {
    const violations = run({
      main: [req('AC0001', ORIGINAL, 'active')],
      branch: [req('AC0001', ORIGINAL, 'accepted')],
      accountedFor: new Set(['AC0001']),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('active → accepted');
  });

  it('requires approval to resurrect a superseded requirement', () => {
    const violations = run({
      main: [req('AC0001', ORIGINAL, 'superseded')],
      branch: [req('AC0001', ORIGINAL, 'active')],
    });
    expect(violations[0]).toMatchObject({ severity: 'needs-approval' });
  });

  it('permits moving a status forwards, once recorded', () => {
    // Promotion to active is the only transition that needs no approval, but it
    // is still a change to agreed state and belongs in the change log.
    expect(run({
      main: [req('AC0001', ORIGINAL, 'accepted')],
      branch: [req('AC0001', ORIGINAL, 'active')],
      accountedFor: new Set(['AC0001']),
    })).toEqual([]);
  });

  it('forbids an unrecorded promotion to active', () => {
    const violations = run({
      main: [req('AC0001', ORIGINAL, 'accepted')],
      branch: [req('AC0001', ORIGINAL, 'active')],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ severity: 'forbidden' });
  });

  it('forbids an unaccounted statement change, in CI too', () => {
    // An accepted requirement needs no approval to be reworded, but the change
    // must still be recorded. Handing it to the reviewer does not substitute
    // for the record.
    const violations = run({
      main: [req('AC0001', ORIGINAL)],
      branch: [req('AC0001', REWORDED)],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'AC0001', severity: 'forbidden' });
    expect(violations[0]!.message).toContain('no change file');
    expect(split(violations, CI).failing).toEqual(violations);
  });

  it('permits rewording an accepted requirement that is accounted for', () => {
    expect(run({
      main: [req('AC0001', ORIGINAL)],
      branch: [req('AC0001', REWORDED)],
      accountedFor: new Set(['AC0001']),
    })).toEqual([]);
  });
});

describe('guard: a new requirement', () => {
  const scenario = (id: string, text: string): Scenario => ({ id, text, checksum: checksum(text) });
  const OPENS = 'The owner opens it.';
  const target = [req('AC0001', ORIGINAL, 'active')];
  const added = { ...req('AC0002', REWORDED, 'active'), scenarios: [scenario('AC0002.1', OPENS)] };
  const stated = (fields: Partial<RecordedRequirement> = {}): RecordedRequirement[] =>
    [{ id: 'AC0002', status: 'active', statement: REWORDED, scenarios: [`[AC0002.1] ${OPENS}`], ...fields }];
  const adding = { main: target, branch: [...target, added] };

  it('needs approval, which CI hands to the reviewer', () => {
    const violations = run({ ...adding, accountedFor: new Set(['AC0002']) });
    expect(violations).toEqual([{ id: 'AC0002', severity: 'needs-approval', message: 'added as a new requirement' }]);
    expect(split(violations, CI)).toEqual({ failing: [], forReview: violations });
    expect(split(violations, {})).toEqual({ failing: violations, forReview: [] });
  });

  it('is approved by a plan entry stating it exactly', () => {
    expect(run({ ...adding, accountedFor: new Set(['AC0002']), approvedInPlan: stated() })).toEqual([]);
  });

  it('is not approved by an entry with another status, statement or scenarios', () => {
    for (const entry of [
      stated({ status: 'accepted' }),
      stated({ statement: ORIGINAL }),
      stated({ scenarios: [`[AC0002.1] ${OPENS}`, '[AC0002.2] Nobody else does.'] }),
      stated({ scenarios: [] }),
    ]) {
      expect(run({ ...adding, accountedFor: new Set(['AC0002']), approvedInPlan: entry }))
        .toEqual([expect.objectContaining({ id: 'AC0002', severity: 'needs-approval' })]);
    }
  });

  it('is not approved by an entry that says it was renumbered', () => {
    expect(run({ ...adding, accountedFor: new Set(['AC0002']), approvedInPlan: stated({ renumberedFrom: 'AC0009' }) }))
      .toEqual([expect.objectContaining({ id: 'AC0002', severity: 'needs-approval' })]);
  });

  it('is approved, and never accounted for, by an approval carried in from another change', () => {
    expect(run({ ...adding, accountedFor: new Set(['AC0002']), approvedElsewhere: stated() })).toEqual([]);
    expect(run({ ...adding, approvedElsewhere: stated(), planAccounts: true })).toEqual([
      { id: 'AC0002', severity: 'forbidden', message: 'added but no change file on this branch accounts for it, and the approved plan does not list it as it now reads' },
    ]);
  });

  it('is accounted for by the plan before record, and only by a change file when recording', () => {
    expect(run({ ...adding, approvedInPlan: stated(), planAccounts: true })).toEqual([]);
    expect(run({ ...adding, approvedInPlan: stated(), planAccounts: false })).toEqual([
      { id: 'AC0002', severity: 'forbidden', message: 'added but no change file on this branch accounts for it' },
    ]);
  });

  it('fails without a change file in CI, where the missing record is forbidden', () => {
    const violations = run({ ...adding });
    expect(split(violations, CI)).toEqual({
      failing: [{ id: 'AC0002', severity: 'forbidden', message: 'added but no change file on this branch accounts for it' }],
      forReview: [{ id: 'AC0002', severity: 'needs-approval', message: 'added as a new requirement' }],
    });
  });

  it('does not treat the new id of a renumber as a new requirement', () => {
    const violations = run({ main: target, branch: [req('AC0009', ORIGINAL, 'active')], accountedFor: new Set(['AC0009']) });
    expect(violations).toEqual([expect.objectContaining({ id: 'AC0001', renumberedTo: 'AC0009', severity: 'needs-approval' })]);
  });

  it('is judged beside the requirements the target holds, each on its own', () => {
    const violations = run({
      main: target,
      branch: [req('AC0001', REWORDED, 'active'), added],
      accountedFor: new Set(['AC0001', 'AC0002']),
      approvedInPlan: stated(),
    });
    expect(violations).toEqual([expect.objectContaining({ id: 'AC0001', severity: 'needs-approval' })]);
  });

  it('needs nothing when the target has no catalogue yet', () => {
    expect(run({ main: null, branch: [added] })).toEqual([]);
  });
});

describe('guard: retiring a requirement', () => {
  // Retirement is the most powerful weakening available. It leaves the
  // statement untouched, so nothing about the text looks suspicious, while
  // removing the obligation entirely.
  it('requires approval to withdraw an active requirement', () => {
    const violations = run({
      main: [req('AC0001', ORIGINAL, 'active')],
      branch: [req('AC0001', ORIGINAL, 'withdrawn')],
      accountedFor: new Set(['AC0001']),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'AC0001', severity: 'needs-approval' });
  });

  it('requires approval to withdraw an accepted requirement', () => {
    const violations = run({
      main: [req('AC0001', ORIGINAL, 'accepted')],
      branch: [req('AC0001', ORIGINAL, 'withdrawn')],
      accountedFor: new Set(['AC0001']),
    });
    expect(violations[0]).toMatchObject({ severity: 'needs-approval' });
  });

  it('requires approval to supersede a requirement', () => {
    // The laundering route: add a weaker requirement (additions are free), then
    // point the strong one at it. Both halves must not be free.
    const violations = run({
      main: [req('AC0001', ORIGINAL, 'active')],
      branch: [req('AC0001', ORIGINAL, 'superseded'), req('AC0009', 'Something much weaker.')],
      accountedFor: new Set(['AC0001']),
    });
    expect(violations.some((v) => v.id === 'AC0001' && v.severity === 'needs-approval')).toBe(true);
  });

  it('records a retirement in a change file even when the statement is untouched', () => {
    // In CI the retirement itself goes to the reviewer, but the missing record
    // still fails.
    const { failing, forReview } = split(run({
      main: [req('AC0001', ORIGINAL, 'active')],
      branch: [req('AC0001', ORIGINAL, 'withdrawn')],
    }), CI);
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ severity: 'forbidden' });
    expect(failing[0]!.message).toContain('change file');
    expect(forReview).toEqual([expect.objectContaining({ id: 'AC0001', severity: 'needs-approval' })]);
  });

});

const FRONTMATTER = (body: string) => `---\n${body}\n---\n\n# 0009 — a change\n`;

describe('recordedIn', () => {
  it('reads the resulting requirement from frontmatter', () => {
    expect(recordedIn(FRONTMATTER(
      'requirements:\n' +
      '  - id: AC0001\n' +
      '    status: active\n' +
      `    statement: ${ORIGINAL}`,
    ))).toEqual([{ id: 'AC0001', status: 'active', statement: ORIGINAL, scenarios: [] }]);
  });

  it('does not let a prose mention account for a change', () => {
    // The rule this feeds is `forbidden` severity. An incidental cross-reference
    // must not be able to satisfy it.
    expect(recordedIn('This protects AC0001 and relates to [[INV0002]].')).toEqual([]);
  });

  it('ignores an entry missing its statement', () => {
    expect(recordedIn(FRONTMATTER('requirements:\n  - id: AC0001\n    status: active'))).toEqual([]);
  });

  it('ignores an entry with a status outside the lifecycle', () => {
    expect(recordedIn(FRONTMATTER(
      `requirements:\n  - id: AC0001\n    status: done\n    statement: ${ORIGINAL}`,
    ))).toEqual([]);
  });

  it('ignores an id that is not a requirement id', () => {
    expect(recordedIn(FRONTMATTER(
      `requirements:\n  - id: AC1\n    status: active\n    statement: ${ORIGINAL}`,
    ))).toEqual([]);
  });

  it('records nothing when there is no frontmatter at all', () => {
    expect(recordedIn('# 0009 — a change\n\nSome prose.')).toEqual([]);
  });

  it('survives malformed frontmatter without throwing', () => {
    expect(recordedIn('---\nrequirements: [unclosed\n---\n')).toEqual([]);
  });
});

describe('recordFidelity', () => {
  const rec = (id: string, status: Status, statement: string) => ({ id, status, statement });

  it('passes when the record matches the branch', () => {
    expect(recordFidelity(
      [rec('AC0001', 'active', ORIGINAL)],
      [req('AC0001', ORIGINAL, 'active')],
    )).toEqual([]);
  });

  it('forbids a record whose statement is not the one in the catalogue', () => {
    // The hole the old fingerprint column left open: a change file could claim
    // one sentence while the catalogue carried a weaker one.
    const violations = recordFidelity(
      [rec('INV0001', 'active', ORIGINAL)],
      [req('INV0001', REWORDED, 'active')],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'INV0001', severity: 'forbidden' });
    expect(violations[0]!.message).toContain('not the statement in the catalogue');
  });

  it('forbids a record whose status is not the one in the catalogue', () => {
    const violations = recordFidelity(
      [rec('AC0001', 'active', ORIGINAL)],
      [req('AC0001', ORIGINAL, 'accepted')],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('recorded as active but the catalogue says accepted');
  });

  it('forbids recording a requirement that does not exist on the branch', () => {
    const violations = recordFidelity([rec('AC0009', 'active', ORIGINAL)], []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'AC0009', severity: 'forbidden' });
  });

  it('reports both status and statement when both are wrong', () => {
    expect(recordFidelity(
      [rec('AC0001', 'active', ORIGINAL)],
      [req('AC0001', REWORDED, 'withdrawn')],
    )).toHaveLength(2);
  });
});

/**
 * A branch that gathers several changes before they reach the target can
 * record one requirement in several change files, each as it stood then. Only
 * the newest has to match the catalogue.
 */
describe('newestRecords', () => {
  const entry = (id: string, statement: string) =>
    `  - id: ${id}\n    status: active\n    statement: ${statement}`;
  const file = (path: string, ...entries: string[]) =>
    ({ path, markdown: FRONTMATTER(`requirements:\n${entries.join('\n')}`) });
  const statements = (files: { path: string; markdown: string }[]) =>
    newestRecords(files).map((r) => `${r.id} ${r.statement}`).sort();

  it('drops an older record of a requirement that a newer change file records again', () => {
    expect(statements([
      file('requirements/changes/20260101T000000.000Z__first.md', entry('AC0001', ORIGINAL)),
      file('requirements/changes/20260201T000000.000Z__second.md', entry('AC0001', REWORDED)),
    ])).toEqual([`AC0001 ${REWORDED}`]);
  });

  it('keeps a record that no newer change file replaces', () => {
    expect(statements([
      file('requirements/changes/20260101T000000.000Z__first.md', entry('AC0001', ORIGINAL), entry('AC0002', ORIGINAL)),
      file('requirements/changes/20260201T000000.000Z__second.md', entry('AC0001', REWORDED)),
    ])).toEqual([`AC0001 ${REWORDED}`, `AC0002 ${ORIGINAL}`]);
  });

  // Every order three files can arrive in. A sort that ignored the names would
  // give the same answer for some orders, but never the right one for all six.
  it('takes the order from the filenames, not from the order the files arrive in', () => {
    const first = file('requirements/changes/20260101T000000.000Z__first.md', entry('AC0001', 'The first wording.'));
    const second = file('requirements/changes/20260201T000000.000Z__second.md', entry('AC0001', 'The second wording.'));
    const third = file('requirements/changes/20260301T000000.000Z__third.md', entry('AC0001', 'The third wording.'));
    for (const order of [
      [first, second, third], [first, third, second], [second, first, third],
      [second, third, first], [third, first, second], [third, second, first],
    ]) {
      expect(statements(order)).toEqual(['AC0001 The third wording.']);
    }
  });

  it('keeps every entry the newest file has for a requirement, so a second cannot hide a false first', () => {
    expect(statements([
      file('requirements/changes/20260101T000000.000Z__first.md', entry('AC0001', ORIGINAL), entry('AC0001', REWORDED)),
    ])).toEqual([`AC0001 ${ORIGINAL}`, `AC0001 ${REWORDED}`]);
  });
});

/**
 * The plan is never committed, so the change file is the only place a departure
 * from it can survive the merge. These cases are about the section being there
 * at all — nothing here can tell whether what it says is true, and the tests
 * should not imply otherwise.
 */
describe('reportRecorded', () => {
  const SUMMARY = ['risk LOW · 0 high-risk files · 0 surprise failures', 'tests: 2 added, 1 modified, 0 removed'];
  const changeFile = (report: string, path = 'requirements/changes/20261023T000000.000Z__x.md') => ({
    path,
    markdown: `---\n---\n\n# X\n\n${report}\n\n## Why\n\nbecause\n\n## Departures\n\nNone.\n`,
  });
  const section = (lines: string[]) => `## Report\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\``;
  const declared = { summary: SUMMARY };

  it('passes a change file that opens with the declared summary, word for word', () => {
    expect(reportRecorded([changeFile(section(SUMMARY))], declared)).toEqual([]);
  });

  // Indentation and blank lines are how it was pasted, not what it says.
  it('passes the same lines indented or with blank lines between', () => {
    expect(reportRecorded([changeFile(section(['', ...SUMMARY.map((l) => `  ${l}`), '']))], declared)).toEqual([]);
  });

  it('forbids a change file with no Report section', () => {
    const [v] = reportRecorded([{ path: 'requirements/changes/x.md', markdown: '# X\n\n## Why\n\nbecause\n' }], declared);
    expect(v).toMatchObject({ id: 'x.md', severity: 'forbidden' });
    expect(v?.message).toMatch(/does not open with a `## Report` section/);
  });

  // At the top, where a reviewer reads it first.
  it('forbids a Report section that is not the first one', () => {
    const late = { path: 'requirements/changes/x.md', markdown: `# X\n\n## Why\n\nbecause\n\n${section(SUMMARY)}\n` };
    expect(reportRecorded([late], declared)[0]?.message).toMatch(/does not open with/);
  });

  // The agent writes the file; the lines are the harness's.
  it('forbids a summary that differs from the one declared, and says what it must read', () => {
    const better = [SUMMARY[0]!, 'tests: 9 added, 1 modified, 0 removed'];
    const [v] = reportRecorded([changeFile(section(better))], declared);
    expect(v?.severity).toBe('forbidden');
    expect(v?.message).toContain('differs from the summary the operator declared on');
    expect(v?.message).toContain('tests: 2 added, 1 modified, 0 removed');
  });

  it('forbids a summary with a line left out', () => {
    expect(reportRecorded([changeFile(section([SUMMARY[0]!]))], declared)).toHaveLength(1);
  });

  it('forbids a Report section with no text block', () => {
    expect(reportRecorded([changeFile(`## Report\n\n${SUMMARY.join('\n')}`)], declared)[0]?.message).toMatch(/has no text block/);
  });

  it('checks nothing when nothing was declared', () => {
    expect(reportRecorded([{ path: 'requirements/changes/x.md', markdown: '# X\n' }], null)).toEqual([]);
  });

  // The older new files belong to changes this branch carries, each declared
  // against its own summary.
  it('checks only the newest change file', () => {
    const older = { path: 'requirements/changes/20261001T000000.000Z__old.md', markdown: '# Old\n\n## Why\n' };
    expect(reportRecorded([changeFile(section(SUMMARY)), older], declared)).toEqual([]);
    const [v] = reportRecorded([older, changeFile(section(['other']), 'requirements/changes/20261024T000000.000Z__new.md')], declared);
    expect(v?.id).toBe('20261024T000000.000Z__new.md');
  });
});

describe('departuresRecorded', () => {
  const file = (markdown: string) => [{ path: 'requirements/changes/x.md', markdown }];
  const BODY = '# X\n\n## Why\n\nbecause\n\n## Departures\n\nNone.\n\n## How\n\nsomehow\n';

  it('passes a change file whose section says None.', () => {
    expect(departuresRecorded(file(BODY))).toEqual([]);
  });

  it('passes when the section is the last one in the file', () => {
    expect(departuresRecorded(file('# X\n\n## Departures\n\nThe cache was left out.\n'))).toEqual([]);
  });

  it('forbids a change file with no such section', () => {
    const [violation] = departuresRecorded(file('# X\n\n## Why\n\nbecause\n'));
    expect(violation?.severity).toBe('forbidden');
    expect(violation?.id).toBe('x.md');
    expect(violation?.message).toMatch(/no `## Departures` section/);
  });

  // The omission, written more convincingly. A heading with nothing under it
  // answers the guard without answering the question.
  it('forbids an empty section', () => {
    const [violation] = departuresRecorded(file('# X\n\n## Departures\n\n## How\n\nsomehow\n'));
    expect(violation?.severity).toBe('forbidden');
    expect(violation?.message).toMatch(/empty `## Departures` section/);
  });

  it('forbids a section holding only whitespace', () => {
    expect(departuresRecorded(file('# X\n\n## Departures\n\n   \n\n'))).toHaveLength(1);
  });

  // Frontmatter is data about the change, not prose in it. A change file that
  // merely mentions the heading in a YAML value has still said nothing.
  it('does not count the heading appearing in frontmatter', () => {
    expect(departuresRecorded(file('---\nnote: "## Departures"\n---\n\n# X\n'))).toHaveLength(1);
  });

  it('survives malformed frontmatter rather than throwing', () => {
    expect(() => departuresRecorded(file('---\n: : :\n---\n\n## Departures\n\nNone.\n'))).not.toThrow();
  });

  it('judges each change file separately', () => {
    expect(departuresRecorded([
      { path: 'requirements/changes/good.md', markdown: BODY },
      { path: 'requirements/changes/bad.md', markdown: '# X\n' },
    ]).map((v) => v.id)).toEqual(['bad.md']);
  });
});

describe('guard: scenarios', () => {
  const scenario = (id: string, text: string): Scenario => ({ id, text, checksum: checksum(text) });
  const withScenarios = (status: Status, ...scenarios: Scenario[]): Requirement =>
    ({ ...req('AC0001', ORIGINAL, status), scenarios });

  const ONE = scenario('AC0001.1', 'The owner opens it.');
  const TWO = scenario('AC0001.2', 'A stranger is told it is not found.');
  const TWO_WEAKER = scenario('AC0001.2', 'A stranger is usually told it is not found.');

  it('permits adding a scenario to an active requirement, once recorded', () => {
    const change = { main: [withScenarios('active', ONE)], branch: [withScenarios('active', ONE, TWO)] };
    expect(run({ ...change, accountedFor: new Set(['AC0001']) })).toEqual([]);
  });

  it('forbids adding a scenario that no change file records', () => {
    const violations = run({ main: [withScenarios('active', ONE)], branch: [withScenarios('active', ONE, TWO)] });
    expect(violations.map((v) => [v.severity, v.message])).toEqual([
      ['forbidden', expect.stringContaining('no change file')],
    ]);
  });

  it('requires approval to remove a scenario from an active requirement', () => {
    const violations = run({
      main: [withScenarios('active', ONE, TWO)],
      branch: [withScenarios('active', ONE)],
      accountedFor: new Set(['AC0001']),
    });
    expect(violations.map((v) => [v.severity, v.message])).toEqual([
      ['needs-approval', expect.stringContaining('removed or reworded: AC0001.2')],
    ]);
  });

  it('requires approval to reword a scenario of an active requirement', () => {
    const violations = run({
      main: [withScenarios('active', ONE, TWO)],
      branch: [withScenarios('active', ONE, TWO_WEAKER)],
      accountedFor: new Set(['AC0001']),
    });
    expect(violations.map((v) => v.severity)).toEqual(['needs-approval']);
  });

  it('permits rewording a scenario of an accepted requirement, once recorded', () => {
    expect(run({
      main: [withScenarios('accepted', ONE, TWO)],
      branch: [withScenarios('accepted', ONE, TWO_WEAKER)],
      accountedFor: new Set(['AC0001']),
    })).toEqual([]);
  });

  describe('approved in plan mode', () => {
    const removed = {
      main: [withScenarios('active', ONE, TWO)],
      branch: [withScenarios('active', ONE)],
      accountedFor: new Set(['AC0001']),
    };
    const approval = (scenarios?: string[]) =>
      [{ id: 'AC0001', status: 'active' as const, statement: ORIGINAL, scenarios }];

    it('permits a removal when the plan lists exactly the scenarios left', () => {
      expect(run({ ...removed, approvedInPlan: approval(['[AC0001.1] The owner opens it.']) })).toEqual([]);
    });

    it('does not permit it when the plan lists a scenario the branch no longer has', () => {
      expect(run({ ...removed, approvedInPlan: approval(['[AC0001.1] The owner opens it.', '[AC0001.2] A stranger is told it is not found.']) }))
        .toHaveLength(1);
    });

    // Otherwise approving a statement would approve any scenario edit made
    // alongside it without the operator ever seeing it.
    it('does not permit it when the plan leaves the scenarios out', () => {
      expect(run({ ...removed, approvedInPlan: approval() })).toHaveLength(1);
    });

    it('holds a carried-in approval to the same scenarios', () => {
      expect(run({ ...removed, approvedElsewhere: approval(['[AC0001.1] The owner opens it.']) })).toEqual([]);
      expect(run({ ...removed, approvedElsewhere: approval() })).toHaveLength(1);
    });
  });
});

describe('recordFidelity: scenarios', () => {
  const scenario = (id: string, text: string): Scenario => ({ id, text, checksum: checksum(text) });
  const branch = [{ ...req('AC0001', ORIGINAL, 'active'), scenarios: [scenario('AC0001.1', 'The owner opens it.'), scenario('AC0001.2', 'Nobody else does.')] }];
  const rec = (scenarios?: string[]) => [{ id: 'AC0001', status: 'active' as const, statement: ORIGINAL, scenarios }];

  it('passes a record listing every scenario, in any order, ignoring whitespace', () => {
    expect(recordFidelity(rec(['[AC0001.2]  Nobody else does.', '[AC0001.1] The owner opens it.']), branch)).toEqual([]);
  });

  it('forbids a record that leaves a scenario out', () => {
    expect(recordFidelity(rec(['[AC0001.1] The owner opens it.']), branch).map((v) => v.severity)).toEqual(['forbidden']);
    expect(recordFidelity(rec(), branch)).toHaveLength(1);
  });

  it('forbids a record whose scenario says something the catalogue does not', () => {
    expect(recordFidelity(rec(['[AC0001.1] The owner opens it.', '[AC0001.2] Somebody else might.']), branch)).toHaveLength(1);
  });

  it('forbids a record naming one scenario twice to stand in for another', () => {
    expect(recordFidelity(rec(['[AC0001.1] The owner opens it.', '[AC0001.1] The owner opens it.']), branch)).toHaveLength(1);
  });

  it('reads the scenarios from a change file', () => {
    expect(recordedIn([
      '---',
      'requirements:',
      '  - id: AC0001',
      '    status: active',
      `    statement: ${ORIGINAL}`,
      '    scenarios:',
      '      - "[AC0001.1] The owner opens it."',
      '---',
    ].join('\n'))).toEqual([{ id: 'AC0001', status: 'active', statement: ORIGINAL, scenarios: ['[AC0001.1] The owner opens it.'] }]);
  });
});

/**
 * A renumber of an id main knows. The guard files it under the old id, and a
 * plan approves it only by naming both ids. Whatever else the renumber carries
 * is reported as it would be without it.
 */
describe('guard: renumbering an agreed requirement', () => {
  const scenario = (id: string, text: string): Scenario => ({ id, text, checksum: checksum(text) });
  const withScenarios = (id: string, status: Status, ...scenarios: Scenario[]): Requirement =>
    ({ ...req(id, ORIGINAL, status), scenarios });

  const OPENS = 'The owner opens it.';
  const NOT_FOUND = 'A stranger is told it is not found.';
  const main = [withScenarios('AC0001', 'active', scenario('AC0001.1', OPENS), scenario('AC0001.2', NOT_FOUND))];
  const moved = withScenarios('AC0009', 'active', scenario('AC0009.1', OPENS), scenario('AC0009.2', NOT_FOUND));
  const renumber = { main, branch: [moved], accountedFor: new Set(['AC0009']) };
  const approval = (overrides: Partial<RecordedRequirement> = {}): RecordedRequirement[] => [{
    id: 'AC0009',
    renumberedFrom: 'AC0001',
    status: 'active',
    statement: ORIGINAL,
    scenarios: [`[AC0009.1] ${OPENS}`, `[AC0009.2] ${NOT_FOUND}`],
    ...overrides,
  }];

  it('files the renumber under the old id, naming the new one', () => {
    expect(run(renumber)).toEqual([{
      id: 'AC0001',
      severity: 'needs-approval',
      message: expect.stringContaining('AC0001 → AC0009'),
      renumberedTo: 'AC0009',
    }]);
  });

  it('permits a renumber the plan states with both ids and the exact result', () => {
    expect(run({ ...renumber, approvedInPlan: approval() })).toEqual([]);
  });

  it('does not permit it when the plan states a different result', () => {
    expect(run({ ...renumber, approvedInPlan: approval({ statement: REWORDED }) })).toHaveLength(1);
    expect(run({ ...renumber, approvedInPlan: approval({ status: 'accepted' }) })).toHaveLength(1);
    expect(run({ ...renumber, approvedInPlan: approval({ scenarios: [`[AC0009.1] ${OPENS}`] }) })).toHaveLength(1);
  });

  it('does not permit it when the plan names a different old id', () => {
    expect(run({ ...renumber, approvedInPlan: approval({ renumberedFrom: 'AC0002' }) })).toHaveLength(1);
  });

  it('does not let a renumber entry approve an ordinary change to its id', () => {
    // AC0001 is still there, reworded. An entry for AC0009 renumbered from
    // AC0001 says nothing about that rewording.
    const violations = run({
      main: [req('AC0001', ORIGINAL, 'active')],
      branch: [req('AC0001', REWORDED, 'active'), req('AC0009', REWORDED, 'active')],
      accountedFor: new Set(['AC0001']),
      approvedInPlan: [
        { id: 'AC0001', renumberedFrom: 'AC0009', status: 'active', statement: REWORDED },
        { id: 'AC0009', renumberedFrom: 'AC0001', status: 'active', statement: REWORDED },
      ],
    });
    // AC0009 is a new requirement, and an entry renumbering it from AC0001
    // does not approve it either.
    expect(violations).toEqual([
      expect.objectContaining({ id: 'AC0001', severity: 'needs-approval' }),
      expect.objectContaining({ id: 'AC0009', severity: 'needs-approval', message: 'added as a new requirement' }),
      expect.objectContaining({ id: 'AC0009', severity: 'forbidden' }),
    ]);
  });

  it('forbids a renumber no change file records under the new id, in CI too, approved or not', () => {
    // The old id cannot be recorded: a change file states the requirement as
    // it now is, and the old id is no longer in the catalogue.
    const unrecorded = { ...renumber, accountedFor: new Set(['AC0001']) };
    const violations = run(unrecorded);
    expect(violations.map((v) => [v.severity, v.message])).toEqual([
      ['needs-approval', expect.stringContaining('AC0001 → AC0009')],
      ['forbidden', expect.stringContaining('no change file on this branch accounts for AC0009')],
    ]);
    expect(split(violations, CI).failing).toEqual([violations[1]]);
    expect(run({ ...unrecorded, approvedInPlan: approval() }))
      .toEqual([expect.objectContaining({ severity: 'forbidden' })]);
  });

  it('reports a scenario removed or reworded behind a renumber, under the id main had', () => {
    const violations = run({
      ...renumber,
      branch: [withScenarios('AC0009', 'active', scenario('AC0009.1', OPENS), scenario('AC0009.2', `Usually, ${NOT_FOUND}`))],
    });
    expect(violations.map((v) => [v.id, v.severity, v.message, v.renumberedTo])).toEqual([
      ['AC0001', 'needs-approval', expect.stringContaining('AC0001 → AC0009'), 'AC0009'],
      ['AC0001', 'needs-approval', expect.stringContaining('removed or reworded: AC0001.2'), 'AC0009'],
    ]);
    // CI hands both to the reviewer, so neither hides the other.
    expect(split(violations, CI)).toEqual({ failing: [], forReview: violations });

    expect(run({ ...renumber, branch: [withScenarios('AC0009', 'active', scenario('AC0009.1', OPENS))] })
      .map((v) => v.message)).toEqual([
      expect.stringContaining('AC0001 → AC0009'),
      expect.stringContaining('removed or reworded: AC0001.2'),
    ]);
  });

  it('needs no approval for a scenario added behind a renumber, beyond the renumber itself', () => {
    const branch = [{ ...moved, scenarios: [...moved.scenarios, scenario('AC0009.3', 'Its sources are listed.')] }];
    expect(run({ ...renumber, branch }).map((v) => v.message)).toEqual([expect.stringContaining('AC0001 → AC0009')]);
  });

  it('reports a status moved behind a renumber', () => {
    const violations = run({ ...renumber, branch: [{ ...moved, status: 'withdrawn' }] });
    expect(violations.map((v) => v.message)).toEqual([
      expect.stringContaining('AC0001 → AC0009'),
      expect.stringContaining('retired without approval: active → withdrawn'),
    ]);
  });

  it('lifts everything a renumber carries when the plan states its exact result', () => {
    const branch = [{ ...withScenarios('AC0009', 'withdrawn', scenario('AC0009.1', OPENS)) }];
    expect(run({ ...renumber, branch })).toHaveLength(3);
    expect(run({
      ...renumber,
      branch,
      approvedInPlan: approval({ status: 'withdrawn', scenarios: [`[AC0009.1] ${OPENS}`] }),
    })).toEqual([]);
  });

  it('reads renumberedFrom from a change file, and drops an entry whose old id is malformed or of another type', () => {
    const entry = (from: string) => FRONTMATTER(
      `requirements:\n  - id: AC0009\n    renumberedFrom: ${from}\n    status: active\n    statement: ${ORIGINAL}`,
    );
    expect(recordedIn(entry('AC0001'))).toEqual([
      { id: 'AC0009', renumberedFrom: 'AC0001', status: 'active', statement: ORIGINAL, scenarios: [] },
    ]);
    expect(recordedIn(entry('AC1'))).toEqual([]);
    expect(recordedIn(entry('INV0001'))).toEqual([]);
    expect(recordedIn(entry('AC0009'))).toEqual([]);
  });

  it('passes renumberedFrom through from the plan approval', () => {
    const grant = () => ({ payload: { requirementChanges: approval() } });
    expect(approvedInPlanFor({}, grant)).toEqual(approval());
  });

  it('forbids a record of a renumber whose old id is still in the catalogue', () => {
    const record = [{ id: 'AC0009', renumberedFrom: 'AC0001', status: 'active' as const, statement: ORIGINAL }];
    expect(recordFidelity(record, [req('AC0009', ORIGINAL, 'active')])).toEqual([]);
    expect(recordFidelity(record, [req('AC0009', ORIGINAL, 'active'), req('AC0001', REWORDED, 'active')]))
      .toEqual([expect.objectContaining({
        id: 'AC0009',
        severity: 'forbidden',
        message: expect.stringContaining('AC0001 is still in the catalogue'),
      })]);
  });
});

/**
 * The guard runs straight after the lint in `workflow verify`. Its details used
 * to come before its own heading, so they sat under `req:lint — catalogue OK`
 * and read as a lint problem.
 */
describe('the failure report', () => {
  it('prints its heading before its details', () => {
    const lines = failureReport([{ id: 'AC0001', severity: 'forbidden', message: 'AC0001 was deleted' }]);
    expect(lines).toEqual(['req:guard — 1 violation(s)', '  AC0001: AC0001 was deleted']);
  });

  // In words any agent can follow: an approved plan, not the agent's plan mode.
  it('puts the approval hint after the details, when an approval could help', () => {
    const lines = failureReport([{ id: 'AC0001', severity: 'needs-approval', message: 'reworded' }]);
    expect(lines).toEqual([
      'req:guard — 1 violation(s)',
      '  AC0001: reworded',
      '',
      '  A plan the operator approved may approve these, by listing each one as it',
      "  will read under `requirement-changes:` in the plan's closing `workflow` block.",
      '  A renumber is listed under its new id, with the old one as `renumberedFrom`.',
    ]);
  });
});

// Until the operator types `record`, the approved plan stands in for the change
// file, so the change file can be written once the outcome is known. These
// cases set `planAccounts` the way `planAccountsFor` would: true before
// `record`, false in the run that records the change.
describe('guard: the plan accounts for a change until record', () => {
  const scenario = (id: string, text: string): Scenario => ({ id, text, checksum: checksum(text) });
  const OPENS = 'The owner opens it.';
  const NOT_FOUND = 'A stranger is told it is not found.';
  const withScenarios = (id: string, statement: string, ...scenarios: Scenario[]): Requirement =>
    ({ ...req(id, statement, 'active'), scenarios });

  const reworded = {
    main: [req('INV0001', ORIGINAL, 'active')],
    branch: [req('INV0001', REWORDED, 'active')],
    approvedInPlan: [{ id: 'INV0001', status: 'active' as const, statement: REWORDED }],
  };

  it('accepts a rewording the plan states exactly, with no change file, before record', () => {
    expect(run({ ...reworded, planAccounts: true })).toEqual([]);
  });

  it('demands the change file for the same rewording when recording', () => {
    expect(run({ ...reworded, planAccounts: false })).toEqual([
      expect.objectContaining({ id: 'INV0001', severity: 'forbidden', message: expect.stringContaining('no change file') }),
    ]);
  });

  it('accepts an added scenario the plan lists, with no change file, before record', () => {
    expect(run({
      main: [withScenarios('AC0001', ORIGINAL, scenario('AC0001.1', OPENS))],
      branch: [withScenarios('AC0001', ORIGINAL, scenario('AC0001.1', OPENS), scenario('AC0001.2', NOT_FOUND))],
      approvedInPlan: [{ id: 'AC0001', status: 'active', statement: ORIGINAL, scenarios: [`[AC0001.1] ${OPENS}`, `[AC0001.2] ${NOT_FOUND}`] }],
      planAccounts: true,
    })).toEqual([]);
  });

  it('still wants a change file for an added scenario the plan does not list', () => {
    const violations = run({
      main: [withScenarios('AC0001', ORIGINAL, scenario('AC0001.1', OPENS))],
      branch: [withScenarios('AC0001', ORIGINAL, scenario('AC0001.1', OPENS), scenario('AC0001.2', NOT_FOUND))],
      planAccounts: true,
    });
    expect(violations).toEqual([expect.objectContaining({ id: 'AC0001', severity: 'forbidden' })]);
  });

  it('does not account for a requirement edited after the plan approved it', () => {
    const violations = run({
      ...reworded,
      approvedInPlan: [{ id: 'INV0001', status: 'active', statement: ORIGINAL }],
      planAccounts: true,
    });
    expect(violations.map((v) => v.severity).sort()).toEqual(['forbidden', 'needs-approval']);
  });

  describe('a renumber', () => {
    const renumber = {
      main: [withScenarios('AC0001', ORIGINAL, scenario('AC0001.1', OPENS))],
      branch: [withScenarios('AC0009', ORIGINAL, scenario('AC0009.1', OPENS))],
    };
    const approval = (renumberedFrom?: string): RecordedRequirement[] =>
      [{ id: 'AC0009', renumberedFrom, status: 'active', statement: ORIGINAL, scenarios: [`[AC0009.1] ${OPENS}`] }];

    it('is accounted for by a plan entry naming both ids, before record', () => {
      expect(run({ ...renumber, approvedInPlan: approval('AC0001'), planAccounts: true })).toEqual([]);
    });

    it('is not accounted for by an entry naming only the new id', () => {
      const violations = run({ ...renumber, approvedInPlan: approval(), planAccounts: true });
      expect(violations).toContainEqual(expect.objectContaining({ severity: 'forbidden', message: expect.stringContaining('renumbered to AC0009') }));
    });

    it('needs its change file when recording', () => {
      const violations = run({ ...renumber, approvedInPlan: approval('AC0001'), planAccounts: false });
      expect(violations).toEqual([expect.objectContaining({ severity: 'forbidden', message: expect.stringContaining('renumbered to AC0009') })]);
    });
  });

  it('never accounts for a deletion, whatever the plan says', () => {
    expect(run({
      main: [req('AC0001', ORIGINAL, 'active')],
      branch: [],
      approvedInPlan: [{ id: 'AC0001', status: 'active', statement: ORIGINAL }],
      planAccounts: true,
    })).toEqual([expect.objectContaining({ severity: 'forbidden', message: expect.stringContaining('deleted') })]);
  });

  it('names the plan as a route in its message only when the plan could account for it', () => {
    const before = run({ ...reworded, approvedInPlan: [], planAccounts: true });
    const recording = run({ ...reworded, approvedInPlan: [], planAccounts: false });
    expect(before.find((v) => v.severity === 'forbidden')?.message).toContain('approved plan does not list it');
    expect(recording.find((v) => v.severity === 'forbidden')?.message).not.toContain('approved plan');
  });

  describe('planAccountsFor', () => {
    it('lets the plan account for a change outside CI, until record', () => {
      expect(planAccountsFor({}, [])).toBe(true);
    });

    it('does not when the guard runs to record a change', () => {
      expect(planAccountsFor({}, ['--record'])).toBe(false);
    });

    it('never does in CI, flag or not', () => {
      expect(planAccountsFor(CI, [])).toBe(false);
      expect(planAccountsFor(CI, ['--record'])).toBe(false);
    });
  });
});

// A ref that does not exist is an ordinary state: a target never fetched, a
// first branch. The guard reads it through git, and git says `fatal:` about it.
// That text belongs in the error, where the operator reads it when it matters,
// and not printed on every run where the guard catches it.
describe('the guard reading git, with a ref that does not exist', () => {
  let repo: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), 'guard-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    git('init', '--quiet');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '--allow-empty', '-m', 'first');
    // The guard asks the rulebook where the requirements live before it asks git.
    writeConfig(repo);
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  const stderrDuring = (run: () => void): string => {
    const noise: string[] = [];
    const real = process.stderr.write;
    process.stderr.write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
      noise.push(String(chunk));
      return (real as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    } as typeof process.stderr.write;
    try {
      run();
    } finally {
      process.stderr.write = real;
    }
    return noise.join('');
  };

  it('answers that the ref does not exist, and prints nothing', () => {
    let exists: boolean | undefined;
    expect(stderrDuring(() => { exists = refExists('refs/remotes/origin/nowhere'); })).toBe('');
    expect(exists).toBe(false);
  });

  it("throws with git's own message when asked for the catalogue there, and prints nothing", () => {
    let failure: unknown;
    const noise = stderrDuring(() => {
      try {
        loadCatalogueAt('refs/remotes/origin/nowhere');
      } catch (error) {
        failure = error;
      }
    });
    expect(noise).toBe('');
    expect(String((failure as Error | undefined)?.message)).toMatch(/fatal: Not a valid object name/);
  });
});

/**
 * The guard as `workflow req guard` and the referee verify run it, against a
 * repository whose target holds one active requirement. It prints what it
 * found and says whether it passed, rather than exiting.
 */
describe('runGuard', () => {
  const cwd = process.cwd();
  let root: string;
  const FILE = 'requirements/acceptance/AC0001__a_thing.md';
  const requirement = (statement: string) =>
    `---\nstatus: active\n---\n\n${statement}\n\n## Scenarios\n\n- [AC0001.1] Something observable happens.\n`;

  const printed = (run: () => boolean) => {
    const lines: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (line: string) => lines.push(line);
    console.error = (line: string) => lines.push(line);
    try {
      return { passed: run(), text: lines.join('\n') };
    } finally {
      [console.log, console.error] = [log, error];
    }
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-run-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '--quiet', '--initial-branch', 'feat/x');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    configureTarget(root);
    mkdirSync(join(root, 'requirements/acceptance'), { recursive: true });
    writeFileSync(join(root, FILE), requirement('A thing happens.'));
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    markTarget(root);
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
    if (server) rmSync(server, { recursive: true, force: true });
    server = undefined;
  });

  /**
   * In CI the guard fetches the target before it compares anything, so a case
   * run as CI needs a server that answers: a bare repository on disk, holding
   * the base commit as its `main`. Outside it, the fixture's remote is a path
   * that does not exist.
   */
  let server: string | undefined;
  const serveTarget = () => {
    server = realpathSync(mkdtempSync(join(tmpdir(), 'guard-server-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['init', '--quiet', '--bare', server], { stdio: 'ignore' });
    git('remote', 'set-url', 'origin', server);
    git('push', '--quiet', 'origin', 'HEAD:main');
  };

  it('passes when nothing protected changed, and says so', () => {
    expect(printed(() => runGuard([], {}))).toEqual({ passed: true, text: 'req:guard — no protected requirement was changed without approval' });
  });

  it('compares the change file with the live declaration when recording', () => {
    const branch = 'feat/x';
    const book = dirFor(branch);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    append(book, 'plan_approved', approval({ baseline: sha }), branch);
    const { treeFingerprint, implementationFingerprint, testFingerprint, rulebookFingerprint, baseline } = current();
    append(book, 'triaged', triaged({ treeFingerprint, implementationFingerprint }), branch);
    append(book, 'verified', verified({ treeFingerprint, implementationFingerprint, testFingerprint, rulebookFingerprint, baseline }), branch);

    const file = 'requirements/changes/20261110T000000.000Z__change.md';
    mkdirSync(dirname(file), { recursive: true });
    const writeReport = (lines: string[]) => writeFileSync(file, reportSection(lines) + '\n\n## Departures\n\nNone.\n');
    writeReport(['No uncovered lines.']);
    const check = () => printed(() => runGuard(['--record'], {}));
    expect(check().passed).toBe(true);

    const summary = ['One uncovered line.'];
    append(book, 'declared', { treeFingerprint, summary, changeReportSnapshot: 'report.json', note: null, gaps: { uncoveredLines: 1 } }, branch);
    expect(check()).toEqual({ passed: false, text: expect.stringContaining('differs from the summary the operator declared on') });
    writeReport(summary);
    expect(check().passed).toBe(true);
  });

  // A target that is not here once made every change file look new, so the
  // guard listed old ones as missing their Departures and never said why.
  it('refuses with one line naming the target when the target is not here, and judges nothing', () => {
    mkdirSync(join(root, 'requirements/changes'), { recursive: true });
    writeFileSync(join(root, 'requirements/changes/20260101T000000.000Z__old.md'), '# Old\n\n## Why\n\nbecause\n');
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: root });
    expect(printed(() => runGuard([], {}))).toEqual({
      passed: false,
      text: 'req:guard — the target origin/main is not here, so this branch has nothing to compare against. Push the target branch, or fetch it, and run again.',
    });
  });

  // It once read CI from the process for the fetch and from its argument for
  // everything else, so a caller that said "not in CI" was fetched for anyway
  // whenever the process ran in CI, and failed on a server it never needed.
  it('does not fetch when the environment it is given is not CI, even when the process is', () => {
    const saved = process.env.CI;
    process.env.CI = 'true';
    try {
      expect(printed(() => runGuard([], {})).passed).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CI;
      else process.env.CI = saved;
    }
  });

  it('fetches the target first in CI, and refuses in one line naming the target when the server does not answer', () => {
    expect(printed(() => runGuard([], CI))).toEqual({
      passed: false,
      text: 'req:guard — could not fetch origin/main from the server, so nothing here can be compared against it',
    });
    serveTarget();
    expect(printed(() => runGuard([], CI)).passed).toBe(true);
  });

  it('fails a deleted requirement everywhere, CI included', () => {
    serveTarget();
    unlinkSync(join(root, FILE));
    for (const env of [{}, { CI: 'true' }]) {
      const { passed, text } = printed(() => runGuard([], env));
      expect(passed).toBe(false);
      expect(text).toMatch(/^req:guard — 1 violation\(s\)/);
    }
  });

  // Outside CI an approval is the plan's. In CI the reviewer reads the
  // rewording, and the merge is the approval, but a change no change file
  // accounts for fails there too: no approval could permit that.
  it('fails a reworded requirement nobody approved, and in CI lists it for the reviewer as well', () => {
    serveTarget();
    writeFileSync(join(root, FILE), requirement('A different thing happens.'));
    expect(printed(() => runGuard([], {})).passed).toBe(false);
    const ci = printed(() => runGuard([], { CI: 'true' }));
    expect(ci.passed).toBe(false);
    expect(ci.text).toContain('req:guard — a reviewer must read these before merging:\n  AC0001: statement of an active requirement was reworded');
    expect(ci.text).toContain('AC0001: changed but no change file on this branch accounts for it');
  });

  // Two changes made one after the other on a branch that has not reached the
  // target yet. Each change file recorded AC0001 as it stood then.
  describe('when two change files record the same requirement', () => {
    const changeFile = (name: string, statement: string) => {
      mkdirSync(join(root, 'requirements/changes'), { recursive: true });
      writeFileSync(join(root, 'requirements/changes', name), [
        '---',
        'requirements:',
        '  - id: AC0001',
        '    status: active',
        `    statement: ${statement}`,
        '    scenarios:',
        "      - '[AC0001.1] Something observable happens.'",
        '---',
        '',
        '# A change',
        '',
        '## Departures',
        '',
        'None.',
        '',
      ].join('\n'));
    };

    beforeEach(() => {
      serveTarget();
      writeFileSync(join(root, FILE), requirement('A different thing happens.'));
      changeFile('20260101T000000.000Z__first.md', 'A second thing happens.');
    });

    it('passes when the newest one matches the catalogue, though an older one no longer does', () => {
      changeFile('20260201T000000.000Z__second.md', 'A different thing happens.');
      const { passed, text } = printed(() => runGuard([], CI));
      expect(text).not.toContain('not the statement in the catalogue');
      expect(passed).toBe(true);
    });

    it('fails, in CI too, when the newest one does not match the catalogue', () => {
      changeFile('20260201T000000.000Z__second.md', 'A thing happens, usually.');
      const { passed, text } = printed(() => runGuard([], CI));
      expect(passed).toBe(false);
      expect(text).toContain('AC0001: has a statement in its change file that is not the statement in the catalogue');
    });
  });
});

// Where the requirements live is the rulebook's `requirementsDir`. The
// catalogue at a ref is read straight out of git, so what it finds is what git
// holds under that folder and nowhere else.
describe('the guard reading the folder the rulebook names', () => {
  let repo: string;
  let cwd: string;
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const entry = (statement: string) => `---\nstatus: accepted\n---\n\n${statement}\n`;

  beforeEach(() => {
    cwd = process.cwd();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'guard-folder-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeConfig(repo, { fields: { requirementsDir: 'specs/' } });
    put('specs/acceptance/AC0001__a.md', entry('First.'));
    put('specs/invariants/INV0001__b.md', entry('Second.'));
    // Under the folder, and not requirements: a record, a note, a backup, and
    // a folder of the same name one level down.
    put('specs/changes/20260101T000000.000Z__c.md', entry('Not a requirement.'));
    put('specs/acceptance/notes.txt', 'not markdown');
    put('specs/acceptance/AC0002__d.md.bak', entry('A backup.'));
    put('specs/changes/acceptance/AC0003__e.md', entry('Nested.'));
    // The default folder, which this rulebook does not use.
    put('requirements/acceptance/AC0004__f.md', entry('In the wrong folder.'));
    git('add', '-A');
    git('commit', '--quiet', '-m', 'catalogue');
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('finds the acceptance criteria and invariants under that folder, and only those', () => {
    const found = loadCatalogueAt('HEAD');
    expect(found.map((requirement) => requirement.id).sort()).toEqual(['AC0001', 'INV0001']);
    expect(found.map((requirement) => requirement.path).sort()).toEqual(['specs/acceptance/AC0001__a.md', 'specs/invariants/INV0001__b.md']);
  });
});
