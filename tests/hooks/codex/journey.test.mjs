/**
 * A change taken through the whole loop under Codex: the real Codex hooks,
 * started as processes with captured payloads, against the machine suite's
 * fixture repository and its real referee.
 *
 * This is the repeatable half of step 16's proof that a second agent needs no
 * referee edit. The live half is a real change done in Codex. The fixture is
 * the one `tests/support/machine/harness.mjs` builds for the Claude hooks,
 * with its stub language adapter, so verify is quick and nothing of this
 * repository's own suite runs inside it.
 *
 * The hooks are spawned rather than called, because the spawn is the contract
 * under test: what Codex hands a hook on stdin and reads from its stdout.
 */
import { describe, expect, it } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { submitFixtureAnalysis, ctx, events, git, machineFixture, phase, reportedChangeFile, triage } from '../../support/machine/harness.mjs';
import { payload, transcript } from '../../fixtures/codex/payloads.mjs';

machineFixture();

const HOOKS = resolve('src/agents/codex/hooks');

/**
 * A Codex hook, started the way Codex starts it: in the session's directory,
 * with the payload on stdin. Its home is the case's, so the plans folder and
 * transcripts it reads are never the operator's. Returns the parsed answer, or
 * null when it printed nothing.
 */
const codex = (script, sent) => {
  if (!ctx.repo || !ctx.home) throw new Error('no fixture repository — refusing to run against the real one');
  const run = spawnSync(process.execPath, [join(HOOKS, script)], {
    cwd: sent.cwd, input: JSON.stringify(sent), encoding: 'utf8', env: { ...process.env, HOME: ctx.home },
  });
  if (run.status !== 0) throw new Error(`${script} exited ${run.status}: ${run.stderr}`);
  return run.stdout.trim() === '' ? null : JSON.parse(run.stdout);
};

/** A captured payload, in this case's repository and home. */
const sent = (name, overrides = {}) => payload(name, overrides, { home: ctx.home, repo: ctx.repo });

