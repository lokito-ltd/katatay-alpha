import { describe, expect, it } from 'vitest';
import { gateReason } from './gate.mjs';
import { operatorToken, excerpt, EXCERPT_LIMIT } from './operator.mjs';

// Only a write that needs a plan reaches the gate. The locks, and the files
// that need no plan, are decided before it, in `../moments/write.mjs`, and
// tested there and in `../locks.test.mjs`.
//
// The gate says which kind of refusal it is as well as why: `needs_plan` when
// a plan would allow the write, `stop` when only the operator can fix what is
// wrong. The write moment passes the code on, so an adapter never has to read
// the sentence to tell the two apart.
describe('the phase gate', () => {
  // How a plan is presented is the agent adapter's to add, by the code.
  it('denies a write while no plan is approved, and says to present one to the operator', () => {
    const reason = gateReason({ phase: 'open' });
    expect(reason.code).toBe('needs_plan');
    expect(reason.text).toMatch(/no plan has been approved/i);
    expect(reason.text).toMatch(/present it to the operator for approval/);
    expect(reason.text).toContain(`you can still write plan files, FOLLOW-UPS.md, and files outside the repository that no lock covers.`);
  });

  // The format is the referee's to say, where an agent first needs a plan, so
  // nothing it checks at approval depends on a skill. With no plans folder no
  // plan can be approved, so there is no format worth printing.
  it('prints where a plan goes and its format, when the rulebook names a plans folder', () => {
    expect(gateReason({ phase: 'open', plans: '~/plans' }).text)
      .toMatch(/no lock covers\.\n\nA plan is a Markdown file directly in ~\/plans, the rulebook's plans folder\./);
    expect(gateReason({ phase: 'open' }).text).toMatch(/no lock covers\.$/);
  });

  it('permits writing once a plan has been approved', () => {
    for (const phase of ['implementing', 'converging', 'verified', 'declared', 'recorded']) {
      expect(gateReason({ phase })).toBeNull();
    }
  });

  it('stops a write when the logbook no longer links up, in any phase', () => {
    for (const phase of ['open', 'implementing']) {
      const reason = gateReason({ phase, broken: 'seq mismatch' });
      expect(reason.code).toBe('stop');
      expect(reason.text).toMatch(/state chain on this branch is broken/i);
    }
  });

  // The rulebook can keep its follow-ups elsewhere, and the agent is told the
  // file it can actually write.
  it('names the rulebook\'s follow-ups file in every message that says what can still be written', () => {
    const followUps = 'docs/LATER.md';
    for (const reason of [
      gateReason({ phase: 'open', followUps }),
      gateReason({ unconfigured: 'no target', followUps }),
      gateReason({ unreadable: 'EISDIR', followUps }),
    ]) {
      expect(reason.text).toContain('docs/LATER.md');
      expect(reason.text).not.toContain('FOLLOW-UPS.md');
    }
  });

  // Without a target there is no baseline to measure a change from.
  it('stops a write when no target is configured, and passes on why', () => {
    const reason = gateReason({ phase: 'open', broken: null, unconfigured: 'no target in the rulebook' });
    expect(reason.code).toBe('stop');
    expect(reason.text).toMatch(/^no target in the rulebook/);
    expect(reason.text).toContain('Plan files, FOLLOW-UPS.md and files outside the repository that no lock covers can still be written.');
  });

  // Without the rulebook its locks are unknown, so a file outside the
  // repository is not known to be safe either, and the message must not say
  // that such files or plans still are.
  it('says only the follow-ups file is left when the rulebook itself cannot be read', () => {
    const reason = gateReason({ unconfigured: 'the rulebook is refused', rulebookRead: false });
    expect(reason.code).toBe('stop');
    expect(reason.text).toMatch(/^the rulebook is refused/);
    expect(reason.text).toMatch(/Only FOLLOW-UPS\.md can still be written: the rulebook's locks cannot be read/);
    expect(reason.text).not.toMatch(/outside the repository|Plan files/);
  });

  // The gate used to allow whatever it could not judge. A state nobody can
  // read is not known to be an approved one, so no phase is passed here and
  // the edit is denied all the same.
  describe('when the state cannot be read', () => {
    const unreadable = "fatal: ambiguous argument 'HEAD'";

    it('stops the write, and gives the error it met', () => {
      const reason = gateReason({ unreadable });
      expect(reason.code).toBe('stop');
      expect(reason.text).toMatch(/could not read the workflow state/);
      expect(reason.text).toContain(unreadable);
    });

    it('says which files can still be written, so the agent is not left stuck', () => {
      expect(gateReason({ unreadable }).text).toContain('Plan files, FOLLOW-UPS.md and files outside the repository that no lock covers can still be written.');
    });
  });
});

describe('the operator vocabulary', () => {
  it('accepts reset alone', () => {
    expect(operatorToken('reset')).toMatchObject({ event: 'reset' });
  });

  // Permission comes from approving a plan in plan mode. A typed word that
  // still granted permission would be a second route around that.
  it('no longer recognises waive or approve', () => {
    expect(operatorToken('waive')).toBeNull();
    expect(operatorToken('approve')).toBeNull();
    expect(operatorToken('approve: looks good')).toBeNull();
  });

  it('accepts record alone, as the operator declaring the change finished', () => {
    expect(operatorToken('record')).toMatchObject({ token: 'record', event: 'declared', note: null });
  });

  it('ignores case and surrounding whitespace', () => {
    expect(operatorToken('  RESET\n')).toMatchObject({ event: 'reset' });
    expect(operatorToken(' Record ')).toMatchObject({ event: 'declared' });
  });

  it('carries an optional note after a colon', () => {
    expect(operatorToken('reset: abandoning this approach')).toMatchObject({ note: 'abandoning this approach' });
    expect(operatorToken('record: happy with this')).toMatchObject({ note: 'happy with this' });
  });

  // The word is worthless if a sentence about it counts as the word.
  it('refuses anything that is not the whole message', () => {
    for (const prompt of [
      'should we reset this?',
      'reset the database migration',
      'please reset',
      'should we record this?',
      'record the change file',
      'recorded',
    ]) {
      expect(operatorToken(prompt)).toBeNull();
    }
  });

  it('trims a long plan down to something a diff can hold', () => {
    const long = 'x'.repeat(EXCERPT_LIMIT + 50);
    expect(excerpt(long)).toHaveLength(EXCERPT_LIMIT + 1);
    expect(excerpt('short')).toBe('short');
  });
});
