import { describe, expect, it } from 'vitest';
import { payload } from '../../../../tests/fixtures/cursor/payloads.mjs';
import {
  CURSOR_WORDS, VERSION, forPlanApproved, forPrompt, forTheOperator, forTurnEnd, forWrite, inCursorWords, joined,
  preToolOutput, promptOutput, stopOutput, toWrite,
} from './translate.mjs';

const PATHS = { home: '/home/operator', repo: '/work/repo' };
const answer = (fields) => ({ answer: { version: VERSION, messages: [], ...fields } });
const message = (code, audience, text) => ({ code, for: audience, text });
const POST = 'Post the following for the operator verbatim in your reply, through any `Details:` line:\n\n';

describe('what the gate asks the referee, from what Cursor sent', () => {
  it('reads a captured Write as a write of its file, a Delete as a delete, and a Shell call as its command', () => {
    const write = payload('pre-tool-use-write', {}, PATHS);
    expect(toWrite(write.tool_name, write.tool_input, PATHS.repo)).toEqual({ ask: { version: VERSION, writes: [{ path: '/work/repo/notes.txt', delete: false }], command: null } });
    const remove = payload('pre-tool-use-delete', {}, PATHS);
    expect(toWrite(remove.tool_name, remove.tool_input, PATHS.repo)).toEqual({ ask: { version: VERSION, writes: [{ path: '/work/repo/old.txt', delete: true }], command: null } });
    const shell = payload('pre-tool-use-shell', {}, PATHS);
    expect(toWrite(shell.tool_name, shell.tool_input, PATHS.repo)).toEqual({ ask: { version: VERSION, writes: [], command: 'ls' } });
  });

  it('reads a relative path from the repository root, and leaves other tools and empty commands alone', () => {
    expect(toWrite('Write', { file_path: 'src/a.mjs' }, '/r').ask.writes).toEqual([{ path: '/r/src/a.mjs', delete: false }]);
    expect(toWrite('Read', { file_path: '/r/a' }, '/r')).toBeNull();
    expect(toWrite('Shell', { command: '' }, '/r')).toBeNull();
    expect(toWrite('Shell', undefined, '/r')).toBeNull();
  });

  it('denies a Write or Delete that names no file', () => {
    for (const tool of ['Write', 'Delete']) {
      for (const input of [undefined, {}, { file_path: '' }, { file_path: 3 }]) {
        expect(toWrite(tool, input, '/r')).toEqual({ deny: `The gate cannot tell which file this ${tool} call writes, because Cursor sent no \`tool_input.file_path\`, so it is not permitted. Stop and tell the operator: Cursor's tool format may have changed.` });
      }
    }
  });
});

describe('the gate\'s answer', () => {
  const asked = { writes: [{ path: '/r/a', delete: false }] };

  it('lets an allowed call go on, and denies a refused one with the referee\'s reasons in Cursor\'s words', () => {
    expect(forWrite(answer({ allow: true }), asked)).toBeNull();
    const refused = forWrite(answer({ allow: false, messages: [message('needs_plan', 'agent', 'Present a plan.'), message('warning', 'operator', 'Careful.')] }), asked);
    expect(refused).toEqual({ deny: `Present a plan.\n\n${CURSOR_WORDS.needs_plan.agent}\n\nCareful.` });
  });

  it('denies a file write, and lets a shell command go on, when the referee gives no usable answer', () => {
    const cases = [
      [{ problem: 'it crashed' }, 'it crashed'],
      [{ answer: { messages: [], allow: true } }, 'the referee answered without a version'],
      [{ answer: { version: 99, messages: [], allow: true } }, 'the referee answered version 99, and this adapter speaks 1'],
      [answer({}), 'the referee answered without what it promises'],
      [answer({ allow: true, messages: [{ code: 'x' }] }), 'the referee answered without what it promises'],
      [answer({ allow: false }), 'the referee denied the call without saying why'],
    ];
    for (const [result, why] of cases) {
      const denied = forWrite(result, asked);
      expect(denied.deny, why).toContain(why);
      expect(denied.deny.startsWith('The gate got no answer from the referee, so it cannot tell whether this file may be written, and the call is not permitted: ')).toBe(true);
      expect(denied.deny.endsWith('\n\nStop and tell the operator.')).toBe(true);
      expect(forWrite(result, { writes: [] })).toBeNull();
    }
  });

  it('prints a denial for both audiences, and `{}`, never an allow, to let a call go on', () => {
    expect(preToolOutput(null)).toEqual({});
    expect(preToolOutput(null, 'drift')).toEqual({ agent_message: 'drift' });
    expect(preToolOutput({ deny: 'No.' })).toEqual({ permission: 'deny', agent_message: 'No.', user_message: 'No.' });
    expect(preToolOutput({ deny: 'No.' }, 'drift')).toEqual({ permission: 'deny', agent_message: 'drift\n\nNo.', user_message: 'drift\n\nNo.' });
  });
});

