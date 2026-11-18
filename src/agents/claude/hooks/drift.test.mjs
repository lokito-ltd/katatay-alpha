import { expect, it } from 'vitest';
import { drift, expectFields, hasDrift } from './drift.mjs';

it('accepts an explicit false, but names each missing field and its consequence', () => {
  const fields = { 'tool_input.command': 'the command cannot be checked', stop_hook_active: 'the stop could repeat' };
  expectFields({ tool_input: { command: '' }, stop_hook_active: false }, fields);
  expect(hasDrift()).toBe(false);
  expectFields({ hook_event_name: 'PreToolUse', tool_input: null }, fields);
  expect(hasDrift()).toBe(true);
  expect(drift()).toContain('no `tool_input.command` to the PreToolUse hook, so the command cannot be checked');
  expect(drift()).toContain('no `stop_hook_active` to the PreToolUse hook, so the stop could repeat');
});
