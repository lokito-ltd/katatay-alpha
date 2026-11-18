import { describe, expect, it } from 'vitest';
import {
  CODEX_WORDS, VERSION, bypassWarning, forPlanApproved, forPrompt, forTurnEnd, forWrite, inCodexWords,
  preToolDrift, preToolOutput, promptOutput, stopOutput, toWrite, triageReplyId,
} from './translate.mjs';
import { payload } from '../../../../tests/fixtures/codex/payloads.mjs';

const answer = (fields, messages = []) => ({ answer: { version: 1, ...fields, messages } });
const said = (code, audience, text) => ({ code, for: audience, text });
const problem = { problem: 'the referee (`on x`) exited with 1' };
const paths = { home: '/home/op', repo: '/repo' };

describe('the contract version', () => {
  // The hooks may not import the referee, so the number is repeated here. It
  // must be the referee's.
  it('is the one the referee speaks', async () => {
    const { VERSION: referee } = await import('../../../workflow/moments/messages.mjs');
    expect(VERSION).toBe(referee);
  });
});

describe('what a tool call asks the referee', () => {
  it('names every file a captured patch writes, and no command', () => {
    const { tool_name: tool, tool_input: toolInput, cwd } = payload('pre-tool-use-apply-patch', {}, paths);
    expect(toWrite(tool, toolInput, cwd)).toEqual({
      ask: {
        version: 1,
        writes: [
          { path: '/repo/a.txt', delete: false }, { path: '/repo/b.txt', delete: true },
          { path: '/repo/c.txt', delete: false }, { path: '/repo/notes.md', delete: true },
        ],
        command: null,
      },
    });
  });

  // The referee reads the shell line for locks. The adapter does not judge it.
  it('passes a captured shell line as it is, with no files', () => {
    const { tool_name: tool, tool_input: toolInput, cwd } = payload('pre-tool-use-bash', {}, paths);
    expect(toWrite(tool, toolInput, cwd)).toEqual({ ask: { version: 1, writes: [], command: toolInput.command } });
  });

  // A patch the gate cannot read is not one it can allow.
  it('denies a patch that names no file, or has no command at all', () => {
    expect(toWrite('apply_patch', { command: '*** Begin Patch\n*** End Patch' }, '/repo').deny).toMatch(/names none/);
    expect(toWrite('apply_patch', {}, '/repo').deny).toMatch(/names none/);
  });

  it('asks nothing about another tool, or a shell call with no command', () => {
    expect(toWrite('request_user_input', { questions: [] }, '/repo')).toBe(null);
    expect(toWrite('mcp__files__write', { path: 'x' }, '/repo')).toBe(null);
    expect(toWrite('Bash', { command: '' }, '/repo')).toBe(null);
    expect(toWrite('Bash', undefined, '/repo')).toBe(null);
  });
});

describe('Codex\'s words', () => {
  it('say how a plan is presented in Codex', () => {
    expect(inCodexWords(said('needs_plan', 'agent', 'Present a plan.'))).toBe(`Present a plan.\n\n${CODEX_WORDS.needs_plan.agent}`);
    expect(CODEX_WORDS.needs_plan.agent).toMatch(/Plan mode/);
    expect(CODEX_WORDS.needs_plan.agent).toMatch(/<proposed_plan>/);
  });

  it('name the commit skill, for the agent and for the operator', () => {
    expect(inCodexWords(said('recorded', 'agent', 'Recorded.'))).toMatch(/commit-message/);
    expect(inCodexWords(said('recorded', 'operator', 'Recorded.'))).toBe('Recorded.\n\nCodex writes it with the `commit-message` skill.');
  });

  // An unknown code is shown as it is, so the referee can add one.
  it('leave every other message as the referee wrote it', () => {
    expect(inCodexWords(said('something_new', 'agent', 'As is.'))).toBe('As is.');
    expect(inCodexWords(said('needs_plan', 'operator', 'As is.'))).toBe('As is.');
  });
});