describe('a prompt', () => {
  it('gives the agent every message, with the operator\'s marked for posting first', () => {
    const result = answer({ messages: [message('info', 'agent', 'Moved.'), message('declared', 'operator', 'The report.'), message('state', 'agent', 'phase: open')] });
    expect(forPrompt(result)).toBe(`${POST}The report.\n\nMoved.\nphase: open`);
    expect(forPrompt(answer({ messages: [message('state', 'agent', 'phase: open')] }))).toBe('phase: open');
    expect(forPrompt(answer({ messages: [message('recorded', 'operator', 'Done.')] }))).toBe(`${POST}Done.\n\n${CURSOR_WORDS.recorded.operator}`);
  });

  it('says the state is unavailable when the referee gives no usable answer, or says nothing', () => {
    expect(forPrompt({ problem: 'gone' })).toBe('workflow: state unavailable (gone)');
    expect(forPrompt(answer({}))).toMatch(/^workflow: state unavailable \(the referee answered without what it promises/);
  });

  it('always lets the prompt through, with context when there is some', () => {
    expect(promptOutput('ctx')).toEqual({ continue: true, additional_context: 'ctx' });
    expect(promptOutput(undefined)).toEqual({ continue: true });
  });
});

describe('an approval', () => {
  it('tells the agent to post whether it was recorded', () => {
    expect(forPlanApproved(answer({ recorded: true, messages: [message('approved', 'agent', 'Start.')] }))).toEqual({ context: `${POST}Start.` });
    expect(forPlanApproved({ problem: 'down' })).toEqual({ context: `${POST}The plan was built, but the workflow hook failed to record it: down` });
    expect(forPlanApproved(answer({ recorded: true }))).toEqual({ context: expect.stringContaining('failed to record it: the referee answered without what it promises') });
  });
});

describe('the turn\'s end', () => {
  it('lets the turn end quietly when there is nothing to say, or only words for the agent', () => {
    expect(forTurnEnd(answer({ keepWorking: false }), false)).toEqual({ followup: undefined });
    expect(forTurnEnd(answer({ keepWorking: false, messages: [message('run_triage', 'agent', 'Triage when done.')] }), false)).toEqual({ followup: undefined });
    expect(stopOutput({ followup: undefined })).toEqual({});
  });

  it('sends every message back as a follow-up when the referee says keep working', () => {
    const result = answer({ keepWorking: true, messages: [message('frozen', 'agent', 'Unwind.'), message('warning', 'operator', 'Look.')] });
    expect(forTurnEnd(result, false)).toEqual({ followup: `${POST}Look.\n\nUnwind.` });
    expect(forTurnEnd(result, true, 'plan problem')).toEqual({ followup: `${POST}Look.\n\nplan problem\n\nUnwind.` });
    expect(stopOutput({ followup: 'Go on.' })).toEqual({ followup_message: 'Go on.' });
  });

  it('asks for a fresh verification report verbatim, even after a follow-up, with the agent\'s instructions after it', () => {
    const result = answer({ keepWorking: false, messages: [message('verified', 'operator', 'Passed.'), message('warning', 'operator', 'Note.'), message('info', 'agent', 'Analyse.')] });
    const expected = 'Post the following report verbatim in your reply, including every warning.\n\nPassed.\n\nNote.\n\nThen follow these instructions:\n\nAnalyse.';
    expect(forTurnEnd(result, false)).toEqual({ followup: expected });
    expect(forTurnEnd(result, true)).toEqual({ followup: expected });
    expect(forTurnEnd(answer({ keepWorking: false, messages: [message('verified', 'operator', 'Passed.')] }), false, 'w'))
      .toEqual({ followup: 'Post the following report verbatim in your reply, including every warning.\n\nPassed.\n\nw' });
  });

  it('asks for anything else for the operator to be posted once, and never after a follow-up', () => {
    const result = answer({ keepWorking: false, messages: [message('recorded', 'operator', 'Recorded.')] });
    expect(forTurnEnd(result, false)).toEqual({ followup: `${POST}Recorded.\n\n${CURSOR_WORDS.recorded.operator}` });
    expect(forTurnEnd(result, true)).toEqual({ followup: undefined });
    expect(forTurnEnd(answer({ keepWorking: false }), false, 'capture failed')).toEqual({ followup: `${POST}capture failed` });
  });

  it('sends the failure back once when the referee gives no usable answer', () => {
    expect(forTurnEnd({ problem: 'crashed' }, false)).toEqual({ followup: `${POST}The workflow turn-end hook failed, so nothing was verified: crashed` });
    expect(forTurnEnd({ problem: 'crashed' }, false, 'w').followup.endsWith('crashed\n\nw')).toBe(true);
    expect(forTurnEnd({ problem: 'crashed' }, true)).toEqual({ followup: undefined });
    expect(forTurnEnd(answer({}), false).followup).toContain('the referee answered without what it promises');
  });
});

describe('the helpers', () => {
  it('join only the texts that are there, and leave a message with no words of Cursor\'s as it is', () => {
    expect(joined('a', undefined, '', 'b')).toBe('a\n\nb');
    expect(joined(undefined)).toBeUndefined();
    expect(forTheOperator(undefined)).toBeUndefined();
    expect(inCursorWords(message('needs_plan', 'operator', 'Plan.'))).toBe('Plan.');
    expect(inCursorWords(message('recorded', 'agent', 'Commit.'))).toBe(`Commit.\n\n${CURSOR_WORDS.recorded.agent}`);
    expect(inCursorWords(message('unknown_code', 'agent', 'As is.'))).toBe('As is.');
  });
});

describe('half answers the mutation run found', () => {
  const asked = { writes: [{ path: '/r/a', delete: false }] };

  it('counts a message missing any field, or one that is not an object, as no answer', () => {
    for (const bad of [{ code: 'x', for: 'agent' }, { code: 'x', text: 'y' }, { for: 'agent', text: 'y' }, 'hello', null, 3]) {
      const denied = forWrite(answer({ allow: true, messages: [bad] }), asked);
      expect(denied?.deny, JSON.stringify(bad)).toContain('the referee answered without what it promises');
    }
  });

  it('treats a verification addressed to the agent alone as nothing to report', () => {
    expect(forTurnEnd(answer({ keepWorking: false, messages: [message('verified', 'agent', 'Analyse.')] }), false)).toEqual({ followup: undefined });
  });

  it('prints `{}` to let a call go on, with no empty keys', () => {
    expect(JSON.stringify(preToolOutput(null))).toBe('{}');
    expect(JSON.stringify(promptOutput(undefined))).toBe('{"continue":true}');
    expect(JSON.stringify(stopOutput({ followup: undefined }))).toBe('{}');
  });
});
