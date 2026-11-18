#!/usr/bin/env node
/**
 * UserPromptSubmit. Hands the operator's message to the referee (`on prompt`),
 * which records `reset` and `record` and says where the change is, and puts
 * that in front of Claude for the turn.
 */
import { input, send, leave } from './io.mjs';
import { expectFields } from './drift.mjs';
import { ask } from './referee.mjs';
import { VERSION, forPrompt } from './translate.mjs';

let hook;
try {
  hook = await input();
} catch (error) {
  // Injecting context is a convenience. Failing at it must not swallow the
  // prompt.
  send({ via: 'context', text: `workflow: state unavailable (${error.message})` });
  await leave();
}
expectFields(hook, { prompt: 'the operator could type `record` or `reset` and nothing would hear it' });
const prompt = typeof hook?.prompt === 'string' ? hook.prompt : '';
send(forPrompt(ask('prompt', { version: VERSION, prompt })));
await leave();