describe('a tool call', () => {
  const asked = { writes: [{ path: '/repo/a', delete: false }] };
  const shell = { writes: [] };

  it('is allowed when the referee allows it', () => {
    expect(forWrite(answer({ allow: true }), asked)).toBe(null);
  });

  it('is denied with the referee\'s reasons, in Codex\'s words', () => {
    expect(forWrite(answer({ allow: false }, [said('needs_plan', 'agent', 'No plan.')]), asked)).toEqual({ deny: `No plan.\n\n${CODEX_WORDS.needs_plan.agent}` });
  });

  it('denies a file write when the referee gives no answer, and allows a shell command', () => {
    expect(forWrite(problem, asked).deny).toMatch(/got no answer from the referee/);
    expect(forWrite(problem, shell)).toBe(null);
  });

  it('reads a half answer as no answer', () => {
    expect(forWrite({ answer: { version: 2, allow: true, messages: [] } }, asked).deny).toMatch(/version 2/);
    expect(forWrite({ answer: { allow: true, messages: [] } }, asked).deny).toMatch(/without a version/);
    expect(forWrite({ answer: { version: null, allow: true, messages: [] } }, asked).deny).toContain('answered version null');
    expect(forWrite({ answer: { version: '1', allow: true, messages: [] } }, asked).deny).toContain('answered version "1"');
    expect(forWrite({ answer: { version: 1, messages: [] } }, asked).deny).toMatch(/without what it promises/);
    expect(forWrite({ answer: { version: 1, allow: true, messages: [{ code: 'x' }] } }, asked).deny).toMatch(/without what it promises/);
    expect(forWrite(answer({ allow: false }), asked).deny).toMatch(/without saying why/);
  });

  it('prints a denial as Codex reads one, and nothing to allow', () => {
    expect(preToolOutput({ deny: 'No.' })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No.' } });
    expect(preToolOutput(null)).toBe(null);
  });

  // PreToolUse takes no systemMessage, and a field it does not support lets
  // the call through, so drift rides in a field it does support.
  it('carries a drift warning in the denial, or as context on an allowed call', () => {
    expect(preToolDrift(preToolOutput({ deny: 'No.' }), 'Drift.').hookSpecificOutput.permissionDecisionReason).toBe('Drift.\n\nNo.');
    expect(preToolDrift(null, 'Drift.')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Drift.' } });
    expect(JSON.stringify(preToolDrift(null, 'Drift.'))).not.toContain('systemMessage');
  });
});

describe('a prompt', () => {
  it('gives the agent every message, and the operator theirs', () => {
    const result = answer({}, [said('declared', 'operator', 'The report.'), said('state', 'agent', 'implementing')]);
    expect(forPrompt(result)).toEqual({ context: 'The report.\nimplementing', operator: 'The report.' });
  });

  it('shows the operator nothing when nothing is for them', () => {
    expect(forPrompt(answer({}, [said('state', 'agent', 'open')])).operator).toBe(undefined);
  });

  it('says the state is unavailable when the referee gives no answer, or says nothing', () => {
    expect(forPrompt(problem)).toEqual({ context: `workflow: state unavailable (${problem.problem})`, operator: undefined });
    expect(forPrompt(answer({})).context).toMatch(/state unavailable/);
  });

  it('prints context, and a message for the operator only when there is one', () => {
    expect(promptOutput({ context: 'c', operator: 'o' })).toEqual({ systemMessage: 'o', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'c' } });
    expect(promptOutput({ context: 'c', operator: undefined })).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'c' } });
  });

  it('warns the operator when Codex runs with approvals off', () => {
    expect(bypassWarning(payload('user-prompt-submit-exec', {}, paths).permission_mode)).toMatch(/approvals off/);
    expect(bypassWarning(payload('user-prompt-submit', {}, paths).permission_mode)).toBe(undefined);
    expect(bypassWarning(undefined)).toBe(undefined);
  });
});

describe('an approved plan', () => {
  it('tells both the agent and the operator what was recorded', () => {
    expect(forPlanApproved(answer({ recorded: true }, [said('approved', 'agent', 'Approved.')]))).toEqual({ context: 'Approved.', operator: 'Approved.' });
  });

  it('says it was not recorded when the referee gives no answer', () => {
    const { context, operator } = forPlanApproved(problem);
    expect(context).toMatch(/failed to record it/);
    expect(operator).toBe(context);
    expect(forPlanApproved(answer({ recorded: true })).context).toMatch(/failed to record it/);
  });
});

