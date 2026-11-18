import { HARNESS_SCHEMA_VERSION } from '../../schema-version.mjs';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_PROMPT, CLEAR_CONTEXT_PREAMBLE, RULEBOOK, approvalKind, newPlanFile, planFromPrompt, planFromTranscript, plansDir, recordApproval,
} from './approval.mjs';
import { payload, transcript } from '../../../tests/fixtures/codex/payloads.mjs';

const paths = { home: '/home/op', repo: '/repo' };
const captured = transcript('transcript-plan-approved', paths);

describe('which prompts approve a plan', () => {
  it('reads the captured "Yes, implement this plan" as an approval in the same thread', () => {
    expect(approvalKind(payload('user-prompt-submit-approval', {}, paths).prompt)).toBe('same-thread');
  });

  it('reads the captured "Yes, clear context and implement" as an approval in a new thread', () => {
    expect(approvalKind(payload('user-prompt-submit-clear-context', {}, paths).prompt)).toBe('clear-context');
  });

  it('takes the approval text typed by hand, with whitespace around it', () => {
    expect(approvalKind(`  ${APPROVAL_PROMPT}\n`)).toBe('same-thread');
  });

  // A sentence that merely contains the words approves nothing.
  it('approves nothing with any other prompt', () => {
    expect(approvalKind(payload('user-prompt-submit', {}, paths).prompt)).toBe(null);
    expect(approvalKind(`Please ${APPROVAL_PROMPT}`)).toBe(null);
    expect(approvalKind(`${APPROVAL_PROMPT} And then commit.`)).toBe(null);
    expect(approvalKind('')).toBe(null);
  });
});

describe('where the approved plan is', () => {
  it('is the last Plan item in a transcript', () => {
    const found = planFromTranscript(captured);
    expect(found.plans).toBe(2);
    expect(found.plan.startsWith('### Create and convert a note to Markdown\n')).toBe(true);
    expect(found.plan.endsWith('\n')).toBe(true);
    expect(found.plan).not.toContain('<proposed_plan>');
  });

  it('is nothing in a thread that holds no plan', () => {
    expect(planFromTranscript(transcript('transcript-clear-context', paths))).toEqual({ plan: null, plans: 0 });
  });

  // Codex documents the format as not stable, so one odd line must not hide the plan.
  it('skips invalid JSON but counts every completed Plan, including one without text', () => {
    const odd = `not json "Plan"\n${JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Plan', text: '  ' } } })}\n${captured}`;
    expect(planFromTranscript(odd).plans).toBe(3);
  });

  it('is the plan after the preamble in a clear-context prompt', () => {
    const plan = planFromPrompt(payload('user-prompt-submit-clear-context', {}, paths).prompt);
    expect(plan.startsWith('### Create and convert a note to Markdown\n')).toBe(true);
  });

  // The same plan, approved either way, is recorded as the same text.
  it('is the same text whichever approval the operator chose', () => {
    expect(planFromPrompt(payload('user-prompt-submit-clear-context', {}, paths).prompt)).toBe(planFromTranscript(captured).plan);
  });

  it('is nothing when a clear-context prompt carries no plan', () => {
    expect(planFromPrompt(`${CLEAR_CONTEXT_PREAMBLE}\n\n  \n`)).toBe(null);
  });
});

describe('the new plan file', () => {
  it('is three words directly in the folder', () => {
    expect(newPlanFile('/plans', { exists: () => false })).toMatch(/^\/plans\/[a-z]+-[a-z]+-[a-z]+\.md$/);
  });

  // Each approval gets a file of its own, so an earlier plan is never overwritten.
  it('draws again when a name is taken', () => {
    const taken = new Set();
    const first = newPlanFile('/plans', { pick: () => 0, exists: () => false });
    taken.add(first);
    let n = 0;
    const second = newPlanFile('/plans', { pick: () => (n++ < 3 ? 0 : 1), exists: (path) => taken.has(path) });
    expect(second).not.toBe(first);
  });

  it('falls back to a numbered name when every draw is taken', () => {
    const taken = (path) => !path.endsWith('plan-3.md');
    expect(newPlanFile('/plans', { pick: () => 0, exists: taken })).toBe('/plans/plan-3.md');
  });
});

describe('the plans folder the rulebook names', () => {
  const repo = (folder) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-plans-'));
    mkdirSync(join(root, '.katatay'));
    if (folder !== undefined) writeFileSync(join(root, RULEBOOK), JSON.stringify({ plans: folder === null ? {} : { dir: folder } }));
    return root;
  };

  it('expands the home directory', () => {
    expect(plansDir(repo('~/.codex/plans'), '/home/op')).toEqual({ folder: '/home/op/.codex/plans' });
    expect(plansDir(repo('~'), '/home/op')).toEqual({ folder: '/home/op' });
  });

  it('reads a relative folder from the repository, and keeps an absolute one', () => {
    const root = repo('plans');
    expect(plansDir(root, '/home/op')).toEqual({ folder: join(root, 'plans') });
    expect(plansDir(repo('/elsewhere/plans'), '/home/op')).toEqual({ folder: '/elsewhere/plans' });
  });

  it('says why when there is no rulebook, or it names no folder', () => {
    expect(plansDir(repo(undefined)).problem).toMatch(/could not be read/);
    expect(plansDir(repo(null)).problem).toMatch(/names no `plans.dir`/);
  });
});

