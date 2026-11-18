/** The referee's four moments, asked directly with plain JSON, as an agent adapter
 *  asks them. The other machine cases go through the Claude Code hooks, which
 *  translate around these same commands; these prove the contract a second
 *  adapter would rely on, with no Claude Code payload anywhere. See
 *  `src/agents/README.md` and `harness.mjs` for why they spawn processes. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ctx, events, git, machineFixture, on, phase, planFile, setVerify, triage } from '../support/machine/harness.mjs';

machineFixture();

/** Every request carries the contract's version. */
const ask = (moment, input) => on(moment, { version: 1, ...input });

/**
 * A plan approved through the moment rather than the hook. The plan is put in
 * its file first, which is the adapter's job, and the request names the file.
 */
const approve = (plan = '# Plan\n\nChange source.txt.', file = planFile()) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, plan);
  return ask('plan-approved', { planFile: file });
};

/** The answer's messages as `code/for`, which is what an adapter branches on. */
const codes = (answer) => answer.messages.map((m) => `${m.code}/${m.for}`);

const allowed = { version: 1, allow: true, messages: [] };

describe('on write', () => {
  const file = (path, removes = false) => ({ writes: [{ path, delete: removes }], command: null });

  // The format is the referee's to say, so an agent with no skill for it
  // still learns it where it first needs a plan.
  it('says where a plan goes and the format it must follow', () => {
    const { text } = ask('write', file('source.txt')).answer.messages[0];
    expect(text).toContain('A plan is a Markdown file directly in ~/.claude/plans, the rulebook\'s plans folder.');
    expect(text).toContain('- `test-only: true` declares a change made only of tests.');
    expect(text).toContain('- `requirement-changes:` lists each requirement the change adds, rewords or retires');
  });

  // Which plans and follow-ups need no plan is the rulebook's, so the referee
  // decides it from the path.
  it('allows a plan directly in the rulebook\'s plans folder, and the follow-ups file, before any approval', () => {
    expect(ask('write', file(planFile())).answer).toEqual(allowed);
    expect(ask('write', file('FOLLOW-UPS.md')).answer).toEqual(allowed);
    expect(ask('write', file(join(ctx.repo, 'FOLLOW-UPS.md'))).answer).toEqual(allowed);
  });

  // Only files directly in the plans folder are exempt, and that matters for
  // a plans folder inside the repository (`gating.test.mjs`). This one is
  // outside it, where every file not locked is allowed anyway.
  it('allows anything else in a plans folder outside the repository, as it allows any file there', () => {
    expect(ask('write', file(planFile('drafts/a-plan.md'))).answer).toEqual(allowed);
    expect(ask('write', file(planFile('hook.mjs'))).answer).toEqual(allowed);
  });

  it('allows a write once a plan is approved, and still refuses a locked one', () => {
    approve();
    expect(ask('write', file('source.txt')).answer).toEqual(allowed);
    const logbook = ask('write', file('.katatay/state/x')).answer;
    expect(codes(logbook)).toEqual(['locked/agent']);
    expect(logbook.messages[0].text).toMatch(/workflow logbook/);
    const removal = ask('write', file('requirements/AC0001.md', true)).answer;
    expect(codes(removal)).toEqual(['locked/agent']);
    expect(removal.messages[0].text).toMatch(/never deleted/);
  });
});

describe('on prompt', () => {
  it('hears the operator reset the workflow', () => {
    const { answer } = ask('prompt', { prompt: 'reset' });
    expect(codes(answer)).toEqual(['reset/agent', 'state/agent']);
    expect(answer.messages[0].text).toMatch(/^The operator reset the workflow\./);
    expect(events().some((e) => e.endsWith('__reset.json'))).toBe(true);
  });

  it('does not take `record` on a tree nobody has verified, and says so for the operator', () => {
    approve();
    const { answer } = ask('prompt', { prompt: 'record' });
    expect(codes(answer)).toEqual(['not_declared/operator', 'state/agent']);
    expect(answer.messages[0].text).toMatch(/typed `record`, but it was not recorded/);
    expect(events().some((e) => e.endsWith('__declared.json'))).toBe(false);
  });
});