describe('the end of a turn', () => {
  it('identifies only a current final reply headed Triage recorded', () => {
    const reply = '**Triage recorded**\n\nOne surprise.';
    const id = triageReplyId('turn', reply);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(triageReplyId('turn', reply)).toBe(id);
    expect(triageReplyId('another turn', reply)).not.toBe(id);
    for (const text of ['Triage recorded', '## Triage recorded']) expect(triageReplyId('turn', text)).toBeDefined();
    for (const text of [null, 'Completed.\n\nTriage recorded', 'Triage recorded previously.']) {
      expect(triageReplyId('turn', text)).toBeUndefined();
    }
    expect(triageReplyId(null, reply)).toBeUndefined();
  });
  it.each([false, true])('relays a newly recorded report and its warnings verbatim (prior refusal: %s)', (prior) => {
    const report = 'Verification passed.\n\nTest quality:\n  uncovered line 13\n  survivor: x !== y';
    const warning = 'Warning one.\n  detail';
    const triage = 'Triage recorded.\n\nsurprises:\n  an unexpected failure';
    const messages = [said('triaged', 'operator', triage), said('verified', 'operator', report),
      said('warning', 'operator', warning), said('info', 'agent', 'Next step.')];
    expect(forTurnEnd(answer({ keepWorking: false }, messages), prior)).toEqual({
      block: `Post the following report verbatim in your reply, including every warning.\n\n${triage}\n\n${report}\n\n${warning}\n\nThen follow these instructions:\n\nNext step.`,
      operator: undefined,
    });
  });

  it('relays the compact triage summary and its event link unchanged', () => {
    const triage = "Triage recorded.\n\nI assessed the plan's missed predictions and test regressions.\nrisk: LOW\n\nDetails: .katatay/state/topic/0004__triaged.json";
    const messages = [said('triaged', 'operator', triage), said('verified', 'operator', 'Verification passed.')];
    expect(forTurnEnd(answer({ keepWorking: false }, messages), false)).toEqual({
      block: `Post the following report verbatim in your reply, including every warning.\n\n${triage}\n\nVerification passed.`,
      operator: undefined,
    });
  });

  it('lets a receipt reminder end the turn without requesting a second relay', () => {
    const messages = [said('verified', 'agent', 'The tree is verified.'), said('warning', 'operator', 'Warning.')];
    expect(forTurnEnd(answer({ keepWorking: false }, messages), true))
      .toEqual({ block: undefined, operator: 'The tree is verified.\n\nWarning.' });
  });

  it('refuses the stop with every message, and shows the operator theirs', () => {
    const result = answer({ keepWorking: true }, [said('verify_failed', 'agent', 'Fix it.'), said('warning', 'operator', 'Careful.')]);
    expect(forTurnEnd(result, false)).toEqual({ block: 'Fix it.\n\nCareful.', operator: 'Careful.' });
  });

  // Codex shows the operator what is theirs directly: the failure's summary,
  // never the agent's note and the output's tail.
  it('shows the operator a failure summary, and keeps the agent\'s note for the agent', () => {
    const result = answer({ keepWorking: true }, [said('verify_failed', 'operator', 'Verification failed.'), said('info', 'agent', 'Fix it.\n\ntail')]);
    expect(forTurnEnd(result, false)).toEqual({ block: 'Verification failed.\n\nFix it.\n\ntail', operator: 'Verification failed.' });
  });

  it('says nothing when there is nothing to say', () => {
    expect(forTurnEnd(answer({ keepWorking: false }), false)).toEqual({ block: undefined, operator: undefined });
  });

  // With no answer it refuses the stop, unless that could hold the turn in a loop.
  it('says nothing was verified when the referee gives no answer', () => {
    expect(forTurnEnd(problem, false).block).toMatch(/nothing was verified/);
    expect(forTurnEnd(problem, true)).toEqual({ block: undefined, operator: expect.stringMatching(/nothing was verified/) });
  });

  it('prints a refused stop, a message, both, or an empty object, which Codex needs', () => {
    expect(stopOutput({ block: 'r', operator: 'o' })).toEqual({ decision: 'block', reason: 'r', systemMessage: 'o' });
    expect(stopOutput({ block: undefined, operator: 'o' })).toEqual({ systemMessage: 'o' });
    expect(stopOutput({ block: undefined, operator: undefined })).toEqual({});
  });
});

describe('a message the referee half-wrote', () => {
  const asked = { writes: [{ path: '/repo/a', delete: false }] };
  const whole = { code: 'locked', for: 'agent', text: 'Locked.' };

  // Every part of `{ code, for, text }` must be text. Anything less is no
  // answer, so the write is denied rather than read as allowed.
  it('is no answer, whichever part is missing or not text', () => {
    const broken = [null, 'Locked.', 7, [], { for: 'agent', text: 'x' }, { code: 'x', text: 'x' }, { code: 'x', for: 'agent' },
      { ...whole, code: 1 }, { ...whole, for: null }, { ...whole, text: {} }];
    for (const message of broken) {
      expect(forWrite({ answer: { version: 1, allow: true, messages: [message] } }, asked)?.deny, JSON.stringify(message)).toMatch(/without what it promises/);
    }
  });

  it('is read whole when every part is text', () => {
    expect(forWrite({ answer: { version: 1, allow: false, messages: [whole] } }, asked)).toEqual({ deny: 'Locked.' });
  });

  it('is no answer when the messages are not a list', () => {
    expect(forWrite({ answer: { version: 1, allow: true, messages: 'x' } }, asked).deny).toMatch(/without what it promises/);
  });
});
