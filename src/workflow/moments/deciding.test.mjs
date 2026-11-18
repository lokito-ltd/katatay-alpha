import { readBaseline } from '../phase.mjs';
/** Fast decisions share a fixture with the longer journeys in tests/machine. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { analysisPath } from '../../../tests/fixtures/workflow/events.mjs';
import { ctx, approvePlan, events, git, FIXTURE_ADAPTER, machineFixture, phase, planFile, publish, setVerify, triage, userSettings } from '../../../tests/support/machine/harness.mjs';
import { eventNamed, read, serverDown, targetGainsATest } from '../../../tests/support/machine/baselines.mjs';
import { repositoryRulebook } from '../../../tests/fixtures/workflow/adapter.mjs';
import { append, sha256 } from '../chain.mjs';
import { writeTriageSnapshot } from '../triage-snapshot.mjs';
import { current } from '../state.mjs';
import { gitCommandsDuring } from '../../../tests/fixtures/workflow/trace.mjs';
import { VERIFY, onTurnEnd } from './turn-end.mjs';
import { shapeProblems } from './io.mjs';
import { inFixture, started, referee, write, edit, said, codes, message, globs, asked, prompt, approval, approve, turnEnd, triageReply, goesOn, ends, allowed, put, dropTarget, breakLog, TEST_ONLY, treeNow } from '../../../tests/support/workflow/deciding.mjs';

machineFixture();

const approvedSnapshotLine = () => {
  const { planSnapshot } = read(eventNamed('plan_approved').at(-1)).payload;
  return `\napproved plan: ${planSnapshot} — read the approved plan from this snapshot.`;
};

describe('the input a moment accepts', () => {
  const shape = { write: 'boolean', planFile: 'string|null', secondsLeft: 'number', prompt: 'string' };

  // The contract's version is the one number a moment takes. Any other means
  // an adapter was left behind.
  it('takes version 1 and nothing else', () => {
    const versioned = { version: '1' };
    expect(shapeProblems({ version: 1 }, versioned)).toEqual([]);
    expect(shapeProblems({}, versioned)).toEqual(['`version` must be 1, and is missing']);
    expect(shapeProblems({ version: 2 }, versioned)).toEqual(['`version` must be 1, and is 2']);
    expect(shapeProblems({ version: '1' }, versioned)).toEqual(['`version` must be 1, and is "1"']);
  });

  it('has nothing wrong when every field is the right type', () => {
    expect(shapeProblems({ write: true, planFile: null, secondsLeft: 1.5, prompt: '' }, shape)).toEqual([]);
    expect(shapeProblems({ write: false, planFile: 'a.md', secondsLeft: 0, prompt: 'x', extra: 1 }, shape)).toEqual([]);
  });

  it('names each field that is missing or of the wrong type', () => {
    expect(shapeProblems({ write: 'yes', planFile: 3, secondsLeft: Number.NaN }, shape)).toEqual([
      '`write` must be boolean, and is "yes"',
      '`planFile` must be string or null, and is 3',
      '`secondsLeft` must be number, and is null',
      '`prompt` must be string, and is missing',
    ]);
  });

  it('refuses anything that is not an object', () => {
    for (const input of [null, [], 'text', 3]) expect(shapeProblems(input, shape)).toEqual(['the input is not a JSON object']);
  });
});

describe('on write, decided', () => {
  it('denies a write when no target is configured, and allows one that needs no plan', () => {
    dropTarget();
    const denied = write(edit());
    expect(denied.allow).toBe(false);
    expect(codes(denied)).toEqual(['stop/operator']);
    expect(said(denied)).toMatch(/Stop and tell the operator/);
    expect(write(edit('FOLLOW-UPS.md'))).toEqual(allowed);
  });

  // A logbook path that is a file is not a logbook anyone can trust.
  it('denies a write when the logbook path is a file', () => {
    mkdirSync(join(ctx.logbook, '..'), { recursive: true });
    writeFileSync(ctx.logbook, 'not a folder\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'a logbook that is a file');
    const denied = write(edit());
    expect(denied.allow).toBe(false);
    expect(codes(denied)).toEqual(['stop/operator']);
    expect(said(denied)).toMatch(/broken/);
  });

  // A shell command is never held for a plan, so a broken logbook does not
  // hold it either. The shell is how anyone finds out what broke.
  it('denies every write in the repository while the logbook is broken, and not the shell', () => {
    approvePlan();
    breakLog();
    const commands = gitCommandsDuring(() => expect(said(write(edit()))).toMatch(/broken/));
    expect(commands.some(cmd => cmd.startsWith('check-ignore '))).toBe(false);
    expect(inFixture(() => current()).next).toEqual(['stop and tell the operator']);
    expect(write({ writes: [], command: 'workflow state show' })).toEqual(allowed);
  });
});

describe('on prompt, decided', () => {
  it('says where the change is, in one state message', () => {
    expect(prompt('hello')).toMatch(/^workflow: open on feat\/x/);
    expect(codes(asked('hello'))).toEqual(['state/agent']);
  });

  it('says it refuses to run with no target, and stops the agent', () => {
    dropTarget();
    expect(prompt('hello')).toMatch(/^workflow: refused — [\s\S]*\nStop and tell the operator\.$/);
    // The one answer whose last message is not the state: there is none.
    expect(codes(asked('hello'))).toEqual(['stop/operator']);
  });
});

describe('on plan-approved, decided', () => {
  it('records a first approval, with the snapshot and its location', () => {
    const answer = approval('# Plan\n\nChange source.txt.', planFile('a.md'));
    expect(answer).toEqual({ version: 1, recorded: true, messages: [message('approved', 'agent', 'Plan approval recorded. Edits are now permitted.' + approvedSnapshotLine())] });
    const approved = JSON.parse(readFileSync(join(ctx.logbook, events()[0]), 'utf8'));
    expect(approved.payload).not.toHaveProperty('planFile');
    expect(readFileSync(join(ctx.repo, approved.payload.planSnapshot))).toEqual(readFileSync(planFile('a.md')));
    expect(approved.payload.proposal).toBe(sha256(readFileSync(planFile('a.md'))));
  });

  it('keeps tests unfrozen and appends no evidence for the same plan bytes under a new name', () => {
    const text = '# Plan\n\nChange source.txt.';
    approval(text);
    triage();
    const before = events();
    const repeated = approval(text, planFile('duplicate.md'));
    expect(repeated).toMatchObject({ version: 1, recorded: false, messages: [{ code: 'info', text: expect.stringContaining('converging') }] });
    writeFileSync(join(ctx.repo, 'new.test.mjs'), '// Tests may now be added.');
    expect(phase()).toBe('converging');
    expect(events()).toEqual(before);
  });

  it('reads the plan from its file, and the hash is of the file', () => {
    // The plan is written by hand, so what the referee records can only have
    // come from the file: the request names the file and nothing else.
    const file = planFile('by-hand.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Plan\n\nOnly tests.\n\n```workflow\ntest-only: true\n```\n');
    expect(codes(approval(null, file))).toEqual(['approved/agent', 'run_triage/agent']);
    const approved = JSON.parse(readFileSync(join(ctx.logbook, events()[0]), 'utf8'));
    expect(approved.payload).toMatchObject({ proposal: sha256(readFileSync(file)), testOnly: true });
    expect(approved.payload).not.toHaveProperty('excerpt');
    expect(readFileSync(join(ctx.repo, approved.payload.planSnapshot))).toEqual(readFileSync(file));
  });

  it('stops when the approval names no readable plan file in the plans folder', () => {
    const outside = join(ctx.home, 'elsewhere', 'a-plan.md');
    const cases = [
      [planFile('missing.md'), null, /the plan file .*missing\.md cannot be read \(ENOENT\)\. No plan file means no approval, so edits stay blocked\. Stop and tell the operator\.$/],
      [outside, '# Plan', /is not a Markdown file directly in ~\/\.claude\/plans, the rulebook's plans folder, so the approval does not name a plan the workflow can read\. The agent adapter chose that file\./],
      [join(dirname(planFile()), 'sub', 'a-plan.md'), '# Plan', /is not a Markdown file directly in/],
      [planFile('a-plan.txt'), '# Plan', /is not a Markdown file directly in/],
    ];
    for (const [file, plan, said_] of cases) {
      const answer = approval(plan, file);
      expect(answer.recorded, file).toBe(false);
      expect(codes(answer)).toEqual(['stop/operator']);
      expect(said(answer)).toMatch(said_);
    }
    expect(events()).toEqual([]);
  });

  it('refuses a plan that does not follow the format, naming every problem and the format', () => {
    const answer = approval('# Plan\n\n```workflow\ntestonly: true\ntest-only: yes\nrequirement-changes:\n  - id: AC1\n    status: active\n    statement: A thing.\n```\n');
    expect(answer.recorded).toBe(false);
    expect(codes(answer)).toEqual(['refused/operator']);
    expect(said(answer)).toContain([
      'does not follow the plan format.',
      '',
      '- Its `workflow` block holds `testonly`, which is not a key a plan may hold.',
      '- `test-only` must be true or false, and is "yes".',
      '- `requirement-changes` AC1 (entry 1): `id` must be AC or INV and four digits, and is "AC1".',
      '',
      'A plan is a Markdown file directly in ~/.claude/plans, the rulebook\'s plans folder.',
    ].join('\n'));
    expect(said(answer)).toMatch(/Fix the plan, then present it again\.$/);
    expect(events()).toEqual([]);
  });

  // Read as declaring nothing, this plan would lose its test-only declaration
  // without anyone being told.
  it('refuses a plan whose declarations are still frontmatter at the top, and says where they go', () => {
    const answer = approval('---\ntest-only: true\n---\n\n# Plan\n\nTests only.\n');
    expect(answer.recorded).toBe(false);
    expect(codes(answer)).toEqual(['refused/operator']);
    expect(said(answer)).toContain('- It opens with `---` frontmatter, which is no longer read: its declarations go in a `workflow` block at its end.');
    expect(events()).toEqual([]);
  });

  it('records a revision, and sends the change back to implementing', () => {
    approve();
    triage();
    expect(approve('# Plan\n\nMore.')).toMatch(/^Plan approval recorded\. It replaces the earlier approved plan/);
    expect(phase()).toBe('implementing');
  });

  it('says what a test-only plan and approved requirement changes mean', () => {
    expect(approve(TEST_ONLY)).toMatch(/declares this change test-only\. Run `workflow triage` now/);
    const plan = '# Plan\n\n```workflow\nrequirement-changes:\n  - id: AC0001\n    status: active\n    statement: A thing.\n```\n';
    expect(approve(plan)).toMatch(/approves requirement changes, .*: AC0001\./);
  });

  it('names work already in the tree, as a warning for the operator', () => {
    put('source.txt', 'changed before any plan\n');
    const answer = approval();
    expect(codes(answer)).toEqual(['approved/agent', 'warning/operator']);
    expect(said(answer)).toMatch(/already changes 1 file\(s\) that are not on origin\/main: source\.txt/);
  });

  it('takes the baseline as last fetched when the server does not answer, and says so', () => {
    serverDown();
    const answer = approval();
    expect(codes(answer)).toEqual(['approved/agent', 'info/agent']);
    expect(said(answer)).toMatch(/The server did not answer, so the baseline was taken from origin\/main as last fetched/);
  });

  it('records nothing into a broken logbook, for an empty plan, or on the target', () => {
    approve();
    breakLog();
    const broken = approval('# Plan\n\nAgain.');
    expect(broken.recorded).toBe(false);
    expect(codes(broken)).toEqual(['stop/operator']);
    expect(said(broken)).toMatch(/state chain is broken/);
    rmSync(ctx.logbook, { recursive: true, force: true });
    const empty = approval(' ');
    expect(empty.recorded).toBe(false);
    expect(codes(empty)).toEqual(['refused/operator']);
    expect(said(empty)).toMatch(/- It has no text besides its `workflow` block\./);
    git('checkout', '--quiet', '-b', 'main');
    const target = approval();
    expect(target.recorded).toBe(false);
    expect(codes(target)).toEqual(['refused/operator']);
    expect(said(target)).toMatch(/not recorded: this is main/);
  });

  it('says the approval was not recorded when the rulebook has no target', () => {
    dropTarget();
    const failed = approval();
    expect(failed.recorded).toBe(false);
    expect(codes(failed)).toEqual(['stop/operator']);
    expect(said(failed)).toMatch(/^The plan was approved, but the workflow hook failed to record it:/);
  });
});

describe('on turn-end, decided', () => {
  it('has nothing to say on a clean branch with no plan, and says so when the tree has changes', () => {
    expect(turnEnd()).toEqual({ version: 1, keepWorking: false, messages: [] });
    put('stray.txt', 'x\n');
    const stray = turnEnd();
    expect(codes(stray)).toEqual(['warning/operator']);
    expect(ends(stray)).toMatch(/^The working tree has changes, but no plan has been approved/);
  });

  it('holds the freeze while implementing, and keeps the agent working only when it may', () => {
    approve();
    expect(codes(turnEnd())).toEqual(['run_triage/agent']);
    expect(ends(turnEnd())).toMatch(/^Nothing is verified while the implementation is in progress/);
    put('a.test.mjs', 'export {};\n');
    expect(codes(turnEnd())).toEqual(['frozen/agent']);
    expect(goesOn(turnEnd())).toMatch(/are frozen until the triage has run[\s\S]*a\.test\.mjs[\s\S]*Unwind them/);
    expect(ends(turnEnd(true))).toMatch(/are frozen until the triage has run/);
  });

  it('tells a test-only change to run the triage first', () => {
    approve(TEST_ONLY);
    expect(ends(turnEnd())).toMatch(/declared test-only, so there is no implementation to wait for/);
    put('a.test.mjs', 'export {};\n');
    expect(goesOn(turnEnd())).toMatch(/declared test-only, so the triage runs first/);
  });

  it('verifies a second, distinct triage reply for the same triage', () => {
    approve();
    triage({ treeFingerprint: treeNow() });
    expect(goesOn(triageReply('first'))).toContain('Continue the approved work now');
    expect(started).toHaveLength(0);

    const second = triageReply('second');
    expect(ends(second)).toMatch(/(^|\n)Verification passed\.\n/);
    expect(codes(second)).toContain('verified/operator');
    expect(started.filter(call => call.file === VERIFY)).toHaveLength(1);
    expect(eventNamed('verified')).toHaveLength(1);
    expect(eventNamed('convergence_requested')).toHaveLength(1);
  });

  it('verifies normally if the first triage reply arrives after the tree changed', () => {
    approve();
    triage({ treeFingerprint: treeNow() });
    put('retry.test.mjs', '// already edited');
    expect(ends(triageReply('late'))).toMatch(/(^|\n)Verification passed\.\n/);
    expect(eventNamed('convergence_requested')).toHaveLength(0);
  });

  it('records a failed verify, with the fresh triage, and does not rerun it on an unchanged tree', () => {
    approve();
    triage();
    setVerify(false);
    const failed = turnEnd();
    expect(failed.keepWorking).toBe(true);
    // The triage and the failure's summary are for the operator, the note
    // for the agent. Relaying the one and asking for the other is the adapter's.
    expect(codes(failed)).toEqual(['triaged/operator', 'verify_failed/operator', 'info/agent']);
    expect(failed.messages[0].text).toMatch(/^Triage of plan's missed predictions and test regressions\.\n\nRisk: LOW\n/);
    expect(failed.messages[1].text).toMatch(/^Verification failed\.\n\nFailures:\n/);
    expect(failed.messages[1].text).toMatch(/\nDetails: \.katatay\/state\/feat_x\/\d{4}__verify_failed\.json$/);
    expect(failed.messages[2].text).toMatch(/^`workflow verify` failed on the current working tree/);
    expect(failed.messages[2].text).toContain('FAIL ');
    expect(JSON.stringify(failed)).not.toContain('Repeat this to the operator');
    expect(events().at(-1)).toMatch(/__verify_failed\.json$/);
    expect(ends(turnEnd(true))).toMatch(/still fails: the working tree has not changed since it failed/);
    expect(said(triageReply('late after failure'))).toContain('still fails: the working tree has not changed');
    expect(eventNamed('convergence_requested')).toHaveLength(0);
    expect(started.filter(call => call.file === VERIFY)).toHaveLength(1);
  });

  // The unified results are a pass's only evidence. The old transport, or
  // nothing at all, measured nothing a receipt could vouch for.
  it.each([
    ['the old transport', { checks: [{ name: 'mutation', runs: 'oncePerPlan', outcome: 'clean', code: 0, text: 'ran' }], junitReports: [] }],
    ['an empty file', {}],
    ['no file', null],
  ])('refuses a successful verify that supplies %s instead of check results', (_, written) => {
    approve();
    triage();
    const referee = (_file, args) => {
      if (written) writeFileSync(args[1], JSON.stringify(written));
      return { status: 0, stdout: 'passed' };
    };
    const answer = inFixture(() => onTurnEnd({ stopRefusedBefore: false, secondsLeft: 900 }, { referee }));
    expect(said(answer)).toContain('verify returned no check results');
    expect(eventNamed('verified')).toHaveLength(0);
    expect(read(eventNamed('verify_failed')[0]).payload).toEqual({ treeFingerprint: expect.any(String), baseline: readBaseline(read(eventNamed('plan_approved')[0]).payload.baseline), rulebookFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      tail: 'verify returned no check results', results: ['tests', 'coverage', 'mutation'].map(name => ({ name, status: 'skipped', reason: 'Verify supplied no usable results.', evidence: [], summary: {} })) });
  });

  // A pass lets the turn end, and is for the operator. An adapter that refuses
  // the stop to deliver it has spent the turn's one refusal, so a failure on
  // the turn end after it may still keep the agent working, once.
  it('lets the turn end on a pass, and still keeps the agent working on a failure after it', () => {
    approve();
    triage();
    setVerify(true);
    const passed = turnEnd();
    expect(codes(passed)).toEqual(['triaged/operator', 'verified/operator', 'info/agent']);
    expect(ends(passed)).toMatch(/(^|\n)Verification passed\.\n/);
    setVerify(false);
    expect(goesOn(turnEnd(true))).toMatch(/`workflow verify` failed on the current working tree/);
  });

  it('names the files a test-only change touched that are not tests', () => {
    approve(TEST_ONLY);
    put('feature.mjs', 'export const on = true;\n');
    triage();
    setVerify(true);
    const passed = turnEnd();
    expect(codes(passed)).toEqual(['triaged/operator', 'verified/operator', 'info/agent']);
    expect(passed.messages[1].text).toContain('\n\nWarnings:\nThe plan declared this change test-only, and these are not tests:\nfeature.mjs\n');
  });

  it('stops on a broken logbook, and refuses to run with no target', () => {
    approve();
    breakLog();
    expect(codes(turnEnd())).toEqual(['stop/operator']);
    expect(goesOn(turnEnd())).toMatch(/^The workflow state chain is broken/);
    dropTarget();
    const refused = turnEnd(true);
    expect(codes(refused)).toEqual(['stop/operator']);
    expect(ends(refused)).toMatch(/^The workflow refuses to run:/);
  });
});

/*
 * What mutation testing showed no case above would notice: a message cut
 * short, a branch taken when it should not be, a field left out of an event.
 * Each case below fails if one of those comes back.
 */

