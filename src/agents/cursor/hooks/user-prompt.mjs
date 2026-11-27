#!/usr/bin/env node
/**
 * beforeSubmitPrompt. Records an approved plan when the prompt is the one
 * Build sends (`on plan-approved`), then hands the operator's message to the
 * referee (`on prompt`), which records `reset` and `record` and says where
 * the change is. Both go in front of the agent as `additional_context`.
 *
 * Cursor documents no context field for this event. The capture under 3.32.10
 * showed the agent receiving `additional_context` from it, and that is what
 * this relies on. `approval.mjs` says how Build is recognised and where its
 * plan is.
 *
 * The prompt is never held back: `continue` is always true. Injecting context
 * is a convenience, and a failure at it must not swallow the operator's words.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { input, enterRepository, leave } from './io.mjs';
import { expectFields } from './drift.mjs';
import { ask } from './referee.mjs';
import { VERSION, forPlanApproved, forPrompt, forTheOperator, joined, promptOutput } from './translate.mjs';
import { cursorPlans, isBuild, recordBuild } from '../approval.mjs';

const carry = (out, warning) => ({ ...out, additional_context: joined(forTheOperator(warning), out.additional_context) });

let hook;
try {
  hook = await input();
} catch (error) {
  await leave(promptOutput(`workflow: state unavailable (${error.message})`), carry);
}
expectFields(hook, {
  prompt: 'the operator could click Build or type `record` or `reset` and nothing would hear it',
  workspace_roots: 'the hook cannot find the repository, and asks the referee from its own folder',
});
const root = enterRepository(hook?.workspace_roots);
const prompt = typeof hook?.prompt === 'string' ? hook.prompt : '';

let approval = null;
if (isBuild(prompt)) {
  expectFields(hook, { transcript_path: 'the built plan cannot be found, because it is named in the conversation\'s transcript' });
  const folder = cursorPlans();
  approval = recordBuild({ transcriptPath: hook?.transcript_path, root }, {
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, text) => writeFileSync(path, text, { flag: 'wx' }),
    makeFolder: (path) => mkdirSync(path, { recursive: true }),
    exists: existsSync,
    list: () => {
      try {
        return readdirSync(folder).filter((name) => name.endsWith('.plan.md')).map((name) => join(folder, name));
      } catch {
        return [];
      }
    },
    modified: (path) => statSync(path).mtimeMs,
    ask: (request) => ask('plan-approved', request),
    answer: forPlanApproved,
  });
}

const state = forPrompt(ask('prompt', { version: VERSION, prompt }));
await leave(promptOutput(joined(forTheOperator(approval?.warning), approval?.context, state)), carry);