/** A patch Codex is about to apply. */
const patch = (body, overrides = {}) => codex('pre-tool.mjs', sent('pre-tool-use-apply-patch', { tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` }, ...overrides }));

/** The operator's prompt. */
const prompt = (name, overrides = {}) => codex('user-prompt.mjs', sent(name, overrides));

/** The end of the agent's turn. */
const stop = (overrides = {}) => codex('turn-end.mjs', sent('stop', overrides));

/** Run Stop without waiting for it, so another real hook can overlap it. */
const concurrentStop = (overrides = {}) => new Promise((resolve, reject) => {
  if (!ctx.repo || !ctx.home) throw new Error('Stop needs a fixture repository');
  const child = execFile(process.execPath, [join(HOOKS, 'turn-end.mjs')], {
    cwd: ctx.repo, env: { ...process.env, HOME: ctx.home },
  }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
  child.stdin.end(JSON.stringify(sent('stop', overrides)));
});

/** The captured transcript, put where the approval payload says it is. */
const placeTranscript = (name = 'transcript-plan-approved') => {
  const path = sent('user-prompt-submit-approval').transcript_path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, transcript(name, { home: ctx.home, repo: ctx.repo }));
  return path;
};

/**
 * The plan texts the captures hold, worked out here rather than with
 * `approval.mjs`. This test reaches the code only through the hooks it
 * starts, so it imports none of it, and mutation testing leaves it out: no
 * mutant can be caught from another process, and Stryker would otherwise run
 * this slow test for nothing (see `src/adapters/typescript/process-only.ts`).
 */
const lastPlanIn = (text) => `${text.trim().split('\n').map((line) => JSON.parse(line))
  .filter((e) => e.type === 'event_msg' && e.payload.item?.type === 'Plan').at(-1).payload.item.text.trimEnd()}\n`;
const planInPrompt = (text) => `${text.slice(text.indexOf('\n\n') + 2).trimEnd()}\n`;

/** The plan files in the fixture rulebook's plans folder. */
const plansFolder = () => join(ctx.home, '.claude/plans');
const plans = () => (existsSync(plansFolder()) ? readdirSync(plansFolder()) : []);

describe('a change under Codex', () => {
  it('goes from an approved plan to a recorded change', () => {
    // A `main` for the change file to be new against, as the machine suite's verified template has.
    git('checkout', '--quiet', '-b', 'main');
    git('checkout', '--quiet', 'feat/x');

    // 1. With no plan, a patch is denied, in Codex's words.
    const denied = patch('*** Update File: source.txt\n@@\n-original\n+changed');
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(/Plan mode/);
    expect(phase()).toBe('open');

    // 2. "Yes, implement this plan" approves the last plan in the transcript.
    const path = placeTranscript();
    const approved = prompt('user-prompt-submit-approval');
    expect(phase()).toBe('implementing');
    expect(plans()).toHaveLength(1);
    expect(plans()[0]).toMatch(/^[a-z]+-[a-z]+-[a-z]+\.md$/);
    expect(readFileSync(join(plansFolder(), plans()[0]), 'utf8')).toBe(lastPlanIn(readFileSync(path, 'utf8')));
    expect(events().some((e) => e.endsWith('__plan_approved.json'))).toBe(true);
    expect(approved.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(approved.hookSpecificOutput.additionalContext).toMatch(/implementing/);
    expect(approved.systemMessage).toBeDefined();

    const repeatApproval = (expectedPhase) => {
      const before = events();
      const result = prompt('user-prompt-submit-approval');
      expect(result.systemMessage).toContain('already approved');
      expect(events()).toEqual(before);
      expect(phase()).toBe(expectedPhase);
    };
    repeatApproval('implementing');

    // 3. While implementing, a patch is allowed. A test written now is caught at the stop.
    expect(patch('*** Update File: source.txt\n@@\n-original\n+changed')).toBe(null);
    writeFileSync(join(ctx.repo, 'source.txt'), 'changed\n');
    writeFileSync(join(ctx.repo, 'feature.test.mjs'), 'test\n');
    const frozen = stop();
    expect(frozen.decision).toBe('block');
    expect(frozen.reason).toMatch(/feature\.test\.mjs/);
    rmSync(join(ctx.repo, 'feature.test.mjs'));

    // 4. The triage, recorded as the CLI records it.
    triage();
    expect(phase()).toBe('converging');
    repeatApproval('converging');

    // 5. Codex edits without posting triage. The verification reply must carry both reports.
    writeFileSync(join(ctx.repo, 'feature.test.mjs'), '// fixed before posting triage\n');
    const verified = stop();
    expect(phase()).toBe('verified');
    repeatApproval('verified');
    expect(verified.decision).toBe('block');
    expect(verified.reason).toMatch(/Triage of plan's missed predictions and test regressions[\s\S]*\nVerification passed\.\n/);
    expect(verified.systemMessage).toBeUndefined();
    const afterVerification = events();
    expect(stop({ stop_hook_active: true }).decision).toBeUndefined();
    expect(events()).toEqual(afterVerification);

    // 6. The operator's `record` declares the change and shows them the report.
    expect(verified.reason).toContain('Recommend specific tests and code quality improvements');
    const missing = prompt('user-prompt-submit', { prompt: 'record' });
    expect(missing.hookSpecificOutput.additionalContext).toContain('needs its checks analysis');
    expect(phase()).toBe('verified');
    submitFixtureAnalysis();
    const declared = prompt('user-prompt-submit', { prompt: 'record' });
    expect(phase()).toBe('declared');
    repeatApproval('declared');
    expect(declared.systemMessage).toBeDefined();

    // 7 and 8. The change file is written, and the stop records and stages the change.
    mkdirSync(join(ctx.repo, 'requirements/changes'), { recursive: true });
    writeFileSync(join(ctx.repo, 'requirements/changes/20260908T000000.000Z__x.md'), reportedChangeFile());
    const recorded = stop();
    expect(phase()).toBe('recorded');
    repeatApproval('recorded');
    expect(recorded.decision).toBe('block');
    // The agent is asked for the commit message, in Codex's words, and the operator waits for it.
    expect(recorded.reason).toMatch(/Write the commit message now/);
    expect(recorded.reason).toMatch(/commit-message/);
    expect(git('diff', '--cached', '--name-only')).toContain('requirements/changes/20260908T000000.000Z__x.md');

    // 9. A lost handoff is recovered: `record` again asks for the commit message and adds nothing.
    const recordedEvents = events();
    const again = prompt('user-prompt-submit', { prompt: 'record' });
    expect(again.hookSpecificOutput.additionalContext).toMatch(/Nothing new was declared[\s\S]*Write the commit message now[\s\S]*commit-message/);
    expect(events()).toEqual(recordedEvents);
    expect(phase()).toBe('recorded');

    // Codex needs JSON from a Stop hook, even with nothing to say.
    expect(stop({ stop_hook_active: true })).toEqual(expect.any(Object));
  });

  it('is approved by "Yes, clear context and implement", from the plan in the prompt', () => {
    const { prompt: text } = sent('user-prompt-submit-clear-context');
    prompt('user-prompt-submit-clear-context');
    expect(phase()).toBe('implementing');
    expect(plans()).toHaveLength(1);
    expect(readFileSync(join(plansFolder(), plans()[0]), 'utf8')).toBe(planInPrompt(text));
  });

  it('continues one triage reply and later relays one verification when the Stops overlap', async () => {
    placeTranscript();
    prompt('user-prompt-submit-approval');
    writeFileSync(join(ctx.repo, 'feature.mjs'), 'export const on = true;\n');
    // Use the real triage receipt, including the fingerprint of this fixture.
    execFileSync(process.execPath, [resolve('src/workflow/cli/workflow.mjs'), 'triage'], {
      cwd: ctx.repo, env: { ...process.env, HOME: ctx.home }, stdio: 'pipe',
    });
    const reply = { last_assistant_message: '**Triage recorded**\n\nAll tests passed.' };
    const handoffs = await Promise.all([concurrentStop(reply), concurrentStop(reply)]);
    expect(handoffs.filter(out => out.decision === 'block').map(out => out.reason))
      .toEqual([expect.stringContaining('Continue the approved work now')]);
    expect(handoffs).toContainEqual({});
    expect(events()).toEqual(['0001__plan_approved.json', '0002__triaged.json', '0003__convergence_requested.json']);
    writeFileSync(join(ctx.repo, 'feature.test.mjs'), "import assert from 'node:assert/strict';\nimport { on } from './feature.mjs';\nassert.equal(on, true);\n");

    const file = join(ctx.repo, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    // Hold the first Stop inside verify until the second Stop has started.
    // The bounded wait also lets the fixture shut down after a test failure.
    const gate = join(ctx.home, 'gate.mjs');
    writeFileSync(gate, `import { appendFileSync, existsSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      appendFileSync(new URL('runs', import.meta.url), 'verify\\n');
      const deadline = Date.now() + 10000;
      while (!existsSync(new URL('release', import.meta.url)) && Date.now() < deadline) await setTimeout(20);
    `);
    config.tests.run.command = `node "$HOME/gate.mjs" && ${config.tests.run.command}`;
    config.checks.testQuality.mutation.command = `echo mutate >> "$HOME/runs" && ${config.checks.testQuality.mutation.command}`;
    writeFileSync(file, JSON.stringify(config));
    const runs = join(ctx.home, 'runs');
    const first = concurrentStop();
    // Reaching the fixture's test command starts the hook, the referee and
    // verify. On a full suite that can exceed Vitest's one-second poll.
    await expect.poll(() => existsSync(runs), { timeout: 15_000 }).toBe(true);
    const second = concurrentStop();
    writeFileSync(join(ctx.home, 'release'), '');

    const outputs = await Promise.all([first, second]);
    const relays = outputs.filter((out) => out.decision === 'block');
    expect(relays).toHaveLength(1);
    expect(relays[0].reason).toContain('\nVerification passed.\n');
    expect(relays[0].reason).not.toContain("Triage of plan's missed predictions");
    expect(relays[0].reason).toMatch(/\nmutation: [A-Z]+\n/);
    expect(outputs.some((out) => out.systemMessage?.includes('Verification passed.\n'))).toBe(false);
    const recorded = events();
    expect(recorded).toEqual(['0001__plan_approved.json', '0002__triaged.json', '0003__convergence_requested.json',
      '0004__verified.json']);
    const verified = JSON.parse(readFileSync(join(ctx.logbook, '0004__verified.json'), 'utf8')).payload;
    expect(verified.results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).find((result) => result.name === 'mutation')).toMatchObject({ status: 'ok', summary: { unproved: 0, errored: 0 },
      evidence: [{ role: 'raw', snapshot: expect.any(String) }, { role: 'analysis', snapshot: expect.any(String) }] });
    expect(stop({ stop_hook_active: true }).decision).toBeUndefined();
    expect(events()).toEqual(recorded);
    expect(readFileSync(runs, 'utf8')).toBe('verify\nmutate\n');
  });

  it('records nothing, and tells the operator, when the thread holds no plan', () => {
    placeTranscript('transcript-clear-context');
    const answered = prompt('user-prompt-submit-approval');
    expect(phase()).toBe('open');
    expect(plans()).toEqual([]);
    expect(answered.systemMessage).toMatch(/no approval was recorded/);
    expect(answered.hookSpecificOutput.additionalContext).toMatch(/no approval was recorded/);
  });

  // Synthetic desktop approval prompts based on the observed message, not captured hook payloads.
  it('saves the embedded plan and records its declarations even when the transcript contains another plan', () => {
    placeTranscript();
    const body = '# New plan\n\nUse the supplied text.\n\n```workflow\npredicted-failures: ["example.test.mjs"]\n```\n';
    const answered = prompt('user-prompt-submit', { prompt: 'PLEASE IMPLEMENT THIS PLAN:\n' + body, turn_id: undefined });
    expect(answered.systemMessage).toMatch(/approval recorded/i);
    const grant = JSON.parse(readFileSync(join(ctx.logbook, events()[0]), 'utf8')).payload;
    expect(grant).not.toHaveProperty('planFile');
    expect(plans()).toHaveLength(1);
    expect(readFileSync(join(plansFolder(), plans()[0]), 'utf8')).toBe(body);
    expect(answered.hookSpecificOutput.additionalContext).toContain(grant.planSnapshot);
    expect(answered.hookSpecificOutput.additionalContext).toContain('read the approved plan from this snapshot');
    expect(readFileSync(join(ctx.repo, grant.planSnapshot), 'utf8')).toBe(body);
    expect(grant).not.toHaveProperty('predictedFailures');
  });

  it('uses the latest plan for a blank prefixed approval even after discussion', () => {
    const path = placeTranscript();
    const old = readFileSync(path, 'utf8');
    writeFileSync(path, old + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'other', item: { type: 'AgentMessage', text: 'Discussion.' } } }));
    const answered = prompt('user-prompt-submit', { prompt: 'PLEASE IMPLEMENT THIS PLAN:\n  ', turn_id: undefined });
    expect(answered.systemMessage).toMatch(/approval recorded/i);
    expect(readFileSync(join(plansFolder(), plans()[0]), 'utf8')).toBe(lastPlanIn(old));
  });

  it('reports an empty approval with no plan source without recording anything', () => {
    const answered = prompt('user-prompt-submit', { prompt: 'PLEASE IMPLEMENT THIS PLAN:', transcript_path: undefined });
    expect(answered.systemMessage).toMatch(/no approval was recorded/);
    expect(events()).toEqual([]);
    expect(plans()).toEqual([]);
    expect(phase()).toBe('open');
  });

  it('warns the operator when Codex runs with approvals off', () => {
    expect(prompt('user-prompt-submit-exec').systemMessage).toMatch(/approvals off/);
    expect(prompt('user-prompt-submit').systemMessage ?? '').not.toMatch(/approvals off/);
  });

  // Codex starts a hook in the session's directory, which may be a subfolder.
  it('finds the repository from a subfolder', () => {
    mkdirSync(join(ctx.repo, 'sub'));
    const denied = patch('*** Add File: ../.katatay/forged.json\n+{}', { cwd: join(ctx.repo, 'sub') });
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(prompt('user-prompt-submit', { cwd: join(ctx.repo, 'sub') }).hookSpecificOutput.additionalContext).toMatch(/open/);
  });

  // A move out of the requirements folder deletes the requirement there.
  it('refuses a patch that moves a requirement away, whatever the phase', () => {
    prompt('user-prompt-submit-clear-context');
    const denied = patch('*** Update File: requirements/AC0001.md\n*** Move to: elsewhere/AC0001.md\n@@\n-a\n+a');
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

// These variants keep the captured platform fixtures intact. A Plan turn's
// real Stop capture has last_assistant_message:null; only the structured item
// identifies its plan (see the fixture README's timing note).
describe('presenting a plan through the Codex Stop hook', () => {
  const valid = '# A plan\n\n## Why\nNeed.\n\n## What\nBehaviour.\n\n## How\nDesign.\n\n## Requirements\nNone.\n\n## Predicted failures\nNone.\n\n## Test delta\nNew tests.\n';
  const present = (text) => {
    const path = placeTranscript();
    const entries = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const plan = entries.findLast((e) => e.payload?.item?.type === 'Plan');
    plan.payload.item.text = text;
    // Stop runs before task_complete, so this is the transcript prefix its
    // capture selects, not later approval and implementation turns.
    writeFileSync(path, entries.slice(0, entries.indexOf(plan) + 1).map((e) => JSON.stringify(e)).join('\n') + '\n');
    return { transcript_path: path, turn_id: plan.payload.turn_id, last_assistant_message: null };
  };

  it('saves the current plan, lets the referee reject it, and accepts its correction without approval', () => {
    const invalid = stop(present('## Why\n{{WHY}}\n'));
    expect(invalid.decision).toBe('block');
    expect(invalid.reason).toContain('section What is missing');
    expect(phase()).toBe('open');
    expect(plans()).toHaveLength(1);
    expect(readFileSync(join(plansFolder(), plans()[0]), 'utf8')).toBe('## Why\n{{WHY}}\n');
    const again = stop({ ...present('## Why\n{{WHY}}\n'), stop_hook_active: true });
    expect(again.decision).toBeUndefined();
    expect(again.systemMessage).toContain('section What is missing');
    const corrected = stop(present(valid));
    expect(corrected.decision).toBeUndefined();
    expect(corrected.systemMessage).toBeUndefined();
    expect(phase()).toBe('open');
    expect(events()).toEqual([]);
    const approved = prompt('user-prompt-submit-approval', { prompt: '`Approved!`', turn_id: 'approval-turn' });
    expect(approved.systemMessage).toMatch(/approval recorded/i);
    expect(phase()).toBe('implementing');
  });

  it('does not validate an older plan at an ordinary turn end', () => {
    const current = present('Invalid older plan.');
    expect(stop({ ...current, turn_id: 'ordinary-turn' }).systemMessage).toContain('may have presented a plan');
    expect(stop({ ...current, turn_id: 'ordinary-turn', last_assistant_message: 'Done.' })).toEqual({});
    expect(plans()).toEqual([]);
  });

  it('preserves the operator’s approval edits independently of the presented plan and later working edits', () => {
    expect(stop(present(valid)).decision).toBeUndefined();
    expect(events()).toEqual([]);
    const approvedText = valid.replace('New tests.', 'Exercise the retry after publication fails.');
    const reply = prompt('user-prompt-submit', { prompt: 'PLEASE IMPLEMENT THIS PLAN:\n' + approvedText });
    expect(reply.systemMessage).toMatch(/approval recorded/i);
    const { payload } = JSON.parse(readFileSync(join(ctx.logbook, events()[0]), 'utf8'));
    expect(payload).not.toHaveProperty('planFile');
    const inputFile = plans().map(name => join(plansFolder(), name))
      .find(file => readFileSync(file, 'utf8') === approvedText);
    expect(inputFile).toBeDefined();
    writeFileSync(inputFile, valid);
    expect(readFileSync(join(ctx.repo, payload.planSnapshot), 'utf8')).toBe(approvedText);
    const later = prompt('user-prompt-submit', { prompt: 'Continue the approved work.' });
    expect(later.hookSpecificOutput.additionalContext).toContain(payload.planSnapshot);
    expect(later.hookSpecificOutput.additionalContext).not.toContain(inputFile);
    expect(later.hookSpecificOutput.additionalContext).not.toContain('has changed since');
  });

  it('reports capture errors without refusing either Stop', () => {
    const result = stop();
    expect(result.decision).toBeUndefined();
    expect(result.systemMessage).toMatch(/transcript.*could not be read/);
    expect(stop({ stop_hook_active: true }).decision).toBeUndefined();
    expect(phase()).toBe('open');
  });

  it.each(['unreadable transcript', 'missing turn_id'])('still verifies and warns for %s on either Stop', (problem) => {
    placeTranscript();
    prompt('user-prompt-submit-approval');
    writeFileSync(join(ctx.repo, 'source.txt'), 'changed\n');
    triage();
    const extra = problem === 'missing turn_id' ? { turn_id: undefined }
      : { transcript_path: join(ctx.home, 'missing-transcript.jsonl') };
    const warning = problem === 'missing turn_id' ? /no transcript_path or turn_id/ : /transcript.*could not be read/;
    for (const stop_hook_active of [false, true]) {
      // A new tree makes the second Stop verify too, rather than merely
      // showing the receipt left by the first.
      writeFileSync(join(ctx.repo, 'feature.test.mjs'), `// changed ${stop_hook_active}\n`);
      const result = stop({ ...extra, stop_hook_active });
      expect(result.decision).toBe('block');
      expect(result.reason).toMatch(warning);
      expect(result.reason).toContain('Verification passed');
      expect(result.systemMessage ?? '').not.toContain('Verification passed');
      expect(phase()).toBe('verified');
    }
    expect(events().filter(e => e.endsWith('__verified.json'))).toHaveLength(2);
  });
});