/** The current working-tree fingerprint, as the moments see it. */

/** The rulebook's mutation section, changed. */
const setMutation = (fields) => {
  const path = join(ctx.repo, '.katatay/rulebook.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(config.checks.testQuality.mutation, fields);
  writeFileSync(path, `${JSON.stringify(config)}\n`);
};

describe('on write, said in full', () => {
  it('asks for a plan, then says where it goes and the format it must follow', () => {
    const reason = said(write(edit()));
    expect(reason).toMatch(/no lock covers\.\n\nA plan is a Markdown file directly in ~\/\.claude\/plans, the rulebook's plans folder\. It uses the template below/);
    expect(reason).toMatch(/A renumbered requirement adds `renumberedFrom` with its old id\./);
    expect(reason).toMatch(/The triage reports a failure no entry predicted, and a predicted test that passed\.\n\nOnly that closing block declares anything\. A `workflow` block anywhere else, and `---` frontmatter at the top of the plan, are refused\. An example of the block inside a plan uses another label, such as yaml\./);
  });

  it('passes on why no target could be read, before what can still be written', () => {
    dropTarget();
    const reason = said(write(edit()));
    expect(reason).toMatch(/^\.katatay\/rulebook\.json has no "targetBranch" key, .*The workflow refuses to run without it\./);
    expect(reason).toMatch(/\n\nStop and tell the operator\. Only FOLLOW-UPS\.md can still be written: the rulebook's locks cannot be read, so nothing else is known to be safe to write\.$/);
  });
});

describe('on prompt, said in full', () => {
  it('keeps the note the operator gave with a reset', () => {
    prompt('reset: starting over');
    const [reset] = eventNamed('reset');
    expect(read(reset).payload).toEqual({ note: 'starting over' });
  });

  it('carries what the agent check found wrong', () => {
    userSettings({ disableAllHooks: true });
    expect(prompt('hello')).toMatch(/^settings: claude: ~\/\.claude\/settings\.json sets disableAllHooks.*Tell the operator\.$/m);
  });
});

describe('on plan-approved, said in full', () => {
  it('keeps the baseline in force for a revision, and does not name the branch\'s own work', () => {
    approve();
    const first = readBaseline(read(events()[0]).payload.baseline);
    triage();
    put('source.txt', 'this change\n');
    expect(approve('# Plan\n\nMore.')).toBe(
      'Plan approval recorded. It replaces the earlier approved plan on this branch, and the change is back to implementing: '
        + 'this plan has not been triaged, so the tests are frozen again. Revert any test written since the baseline before running `workflow triage`.' + approvedSnapshotLine(),
    );
    const [, revision] = eventNamed('plan_approved');
    expect(read(revision).payload.baseline).toBe(first);
  });

  it('records nothing when there is no baseline to pin', () => {
    serverDown();
    git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(approve()).toBe(
      'The plan was approved, but not recorded: origin/main has never been fetched and the server did not answer, '
        + 'so there is no baseline to measure the change from. Fetch it, then present the plan again.',
    );
    expect(events()).toEqual([]);
  });

  it('names at most five of the files already changed, and says how many there are', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) put(`f${n}.txt`, 'before any plan\n');
    const said = approve();
    const listed = /already changes 6 file\(s\) that are not on origin\/main: (.*), …\. A change is one branch/.exec(said);
    expect(listed).not.toBeNull();
    expect(listed[1].split(', ')).toHaveLength(5);
    expect(said).toMatch(/A change is one branch, and a branch cut from another unmerged branch is not supported: that work, committed or not, counts as this change's\. Tell the operator\.$/);
  });

  it('lists five files whole, with nothing left out', () => {
    for (const n of [1, 2, 3, 4, 5]) put(`f${n}.txt`, 'before any plan\n');
    expect(approve()).toMatch(/already changes 5 file\(s\) that are not on origin\/main: f1\.txt, f2\.txt, f3\.txt, f4\.txt, f5\.txt\. A change/);
  });

  it('says each thing the plan declares, a message each', () => {
    expect(approval(TEST_ONLY).messages).toEqual([
      message('approved', 'agent', 'Plan approval recorded. Edits are now permitted.' + approvedSnapshotLine()),
      message('run_triage', 'agent', 'The plan declares this change test-only. Run `workflow triage` now, before writing anything: '
        + 'it has to find the suite green, because a new test landing on top of an existing failure is much harder to sort out afterwards.'),
    ]);
  });

  it('names the requirement changes the plan approves', () => {
    const plan = '# Plan\n\n```workflow\nrequirement-changes:\n  - id: AC0001\n    status: active\n    statement: A thing.\n```\n';
    expect(approve(plan)).toBe(
      'Plan approval recorded. Edits are now permitted. The plan approves requirement changes, which req:guard now accepts locally when the catalogue matches them exactly: AC0001.' + approvedSnapshotLine(),
    );
  });

  it('says on the target branch what to do instead', () => {
    git('checkout', '--quiet', '-b', 'main');
    expect(approve()).toBe(
      'The plan was approved, but not recorded: this is main, the branch changes merge into. A change is made on a branch of its own. Create one, then present the plan again.',
    );
  });
});

describe('on turn-end, said in full', () => {
  it('says the freeze in full while implementing', () => {
    approve();
    expect(turnEnd()).toEqual({
      version: 1,
      keepWorking: false,
      messages: [message('run_triage', 'agent', 'Nothing is verified while the implementation is in progress, and a red suite is expected here. '
        + 'Run `workflow triage` once the implementation is complete. It will say what actually broke.')],
    });
    put('a.test.mjs', 'export {};\n');
    expect(turnEnd()).toEqual({
      version: 1,
      keepWorking: true,
      // The freeze is said in the rulebook's own globs, which the fixture
      // takes from this repository's.
      messages: [message('frozen', 'agent', `Every test file (${globs(repositoryRulebook().tests.paths.all)}) and every test support file (${globs(FIXTURE_ADAPTER.tests.paths.support)}) are frozen until the triage has run. These differ from the baseline:\n\n  a.test.mjs\n\n`
        + 'Unwind them, then run `workflow triage`. The freeze is what makes the triage mean something: '
        + 'every failure it reports was caused by the implementation and nothing else. A test written '
        + 'beside the code it covers, before anyone has seen what broke, only shows that the two agree.')],
    });
  });

  // One file per line. With a single file the separator never shows.
  it('lists every frozen file it found, one per line', () => {
    approve();
    put('a.test.mjs', 'export {};\n');
    put('b.test.mjs', 'export {};\n');
    expect(goesOn(turnEnd())).toContain('These differ from the baseline:\n\n  a.test.mjs\n  b.test.mjs\n\n');
  });

  it('says the freeze in full for a test-only change', () => {
    approve(TEST_ONLY);
    expect(turnEnd()).toEqual({
      version: 1,
      keepWorking: false,
      messages: [message('run_triage', 'agent', 'This change is declared test-only, so there is no implementation to wait for. Run `workflow triage` now: '
        + 'it has to find the suite green before new tests land on top of it. Then write them.')],
    });
    put('a.test.mjs', 'export {};\n');
    expect(goesOn(turnEnd())).toMatch(/\n\nThis change is declared test-only, so the triage runs first, on the tree as it stood before your work: all it has to find is a green suite\. Unwind these, run `workflow triage`, and then write them\.$/);
  });

  it('says the triage\'s counts and names, and stops at its link', () => {
    approve();
    triage({
      level: 'HIGH', reasons: ['Raised to HIGH by surprise failures: 1 against 4 predicted, 20% or more.'],
      predicted: { failed: 3, total: 4 },
      surprise: { failed: 1, total: 90, failures: ['x.test.mjs — broke (expected 1)'], names: ['x.test.mjs — broke'] },
      overPredicted: { count: 1, total: 4, tests: ['y.test.mjs — passed'] },
      notRun: { predicted: ['p.test.mjs'], unpredicted: [] },
    });
    setVerify(true);
    const text = ends(turnEnd(true));
    const link = 'Details: ' + join(ctx.logbook.slice(ctx.repo.length + 1), events().find(name => name.endsWith('__triaged.json')));
    const report = text.slice(0, text.indexOf('\n\nVerification passed'));
    expect(report).toContain('Risk: HIGH\nRaised to HIGH by surprise failures: 1 against 4 predicted, 20% or more.\n94 tests ran, 4 failed\npredicted 3/4 failed · 1 surprise (25%) · 1 over-prediction (25%)');
    expect(report).toContain('\nSurprises:\nx.test.mjs — broke\n');
    expect(report).toContain('\nOver-predictions:\ny.test.mjs — passed\n');
    expect(report).not.toContain('expected 1');
    // Predicted failures are counted, never named. A predicted file that
    // never ran is named all the same: none of its tests said anything.
    expect(report).toContain('\nPredicted files that never ran:\np.test.mjs\n');
    // The agent's next steps are printed by the triage command, not sent here.
    expect(report).not.toContain('Next:');
    expect(report).not.toContain('The implementation is frozen');
    expect(report.endsWith(`\n\n${link}`)).toBe(true);
  });

  it.each([true, false])('shows the recorded counts at turn end when the selected triage snapshot is available: %s', available => {
    approve();
    const identities = { tests: [{ file: 'suite', titles: ['surprise'] }], unlisted: ['omitted'] };
    const measured = {
      predicted: { failed: 0, total: 0 }, surprise: { failed: 2, total: 2, failures: ['suite — surprise (boom)'], names: ['suite — surprise'] },
      overPredicted: { count: 0, total: 0, tests: [] }, notRun: { predicted: [], unpredicted: ['omitted'] },
    };
    const snapshot = writeTriageSnapshot('feat/x', identities, measured, ctx.repo);
    const event = append(ctx.logbook, 'triaged', { treeFingerprint: treeNow(), implementationFingerprint: inFixture(current).implementationFingerprint, level: 'HIGH', reasons: ['Raised to HIGH by surprise failures: 2 against 0 predicted, 20% or more.'], implemented: true, ...snapshot }, 'feat/x');
    if (!available) rmSync(join(ctx.repo, analysisPath(snapshot)));
    setVerify(true);
    const text = ends(turnEnd(true));
    // The counts are the event's, so they read the same either way. The names
    // are the snapshot's: without it, the report says why it cannot name them.
    expect(text).toContain('Risk: HIGH\nRaised to HIGH by surprise failures: 2 against 0 predicted, 20% or more.\n2 tests ran, 2 failed');
    if (available) expect(text).toContain('\nSurprises:\nomitted — never ran\nsuite — surprise\n');
    else {
      expect(text).toContain(`\nThe tests cannot be named: triage ${event.seq} ${analysisPath(snapshot)}: `);
      expect(text).not.toContain('suite — surprise');
    }
    expect(text).toMatch(/\n\nDetails: \.katatay\/state\/[^\n]+__triaged\.json/);
  });

  // The triage is said once, on the turn it was recorded.
  it('does not repeat the triage, or ask for it to be relayed, on a later failing pass', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    put('retry.test.mjs', '// an attempted fix\n');
    const failed = turnEnd();
    expect(codes(failed)).toEqual(['verify_failed/operator', 'info/agent']);
    expect(goesOn(failed)).toMatch(/^Verification failed\./);
    expect(failed.messages[1].text).toMatch(/^`workflow verify` failed on the current working tree\.\n\nCheck the failing tests\. If the triaged implementation needs a fix, present a revised plan\. Never weaken a requirement or delete its evidence to get this green\.\n\n/);
  });

  // Verify would fail the same way again, and it can take minutes. So on any
  // turn end, not only the one after a refused stop, it waits for something
  // it reads to change, and says the stored failure again.
  it('does not run verify again on any turn end while nothing has changed since it failed', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    const again = turnEnd();
    expect(codes(again)).toEqual(['verify_failed/operator', 'info/agent']);
    // The summary is rebuilt from the stored failure, and says verify did not run.
    expect(again.messages[0].text).toMatch(/^Verification failed\.\n[\s\S]*\nWarnings:\nVerify was not run again: the working tree, the rulebook and the baseline\n/);
    expect(again.messages[0].text).toMatch(/\nDetails: \.katatay\/state\/feat_x\/\d{4}__verify_failed\.json$/);
    expect(again.messages[1].text).toMatch(/^`workflow verify` still fails: the working tree has not changed since it failed, and neither has the rulebook or the baseline, so it was not run again\. The failure stands:\n\n/);
    expect(said(again)).toMatch(/verify: failed at/);
    expect(eventNamed('verify_failed')).toHaveLength(1);
    expect(ends(turnEnd(true))).toMatch(/still fails/);
    expect(eventNamed('verify_failed')).toHaveLength(1);
  });

  it('retries an unchanged failure after a successful re-triage, even after a convergence request', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    append(ctx.logbook, 'triage_refused', { reason: 'measurement_changed', evidence: [] }, 'feat/x');
    expect(goesOn(turnEnd())).toContain('still fails');
    expect(eventNamed('verify_failed')).toHaveLength(1);
    const next = triage();
    append(ctx.logbook, 'convergence_requested', { triage: next.seq, reply: 'a'.repeat(64) }, 'feat/x');
    turnEnd();
    expect(eventNamed('verify_failed')).toHaveLength(2);
  });

  it('runs verify again when the tree has changed since it failed', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    put('retry.test.mjs', '// an attempted fix\n');
    expect(ends(turnEnd(true))).toMatch(/^Verification failed\.[\s\S]*\n\n`workflow verify` failed on the current working tree/);
    expect(eventNamed('verify_failed')).toHaveLength(2);
  });

  // The rulebook is outside the tree fingerprint, so a fix there, such as a
  // coverage minimum, would otherwise never be verified until a file changed.
  it('runs verify again when the rulebook has changed since it failed', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    setMutation({ timeLimitSeconds: 239 });
    expect(goesOn(turnEnd())).toMatch(/^Verification failed\.[\s\S]*\n\n`workflow verify` failed on the current working tree/);
    expect(eventNamed('verify_failed')).toHaveLength(2);
  });

  it('keeps the failure when a baseline move names the same commit', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    const pinned = readBaseline(read(eventNamed('plan_approved')[0]).payload.baseline);
    append(ctx.logbook, 'baseline_moved', { from: pinned, to: pinned }, 'feat/x');
    expect(goesOn(turnEnd())).toContain('Verify was not run again');
    expect(eventNamed('verify_failed')).toHaveLength(1);
  });

  it('retries the same failing tree after the target advances by an empty commit', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    const first = read(eventNamed('verify_failed')[0]);
    git('commit', '--quiet', '--allow-empty', '-m', 'new baseline');
    publish();
    turnEnd();
    expect(eventNamed('verify_failed')).toHaveLength(2);
    const second = read(eventNamed('verify_failed')[1]);
    expect(second.payload).toMatchObject({ treeFingerprint: first.payload.treeFingerprint,
      rulebookFingerprint: first.payload.rulebookFingerprint, baseline: git('rev-parse', 'HEAD').trim() });
    expect(readBaseline(second.payload.baseline)).not.toBe(readBaseline(first.payload.baseline));
  });

  // The latest of the two says what the tree does now, so a pass in between
  // ends the failure's hold even when the tree comes back to the one that
  // failed.
  it('runs verify again when a pass came after the failure', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    setVerify(true);
    expect(ends(turnEnd())).toMatch(/(^|\n)Verification passed\.\n/);
    setVerify(false);
    expect(goesOn(turnEnd())).toMatch(/^Verification failed\.[\s\S]*\n\n`workflow verify` failed on the current working tree/);
    expect(eventNamed('verify_failed')).toHaveLength(2);
  });

  it('runs verify again after a failure recorded without the rulebook\'s hash', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    const [failed] = eventNamed('verify_failed');
    expect(read(failed).payload.rulebookFingerprint).toMatch(/^[0-9a-f]{64}$/);
    append(ctx.logbook, 'verify_failed', { treeFingerprint: treeNow(), baseline: readBaseline(read(failed).payload.baseline), rulebookFingerprint: null, results: read(failed).payload.results, tail: 'rulebook unavailable' }, 'feat/x');
    expect(goesOn(turnEnd())).toMatch(/^Verification failed\.[\s\S]*\n\n`workflow verify` failed on the current working tree/);
  });

  it('runs verify after a refused stop when the last event was not a failure, whatever its tree', () => {
    approve();
    setVerify(true);
    triage({ treeFingerprint: treeNow() });
    expect(ends(turnEnd(true))).toMatch(/(^|\n)Verification passed\.\n/);
  });

  // More work after a refused stop could hold the turn in a loop. Only a
  // delivered pass earlier in the turn earns a failure one more.
  it('lets the turn end on a failure after a refused stop when no pass came before it', () => {
    approve();
    triage();
    setVerify(false);
    expect(ends(turnEnd(true))).toMatch(/`workflow verify` failed on the current working tree/);
  });

  it('passes on the end of what verify printed, and keeps it in the logbook', () => {
    approve();
    triage();
    setVerify(false);
    expect(goesOn(turnEnd())).toMatch(/verify: failed at/);
    const [failed] = eventNamed('verify_failed');
    expect(read(failed).payload.tail).toMatch(/verify: failed at/);
    expect(read(failed).payload.treeFingerprint).toBe(treeNow());
  });

  it('names the review areas when the change has some, and says nothing of them when it has none', () => {
    approve();
    triage();
    setVerify(true);
    expect(ends(turnEnd())).not.toContain('Review:');
    approve('# Revised plan\nInclude a guarded file.');
    put('guarded/check.mjs', 'export {};\n');
    triage();
    // Each reason, then its files, under the summary's heading.
    expect(ends(turnEnd())).toContain('\n\nReview:\nGuarded. Read them whatever the tests say.\n- guarded/check.mjs\n');
  });

  it('says in full which files a test-only change touched, and nothing of the kind for an ordinary change', () => {
    approve(TEST_ONLY);
    put('feature.mjs', 'export const on = true;\n');
    triage();
    setVerify(true);
    const [verified] = turnEnd().messages.filter((m) => m.code === 'verified');
    expect(verified).toMatchObject({ for: 'operator', text: expect.stringContaining('\nWarnings:\nThe plan declared this change test-only, and these are not tests:\nfeature.mjs\n') });
  });

  it('says nothing about test-only on an ordinary change', () => {
    approve();
    put('feature.mjs', 'export const on = true;\n');
    triage();
    setVerify(true);
    expect(said(turnEnd())).not.toContain('these are not tests');
  });

  it('moves the baseline when the target was merged in during the turn', () => {
    approve();
    targetGainsATest();
    git('merge', '--quiet', '--no-edit', 'origin/main');
    turnEnd();
    expect(eventNamed('baseline_moved')).toHaveLength(1);
  });
});