describe('recording an approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-approve-'));
  mkdirSync(join(root, '.katatay'));
  writeFileSync(join(root, RULEBOOK), JSON.stringify({ plans: { dir: '~/plans' } }));

  /** A world that keeps files in a map and answers like the referee. */
  const world = (files = {}, answered = { answer: { version: 1, recorded: true, messages: [{ code: 'approved', for: 'agent', text: 'Approved.' }] } }) => {
    const written = {};
    const asked = [];
    return {
      written,
      asked,
      read: (path) => {
        if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return files[path];
      },
      write: (path, text) => { written[path] = text; },
      makeFolder: () => {},
      exists: () => false,
      ask: (request) => { asked.push(request); return answered; },
      answer: (result) => ({ context: result.answer.messages[0].text, operator: 'shown' }),
    };
  };

  it('writes the plan from the turn the approval answers to a new file in the plans folder, and asks the referee', () => {
    const w = world({ '/t.jsonl': captured });
    const said = recordApproval({ kind: 'same-thread', prompt: APPROVAL_PROMPT, transcriptPath: '/t.jsonl', turnId: 'approval-turn', root, home: '/home/op' }, w);
    const [file] = Object.keys(w.written);
    expect(file).toMatch(/^\/home\/op\/plans\/[a-z]+-[a-z]+-[a-z]+\.md$/);
    expect(w.written[file]).toBe(planFromTranscript(captured).plan);
    expect(w.asked).toEqual([{ version: HARNESS_SCHEMA_VERSION, planFile: file }]);
    expect(said).toEqual({ context: 'Approved.', operator: 'shown' });
  });

  it('writes the plan a clear-context prompt carries', () => {
    const w = world();
    const prompt = payload('user-prompt-submit-clear-context', {}, paths).prompt;
    recordApproval({ kind: 'clear-context', prompt, transcriptPath: '/unused', root, home: '/home/op' }, w);
    expect(Object.values(w.written)).toEqual([planFromPrompt(prompt)]);
  });

  /** An approval that must not reach the referee, and what it says. */
  const refused = (approval, w = world()) => {
    const said = recordApproval({ root, turnId: 'approval-turn', home: '/home/op', prompt: APPROVAL_PROMPT, kind: 'same-thread', ...approval }, w);
    expect(w.asked).toEqual([]);
    expect(w.written).toEqual({});
    expect(said.context).toBe(said.operator);
    expect(said.context).toMatch(/no approval was recorded and the current workflow state is unchanged/);
    return said.context;
  };

  it('records nothing, and says so, when the thread holds no plan', () => {
    expect(refused({ transcriptPath: '/t.jsonl' }, world({ '/t.jsonl': transcript('transcript-clear-context', paths) }))).toMatch(/holds no plan/);
  });

  // A plan shown but not recorded as a Plan item means the format changed.
  it('names a changed transcript format when a plan was shown but no Plan item kept', () => {
    const shown = `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '<proposed_plan>\nx\n</proposed_plan>' }] } })}\n`;
    expect(refused({ transcriptPath: '/t.jsonl' }, world({ '/t.jsonl': shown }))).toMatch(/may have changed how it records plans/);
  });

  it('records nothing when Codex sent no transcript, or it cannot be read', () => {
    expect(refused({ transcriptPath: null })).toMatch(/no `transcript_path`/);
    expect(refused({ transcriptPath: '/gone.jsonl' })).toMatch(/could not be read \(ENOENT\)/);
  });

  it('records nothing when a clear-context prompt carries no plan', () => {
    expect(refused({ kind: 'clear-context', prompt: CLEAR_CONTEXT_PREAMBLE })).toMatch(/carries no plan/);
  });

  it('records nothing when the plans folder is not known', () => {
    const bare = mkdtempSync(join(tmpdir(), 'codex-bare-'));
    expect(refused({ root: bare, transcriptPath: '/t.jsonl' }, world({ '/t.jsonl': captured }))).toMatch(/plans folder is not known/);
  });

  it('records nothing when the plan cannot be written', () => {
    const w = world({ '/t.jsonl': captured });
    w.write = () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); };
    expect(refused({ transcriptPath: '/t.jsonl' }, w)).toMatch(/could not be written to .*\(EACCES\)/);
  });
});