describe('on plan-approved', () => {
  it('records the approval and permits edits', () => {
    const { answer } = approve();
    expect(answer.version).toBe(1);
    expect(answer.recorded).toBe(true);
    expect(codes(answer)).toEqual(['approved/agent']);
    expect(phase()).toBe('implementing');
    const [event] = events();
    const approved = JSON.parse(readFileSync(join(ctx.logbook, event), 'utf8'));
    expect(approved.event).toBe('plan_approved');
    expect(approved.payload).not.toHaveProperty('planFile');
    expect(answer.messages[0].text).toBe('Plan approval recorded. Edits are now permitted.\n'
      + `approved plan: ${approved.payload.planSnapshot} — read the approved plan from this snapshot.`);
    expect(readFileSync(join(ctx.repo, approved.payload.planSnapshot))).toEqual(readFileSync(planFile()));
  });

  it('records nothing for an empty plan, and refuses it for the operator', () => {
    const { answer } = approve('  \n');
    expect(answer.recorded).toBe(false);
    expect(codes(answer)).toEqual(['refused/operator']);
    expect(answer.messages[0].text).toMatch(/does not follow the plan format\.\n\n- It has no text besides its `workflow` block\./);
    expect(events()).toEqual([]);
  });

  it('records nothing on the target branch, and says the branch has to change', () => {
    git('checkout', '--quiet', '-b', 'main');
    const { answer } = approve();
    expect(answer.recorded).toBe(false);
    expect(codes(answer)).toEqual(['refused/operator']);
    expect(answer.messages[0].text).toMatch(/not recorded: this is main, the branch changes merge into/);
  });

  it('says a test-only change runs the triage first', () => {
    const { answer } = approve('# Plan\n\nTests only.\n\n```workflow\ntest-only: true\n```\n');
    expect(codes(answer)).toEqual(['approved/agent', 'run_triage/agent']);
  });
});

describe('on turn-end', () => {
  const end = (stopRefusedBefore = false) => ask('turn-end', { stopRefusedBefore, secondsLeft: 900 }).answer;

  it('has nothing to say on a clean branch with no plan', () => {
    expect(end()).toEqual({ version: 1, keepWorking: false, messages: [] });
  });

  it('says nothing is verified while the implementation is in progress, and lets the turn end', () => {
    approve();
    const answer = end();
    expect(answer.keepWorking).toBe(false);
    expect(codes(answer)).toEqual(['run_triage/agent']);
    expect(answer.messages[0].text).toMatch(/^Nothing is verified while the implementation is in progress/);
  });

  // The pass is for the operator. Whether to refuse the stop to deliver it is
  // the adapter's choice, so the referee lets the turn end.
  it('lets the turn end on a pass, with the triage and the verified report for the operator', () => {
    approve();
    triage();
    setVerify(true);
    const answer = end();
    expect(answer.keepWorking).toBe(false);
    expect(codes(answer)).toEqual(['triaged/operator', 'verified/operator', 'info/agent']);
    expect(answer.messages[0].text).toMatch(/^Triage of plan's missed predictions and test regressions\./);
    expect(answer.messages[1].text).toMatch(/^Verification passed\.\n/);
    expect(JSON.stringify(answer)).not.toContain('Repeat this to the operator');
    expect(phase()).toBe('verified');
  });

  it('keeps the agent working on a failure, and not after a refused stop', () => {
    approve();
    triage();
    setVerify(false);
    const first = end();
    expect(first.keepWorking).toBe(true);
    expect(codes(first)).toEqual(['triaged/operator', 'verify_failed/operator', 'info/agent']);
    const second = end(true);
    expect(second.keepWorking).toBe(false);
    expect(codes(second)).toEqual(['verify_failed/operator', 'info/agent']);
  });
});

describe('input that does not match', () => {
  it('is refused with exit 2 and a sentence saying what is wrong', () => {
    const missing = ask('turn-end', { stopRefusedBefore: false });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('on turn-end: refused, `secondsLeft` must be number, and is missing.');
    expect(ask('plan-approved', { planFile: 3 }).stderr).toContain('`planFile` must be string, and is 3');
    expect(on('write', '[]').stderr).toContain('on write: refused, the input is not a JSON object.');
  });

});
