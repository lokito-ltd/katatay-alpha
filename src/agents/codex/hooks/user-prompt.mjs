#!/usr/bin/env node
/**
 * UserPromptSubmit. Records an approved plan when the prompt is Codex's
 * approval (`on plan-approved`), then hands the operator's message to the
 * referee (`on prompt`), which records `reset` and `record` and says where
 * the change is. Both go in front of the agent for the turn, and what is for
 * the operator is shown to them.
 *
 * Codex has no approval hook, so this is where an approval arrives: as the
 * prompt "Yes, implement this plan" or "Yes, clear context and implement"
 * sends. `approval.mjs` says how each is recognised and where its plan is.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { input, enterRepository, joined, leave } from './io.mjs';
import { expectFields } from './drift.mjs';
import { ask } from './referee.mjs';
import { VERSION, bypassWarning, forPlanApproved, forPrompt, promptOutput } from './translate.mjs';
import { approvalKind, planFromPrompt, recordApproval } from '../approval.mjs';

let hook;
try {
  hook = await input();
} catch (error) {
  // Injecting context is a convenience. Failing at it must not swallow the
  // prompt.
  await leave(promptOutput({ context: `workflow: state unavailable (${error.message})`, operator: undefined }));
}
expectFields(hook, { prompt: 'the operator could approve a plan or type `record` or `reset` and nothing would hear it' });
const root = enterRepository(hook?.cwd);
const prompt = typeof hook?.prompt === 'string' ? hook.prompt : '';

const kind = approvalKind(prompt);
if (kind === 'same-thread' || (kind === 'embedded-plan' && planFromPrompt(prompt) === null)) {
  expectFields(hook, {
    transcript_path: 'the approved plan cannot be found, because it is read from the thread\'s transcript',
  });
}
const approval = kind === null ? null : recordApproval({ kind, prompt, transcriptPath: hook?.transcript_path, root }, {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => writeFileSync(path, text, { flag: 'wx' }),
  makeFolder: (path) => mkdirSync(path, { recursive: true }),
  exists: existsSync,
  ask: (request) => ask('plan-approved', request),
  answer: forPlanApproved,
});

const state = forPrompt(ask('prompt', { version: VERSION, prompt }));
await leave(promptOutput({
  context: joined(approval?.context, state.context),
  operator: joined(bypassWarning(hook?.permission_mode), approval?.operator, state.operator),
}));