describe('which transcript lines hold a plan', () => {
  const line = (entry) => JSON.stringify(entry);
  const plan = (text = 'The plan.') => line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Plan', text } } });

  // Each of these says "Plan" somewhere, and none of them is a plan Codex recorded.
  it('takes only a completed Plan item in an event message', () => {
    for (const other of [
      line({ type: 'response_item', payload: { type: 'item_completed', item: { type: 'Plan', text: 'not this' } } }),
      line({ type: 'event_msg', payload: { type: 'item_started', item: { type: 'Plan', text: 'not this' } } }),
      line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', kind: 'Plan', text: 'not this' } } }),
      line({ type: 'event_msg', note: 'Plan' }),
      line({ type: 'event_msg', payload: { type: 'item_completed', note: 'Plan' } }),
      line('Plan'),
      line(['Plan']),
      'null "Plan"',
    ]) {
      expect(planFromTranscript(`${plan()}\n${other}\n`), other).toEqual({ plan: 'The plan.\n', plans: 1 });
    }
  });

  it('recognizes a completed Plan whose text is unusable', () => {
    expect(planFromTranscript(line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Plan', text: 7 } } }))).toEqual({ plan: null, plans: 1 });
  });

  // Blank lines before the plan go, and the first line's indent stays.
  it('drops the blank lines around a plan and keeps its first line as written', () => {
    expect(planFromTranscript(plan('\n \n  - indented\nnext\n\n\n')).plan).toBe('  - indented\nnext\n');
  });
});

describe('drawing a plan file name', () => {
  it('draws fifty times before it falls back to a number', () => {
    let draws = 0;
    newPlanFile('/plans', { pick: () => 0, exists: (path) => { if (!path.includes('plan-')) draws += 1; return !path.endsWith('plan-2.md'); } });
    expect(draws).toBe(50);
  });
});

describe('a rulebook of an unexpected shape', () => {
  const repo = (text) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rulebook-'));
    mkdirSync(join(root, '.katatay'));
    writeFileSync(join(root, RULEBOOK), text);
    return root;
  };

  it('says why when the rulebook is not JSON', () => {
    expect(plansDir(repo('{ nope')).problem).toMatch(/could not be read \(.*JSON/);
  });

  it('names no folder for a rulebook that is null, has no plans section, or a blank folder', () => {
    for (const text of ['null', '{"plans":null}', '{"plans":{"dir":"   "}}', '{"plans":{"dir":7}}']) {
      expect(plansDir(repo(text)).problem, text).toMatch(/names no `plans.dir`/);
    }
  });
});

describe('recording an approval, step by step', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-steps-'));
  mkdirSync(join(root, '.katatay'));
  writeFileSync(join(root, RULEBOOK), JSON.stringify({ plans: { dir: '~/plans' } }));
  const base = { kind: 'same-thread', prompt: APPROVAL_PROMPT, transcriptPath: '/t.jsonl', turnId: 'approval-turn', root, home: '/home/op' };
  const world = (changes = {}) => ({
    made: [],
    written: {},
    asked: [],
    read: () => captured,
    write(path, text) { this.written[path] = text; },
    makeFolder(path) { this.made.push(path); },
    ask(request) { this.asked.push(request); return { answer: { version: 1, recorded: true, messages: [] } }; },
    answer: () => ({ context: 'ok', operator: 'ok' }),
    ...changes,
  });

  // Codex keeps no plan files, so the folder may not exist yet.
  it('makes the plans folder first', () => {
    const w = world();
    recordApproval(base, w);
    expect(w.made).toEqual(['/home/op/plans']);
  });

  it('draws again when the world says a name is taken', () => {
    const seen = [];
    const w = world({ exists: (path) => { seen.push(path); return seen.length === 1; } });
    recordApproval(base, w);
    expect(Object.keys(w.written)).toEqual([seen[1]]);
  });

  it('names the folder when it cannot be made, and the file when it cannot be written', () => {
    const noFolder = recordApproval(base, world({ makeFolder: () => { throw new Error('read-only'); } }));
    expect(noFolder.context).toMatch(/could not be written to \/home\/op\/plans \(read-only\)/);
    const noFile = recordApproval(base, world({ write: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }));
    expect(noFile.context).toMatch(/could not be written to \/home\/op\/plans\/[a-z]+-[a-z]+-[a-z]+\.md \(EACCES\)/);
  });

  it('records nothing for an empty transcript path', () => {
    const w = world();
    expect(recordApproval({ ...base, transcriptPath: '' }, w).context).toMatch(/no `transcript_path`/);
    expect(w.asked).toEqual([]);
  });

  it('diagnoses a completed Plan with no text', () => {
    const blank = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Plan', text: '' } } });
    expect(recordApproval(base, world({ read: () => blank })).context).toMatch(/latest completed Plan item has empty or malformed content/);
  });

  it('names the reason a transcript could not be read when it has no code', () => {
    expect(recordApproval(base, world({ read: () => { throw new Error('boom'); } })).context).toMatch(/could not be read \(boom\)/);
  });
});
