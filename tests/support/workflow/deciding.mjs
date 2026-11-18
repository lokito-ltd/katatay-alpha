import { beforeEach, expect } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ctx, fixtureChecks, planFile, triage } from '../machine/harness.mjs';
import { sha256 } from '../../../src/workflow/chain.mjs';
import { current } from '../../../src/workflow/state.mjs';
import { mayWrite } from '../../../src/workflow/moments/write.mjs';
import { onPrompt } from '../../../src/workflow/moments/prompt.mjs';
import { onPlanApproved } from '../../../src/workflow/moments/plan-approved.mjs';
import { VERIFY, onTurnEnd } from '../../../src/workflow/moments/turn-end.mjs';
import { runReferee } from '../../../src/workflow/runtime.mjs';

export function inFixture(decide) {
  const cwd = process.cwd();
  const home = process.env.HOME;
  process.chdir(ctx.repo);
  try {
    if (realpathSync(process.cwd()) !== realpathSync(ctx.repo)) throw new Error('not in the fixture repository — refusing to decide anything');
    process.env.HOME = ctx.home;
    return decide();
  } finally {
    process.chdir(cwd);
    process.env.HOME = home;
  }
}

/** Every referee command a moment started in this case, in order. */
export let started = [];
beforeEach(() => { started = []; });

/**
 * The referee's commands as the moments start them, with verify answered from
 * the fixture's test outcomes, as the fixture adapter's `runTests` stub makes
 * the real verify answer. A failure ends with the line the real one prints.
 */
export const referee = (file, args = [], options = {}) => {
  started.push({ file, args });
  if (file !== VERIFY) return runReferee(file, args, options);
  const { outcomes } = JSON.parse(readFileSync(join(ctx.repo, 'outcomes.json'), 'utf8'));
  const failed = outcomes.filter((o) => o.failed);
  if (!failed.length) writeFileSync(args[args.indexOf('--results') + 1], JSON.stringify({ results: fixtureChecks() }));
  return failed.length === 0
    ? { status: 0, stdout: 'verify: passed.\n', stderr: '' }
    : { status: 1, stdout: failed.map((o) => `FAIL ${o.file} > ${o.title}`).join('\n'), stderr: '\nverify: failed at tests.\n' };
};

export const write = (input) => inFixture(() => mayWrite(input));
export const edit = (path = 'source.txt') => ({ writes: [{ path, delete: false }], command: null });

/** The messages' texts, joined the way the Claude adapter shows them. */
export const said = (answer, between = '\n\n') => answer.messages.map((m) => m.text).join(between);
/** The messages as `code/for`, which is what an adapter branches on. */
export const codes = (answer) => answer.messages.map((m) => `${m.code}/${m.for}`);
export const message = (code, audience, text) => ({ code, for: audience, text });
/** Globs as a message names them: each in backticks, comma-separated. */
export const globs = (list) => list.map((glob) => `\`${glob}\``).join(', ');

/** A prompt's answer, as the context the Claude adapter would give the agent. */
export const asked = (text) => inFixture(() => onPrompt({ prompt: text }));
export const prompt = (text) => said(asked(text), '\n');
/**
 * An approval's answer, and its text. The plan is written to its file first,
 * as the agent adapter makes sure it is, unless `plan` is null: then the file
 * is left as it is, or missing.
 */
export const approval = (plan = '# Plan\n\nChange source.txt.', file = planFile()) => {
  if (typeof plan === 'string') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, plan);
  }
  return inFixture(() => onPlanApproved({ planFile: file }));
};
export const approve = (plan, file) => said(approval(plan, file));
export const turnEnd = (stopRefusedBefore = false, secondsLeft = 900) => inFixture(() => onTurnEnd({ stopRefusedBefore, secondsLeft }, { referee }));
export const realVerify = (secondsLeft) => inFixture(() => onTurnEnd({ stopRefusedBefore: false, secondsLeft }));
export const triageReply = (id) => inFixture(() => onTurnEnd({ triageReplyId: sha256(id), stopRefusedBefore: false, secondsLeft: 900 }, { referee }));

/** The text of a turn end that keeps the agent working. */
export const goesOn = (answer) => {
  expect(answer.keepWorking, said(answer)).toBe(true);
  return said(answer);
};
/** The text of a turn end that lets the turn end. */
export const ends = (answer) => {
  expect(answer.keepWorking, said(answer)).toBe(false);
  return said(answer);
};

export const allowed = { version: 1, allow: true, messages: [] };

export const put = (file, body) => {
  mkdirSync(join(ctx.repo, file, '..'), { recursive: true });
  writeFileSync(join(ctx.repo, file), body);
};

/** The rulebook without its target, which every moment refuses to run without. */
export const dropTarget = () => {
  const path = join(ctx.repo, '.katatay/rulebook.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  delete config.targetBranch;
  writeFileSync(path, `${JSON.stringify(config)}\n`);
};

/** The first event rewritten so the chain no longer links up. A triage is
 *  appended first, because a lone first event links up whatever it says. */
export const breakLog = () => {
  triage();
  writeFileSync(join(ctx.logbook, '0001__plan_approved.json'),
    '{"seq":1,"prev":null,"ts":"x","event":"plan_approved","payload":{},"branch":"feat/x"}\n');
};

export const TEST_ONLY = '# Plan\n\nTests only.\n\n```workflow\ntest-only: true\n```\n';


export const treeNow = () => inFixture(() => current().treeFingerprint);