describe('writes on either side of triage', () => {
  it('rejects a batch containing a frozen path, and leaves bookkeeping writable', () => {
    approve();
    const tests = edit('tests/helper.mjs');
    const code = edit('source.txt');
    const batch = { ...tests, writes: [...code.writes, ...tests.writes] };
    expect(codes(write(batch))).toEqual(['frozen/agent']);
    expect(write(code)).toEqual(allowed);
    const before = inFixture(() => current());
    triage({ treeFingerprint: before.treeFingerprint, implementationFingerprint: before.implementationFingerprint });
    expect(write(tests)).toEqual(allowed);
    expect(codes(write(batch))).toEqual(['frozen/agent']);
    expect(write(edit('requirements/changes/20261103T000000.000Z__change.md'))).toEqual(allowed);
    expect(write(edit('reports/ignored-output'))).toEqual(allowed);
    put('source.txt', 'bypassed the file gate');
    expect(inFixture(() => current()).next[0]).toContain('Restore the triaged implementation');
    expect(prompt('record')).toContain('Restore the triaged implementation');
    expect(said(turnEnd())).toContain('approve a revised plan');
    expect(started).toHaveLength(0);
    expect(eventNamed('record_held')).toHaveLength(0);
    expect(eventNamed('declared')).toHaveLength(0);
  });
});

it('tells the operator the triage, and the agent how to handle a failed verify', () => {
  approve();
  setVerify(false);
  const before = inFixture(() => current());
  triage({ treeFingerprint: before.treeFingerprint, implementationFingerprint: before.implementationFingerprint });
  const { messages } = turnEnd();
  expect(messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'triaged', for: 'operator', text: expect.stringMatching(/^Triage of plan's missed predictions and test regressions\./) }),
    expect.objectContaining({ code: 'verify_failed', for: 'operator', text: expect.stringMatching(/^Verification failed\.\n/) }),
    expect.objectContaining({ code: 'info', for: 'agent', text: expect.stringContaining('If the triaged implementation needs a fix, present a revised plan') }),
  ]));
  expect(eventNamed('verified')).toHaveLength(0);
});
