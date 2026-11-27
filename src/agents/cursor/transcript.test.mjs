import { describe, expect, it } from 'vitest';
import { transcript } from '../../../tests/fixtures/cursor/payloads.mjs';
import { latestPlan, planInTurn } from './transcript.mjs';

const PATHS = { home: '/home/operator', repo: '/work/repo' };
const line = (entry) => JSON.stringify(entry);
const user = (text) => line({ role: 'user', message: { content: [{ type: 'text', text }] } });
const plan = (name, text) => line({ role: 'assistant', message: { content: [{ type: 'text', text: 'Here.' }, { type: 'tool_use', name: 'CreatePlan', input: { name, plan: text, todos: [] } }] } });

describe('plans in a Cursor transcript', () => {
  it('finds the plan a captured Build approved, by name and text', () => {
    const found = latestPlan(transcript('transcript-build', PATHS));
    expect(found.count).toBe(1);
    expect(found.latest.name).toBe('Add hello.txt');
    expect(found.latest.plan.startsWith('# Add hello.txt\n\nCreate [hello.txt](hello.txt)')).toBe(true);
  });

  it('takes the newest plan, skips lines that are not JSON, and lets a newer unusable plan stand', () => {
    const text = [plan('One', 'first'), 'not json', '', line(null), plan('Two', 'second'), user('Build')].join('\n');
    expect(latestPlan(text)).toEqual({ latest: { name: 'Two', plan: 'second' }, count: 2 });
    const broken = line({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CreatePlan', input: {} }] } });
    expect(latestPlan(`${plan('One', 'first')}\n${broken}`)).toEqual({ latest: { name: null, plan: null }, count: 2 });
  });

  it('counts only an assistant\'s CreatePlan calls', () => {
    const fromUser = line({ role: 'user', message: { content: [{ type: 'tool_use', name: 'CreatePlan', input: { name: 'x', plan: 'y' } }] } });
    const other = line({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { name: 'x' } }] } });
    const noContent = line({ role: 'assistant', message: {} });
    expect(latestPlan([fromUser, other, noContent].join('\n'))).toEqual({ latest: null, count: 0 });
  });

  it('reads the current turn\'s plan only: everything after the last user line', () => {
    expect(planInTurn([user('plan it'), plan('A', 'text A')].join('\n'))).toBe('text A');
    expect(planInTurn([user('plan it'), plan('A', 'text A'), user('Build')].join('\n'))).toBeNull();
    expect(planInTurn([plan('A', 'old'), user('again'), plan('B', 'new'), line({ type: 'turn_ended' })].join('\n'))).toBe('new');
    expect(planInTurn('')).toBeNull();
  });
});

describe('malformed parts the mutation run found', () => {
  const assistant = (content) => line({ role: 'assistant', message: { content } });

  it('skips an assistant line with no message, a null part, and a part that only names CreatePlan', () => {
    const createPlan = { type: 'tool_use', name: 'CreatePlan', input: { name: 'A', plan: 'x' } };
    expect(latestPlan(line({ role: 'assistant' }))).toEqual({ latest: null, count: 0 });
    expect(latestPlan(assistant([null, createPlan]))).toEqual({ latest: { name: 'A', plan: 'x' }, count: 1 });
    expect(latestPlan(assistant([{ ...createPlan, type: 'text' }]))).toEqual({ latest: null, count: 0 });
  });

  it('reads a CreatePlan with no input as one with no name and no text', () => {
    expect(latestPlan(assistant([{ type: 'tool_use', name: 'CreatePlan' }]))).toEqual({ latest: { name: null, plan: null }, count: 1 });
  });
});
