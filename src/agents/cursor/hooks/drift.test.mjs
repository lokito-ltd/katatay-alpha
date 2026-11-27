import { expect, it } from 'vitest';
import { drift, expectFields, hasDrift } from './drift.mjs';

it('accepts loop_count 0, but names each missing field, its event and its consequence', () => {
  const fields = { 'tool_input.file_path': 'the file cannot be checked', loop_count: 'a follow-up could repeat' };
  expectFields({ tool_input: { file_path: '' }, loop_count: 0 }, fields);
  expect(hasDrift()).toBe(false);
  expectFields({ hook_event_name: 'stop', tool_input: null }, fields);
  expect(hasDrift()).toBe(true);
  expect(drift()).toContain('Cursor sent no `tool_input.file_path` to the stop hook, so the file cannot be checked.');
  expect(drift()).toContain('Cursor sent no `loop_count` to the stop hook, so a follow-up could repeat.');
  expect(drift()).toContain('`tests/fixtures/cursor/`');
  expectFields(undefined, { prompt: 'nothing is heard' });
  expect(drift()).toContain('Cursor sent no `prompt` to the workflow hook, so nothing is heard.');
  expect(drift().split('\n\n')).toHaveLength(3);
});
