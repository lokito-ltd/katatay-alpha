import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePlan } from './plans.mjs';
import { planInTurn } from './transcript.mjs';
import { approvalKind, recordApproval } from './approval.mjs';

const item = (turn, type, text) => JSON.stringify({ type: 'event_msg', payload: {
  type: 'item_completed', turn_id: turn, item: { type, text },
} });
const plan = (turn, text = 'A plan.') => item(turn, 'Plan', text);
const conversation = [plan('old'), item('chat', 'AgentMessage', 'Discussion.'), plan('latest', 'New plan.')].join('\n');
let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-presented-'));
  mkdirSync(join(root, '.katatay'));
  writeFileSync(join(root, '.katatay/rulebook.json'), JSON.stringify({ plans: { dir: 'plans' } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const world = (text = conversation) => ({
  read: vi.fn(() => text), write: vi.fn(), makeFolder: vi.fn(), exists: () => false,
  ask: vi.fn(() => ({ recorded: true })), answer: (answer) => answer,
});
const approval = (turnId = 'approving') => ({ kind: 'same-thread', prompt: 'Yes', turnId, transcriptPath: '/transcript', root });

describe('same-thread approval phrases', () => {
  const phrases = ['Implement the plan', 'Implement this plan', 'Approve the plan', 'Approve this plan',
    'Yes, implement this plan', 'Yes', 'Approved', 'Go ahead', 'Proceed'];
  it.each(phrases)('accepts %s only as the whole normalized message', (phrase) => {
    for (const wrap of [(s) => s, (s) => `\n **\`${s.toUpperCase()}\`**!\n`, (s) => `“${s}”`]) {
      expect(approvalKind(wrap(phrase))).toBe('same-thread');
    }
    expect(approvalKind(`Don't ${phrase}`)).toBeNull();
    expect(approvalKind(`${phrase} and commit`)).toBeNull();
    const w = world(conversation + '\n' + item('intervening', 'AgentMessage', 'More discussion.'));
    expect(recordApproval({ ...approval(), prompt: phrase }, w)).toEqual({ recorded: true });
    expect(w.write).toHaveBeenCalledWith(expect.any(String), 'New plan.\n');
    expect(w.ask).toHaveBeenCalledTimes(1);
  });

  it('preserves internal spaces and punctuation and Unicode letters and digits', () => {
    for (const text of ['`*!`', '', 'Go  ahead', 'Go-ahead', 'Yes implement this plan', 'éYes', 'Yes٢', 'Yes\nplease']) {
      expect(approvalKind(text), text).toBeNull();
    }
  });

  it('uses the latest completed plan with the current prompt present or absent', () => {
    const text = conversation + '\n' + plan('latest', 'Revised in the same turn.');
    for (const current of ['', '\n' + item('approving', 'UserMessage', 'Yes')]) {
      const w = world(text + current);
      expect(recordApproval(approval(), w)).toEqual({ recorded: true });
      expect(w.write.mock.calls[0][1]).toBe('Revised in the same turn.\n');
    }
    const w = world(conversation + '\n' + item(undefined, 'AgentMessage', 'Discussion.'));
    expect(recordApproval({ ...approval(), turnId: undefined }, w)).toEqual({ recorded: true });
    expect(w.write).toHaveBeenCalledWith(expect.any(String), 'New plan.\n');
  });
});

describe('capturing the presented plan', () => {
  const input = () => ({ root, transcriptPath: '/transcript', turnId: 'latest' });
  it('saves exactly the latest completed plan in the current turn and returns its path', () => {
    const text = '\n  ## Why\nContent.\n\n';
    const w = world(conversation + '\n' + plan('latest', text));
    const result = capturePlan(input(), w);
    expect(result.planFile).toMatch(/plans\/[a-z]+-[a-z]+-[a-z]+\.md$/);
    expect(w.write).toHaveBeenCalledWith(result.planFile, text);
    expect(w.makeFolder).toHaveBeenCalledWith(join(root, 'plans'));
    expect(w.ask).not.toHaveBeenCalled();
  });

  it('skips ordinary turns rather than taking an older plan', () => {
    const w = world();
    expect(capturePlan({ ...input(), turnId: 'chat' }, w)).toEqual({ planFile: null });
    expect(capturePlan({ ...input(), turnId: 'absent' }, w)).toEqual({ planFile: null });
    expect(w.write).not.toHaveBeenCalled();
  });

  it('captures a Plan item that reaches disk after the null-message Stop', () => {
    const w = world();
    w.read.mockReturnValueOnce('').mockReturnValueOnce('').mockReturnValue(conversation);
    w.wait = vi.fn();
    const result = capturePlan({ ...input(), lastAssistantMessage: null }, w);
    expect(result.planFile).toBeTypeOf('string');
    expect(w.read).toHaveBeenCalledTimes(3);
    expect(w.wait.mock.calls).toEqual([[100], [100]]);
    expect(w.write).toHaveBeenCalledWith(result.planFile, 'New plan.');
  });

  it('warns after at most fifteen waits totalling 1.5 seconds when the Plan never arrives', () => {
    const w = world('');
    w.wait = vi.fn();
    const result = capturePlan({ ...input(), lastAssistantMessage: null }, w);
    expect(result.problem).toContain('may have presented a plan');
    expect(result.problem).toContain('not checked');
    expect(w.wait.mock.calls).toHaveLength(15);
    expect(w.wait.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBeLessThanOrEqual(1500);
    expect(w.read).toHaveBeenCalledTimes(16);
    expect(w.write).not.toHaveBeenCalled();
  });

  it('also respects elapsed time when a read consumes the retry budget', () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const w = world('');
      w.wait = vi.fn(ms => { now += ms + 1400; });
      expect(capturePlan({ ...input(), lastAssistantMessage: null }, w).problem).toContain('not checked');
      expect(w.wait.mock.calls).toEqual([[100]]);
      expect(w.read).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); }
  });

  it('does not wait without an exact null hint, without wait, or when the plan is already present', () => {
    for (const hint of [undefined, 'Done.', false, 0]) {
      const w = world(''); w.wait = vi.fn();
      expect(capturePlan({ ...input(), lastAssistantMessage: hint }, w)).toEqual({ planFile: null });
      expect(w.wait).not.toHaveBeenCalled();
      expect(w.read).toHaveBeenCalledTimes(1);
    }
    expect(capturePlan({ ...input(), lastAssistantMessage: null }, world(''))).toEqual({ planFile: null });
    const w = world(); w.wait = vi.fn();
    expect(capturePlan({ ...input(), lastAssistantMessage: null }, w).planFile).toBeTypeOf('string');
    expect(w.wait).not.toHaveBeenCalled();
  });

  it('reports a read failure during retry without saving or waiting again', () => {
    const w = world(''); w.wait = vi.fn();
    w.read.mockReturnValueOnce('').mockImplementationOnce(() => { throw new Error('gone during retry'); });
    expect(capturePlan({ ...input(), lastAssistantMessage: null }, w).problem).toContain('gone during retry');
    expect(w.wait).toHaveBeenCalledTimes(1);
    expect(w.write).not.toHaveBeenCalled();
  });

  it('uses only completed Plan items with their own turn identity and nonblank text', () => {
    const wrong = JSON.stringify({ type: 'event_msg', payload: { type: 'item_started', turn_id: 'latest', item: { type: 'Plan', text: 'Incomplete.' } } });
    expect(planInTurn(wrong, 'latest')).toBeNull();
    expect(planInTurn(plan(undefined), 'latest')).toBeNull();
    expect(planInTurn(plan('latest', '   '), 'latest')).toBe('   ');
    expect(planInTurn('invalid json\n' + conversation, 'latest')).toBe('New plan.');
  });

  it('reports missing identifiers and unreadable transcripts without saving anything', () => {
    for (const extra of [{ turnId: null }, { turnId: '' }, { turnId: 1 }, { transcriptPath: '' }, { transcriptPath: 1 }]) {
      const w = world();
      expect(capturePlan({ ...input(), ...extra }, w).problem).toContain('could not be checked');
      expect(w.write).not.toHaveBeenCalled();
      expect(w.read).not.toHaveBeenCalled();
    }
    const w = world(); w.read = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    expect(capturePlan(input(), w).problem).toContain('ENOENT');
  });

  it('reports folder and file failures as capture errors', () => {
    for (const method of ['makeFolder', 'write']) {
      const w = world(); w[method] = () => { throw new Error('read-only'); };
      expect(capturePlan(input(), w).problem).toContain(`could not be written to ${join(root, 'plans')}`);
    }
    writeFileSync(join(root, '.katatay/rulebook.json'), '{}');
    expect(capturePlan(input(), world()).problem).toContain('names no');
  });

  it('saves empty completed plans for the referee to reject', () => {
    const w = world(conversation + '\n' + plan('latest', ''));
    const result = capturePlan(input(), w);
    expect(result.planFile).toBeTypeOf('string');
    expect(w.write).toHaveBeenCalledWith(result.planFile, '');
  });

  it('respects taken names and supports the default existence check', () => {
    const w = world(); const candidates = [];
    w.exists = (path) => { candidates.push(path); return candidates.length === 1; };
    expect(capturePlan(input(), w).planFile).toBe(candidates[1]);
    const defaults = world(); delete defaults.exists;
    expect(capturePlan(input(), defaults).planFile).toMatch(/\.md$/);
  });
});

describe('turn-scoped Stop capture', () => {
  it('does not mistake commentary, malformed items or later turns for this turn’s Plan', () => {
    const text = [plan('mine'), item('mine', 'AgentMessage', 'After the plan.'), plan('other'), plan(undefined)].join('\n');
    expect(planInTurn(text, 'mine')).toBe('A plan.');
    for (const id of [undefined, '', 42, 'absent']) expect(planInTurn(text, id)).toBeNull();
    expect(planInTurn(text + '\n' + plan('mine', 42), 'mine')).toBeNull();
  });
});

// This prefix was observed in a desktop approval message. These are synthetic
// prompt cases, not captures of the hook payload.
describe('approval with the plan in the message', () => {
  const prefix = 'PLEASE IMPLEMENT THIS PLAN:';
  const submit = (body, w, overrides = {}) => recordApproval({
    kind: approvalKind(prefix + body), prompt: prefix + body, root, ...overrides,
  }, w);

  it('recognizes the exact prefix only at the start of the prompt', () => {
    expect(approvalKind(prefix)).toBe('embedded-plan');
    for (const text of ['please implement this plan:', 'PLEASE IMPLEMENT THIS PLAN', ' ' + prefix, 'Discuss ' + prefix, '`' + prefix + '`']) {
      expect(approvalKind(text + '\n# Plan')).toBeNull();
    }
  });

  it('saves the entire embedded body and its declarations without reading the transcript', () => {
    const body = '  # Indented\n\nLine with `code`.\n\n```workflow\npredicted-failures: []\n```';
    const w = world(conversation);
    expect(submit('\n\n' + body + '\n\n', w)).toEqual({ recorded: true });
    expect(w.read).not.toHaveBeenCalled();
    const [[path, saved]] = w.write.mock.calls;
    expect(saved).toBe(body + '\n');
    expect(w.ask.mock.calls).toEqual([[{ version: 1, planFile: path }]]);
  });

  it('falls back only for an absent or whitespace-only body', () => {
    for (const body of ['', ' \n\t']) {
      const w = world(conversation + '\n' + item(undefined, 'UserMessage', 'Discussion after presentation.'));
      expect(submit(body, w, { transcriptPath: '/transcript' })).toEqual({ recorded: true });
      expect(w.write).toHaveBeenCalledWith(expect.any(String), 'New plan.\n');
    }
  });

  it('never substitutes an older plan when the latest completed item is unusable', () => {
    for (const text of ['', '  ', null, 123]) {
      const w = world(conversation + '\n' + plan('newest', text));
      expect(submit('', w, { transcriptPath: '/transcript' }).context).toContain('empty or malformed');
      expect(w.write).not.toHaveBeenCalled();
      expect(w.ask).not.toHaveBeenCalled();
    }
  });

  it('does not substitute a transcript plan after a failed save or declaration refusal', () => {
    const failing = world();
    failing.write.mockImplementation(() => { throw new Error('disk full'); });
    expect(submit('\n# My plan', failing).context).toContain('disk full');
    expect(failing.read).not.toHaveBeenCalled();
    expect(failing.ask).not.toHaveBeenCalled();
    const refused = world(); refused.ask.mockReturnValue({ recorded: false });
    expect(submit('\n```workflow\ninvalid\n```', refused)).toEqual({ recorded: false });
    expect(refused.read).not.toHaveBeenCalled();
    expect(refused.ask).toHaveBeenCalledTimes(1);
  });
});
