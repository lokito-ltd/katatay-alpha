import { describe, expect, it } from 'vitest';
import { CLAUDE_WORDS, EDIT_TOOLS, VERSION, forPlanApproved, forPrompt, forTurnEnd, forWrite, inClaudeWords, toWrite } from './translate.mjs';

const answer = (fields, messages = []) => ({ answer: { version: 1, ...fields, messages } });
const said = (code, audience, text) => ({ code, for: audience, text });
const problem = { problem: 'the referee (`on x`) exited with 1' };

describe('which Claude Code tools write a file', () => {
  it('counts the three editing tools', () => {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) expect(EDIT_TOOLS.has(tool)).toBe(true);
  });

  it('does not count reading, the shell, or a tool Claude Code did not name', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'Task', 'Bash', undefined]) expect(EDIT_TOOLS.has(tool)).toBe(false);
  });
});

describe('the contract version', () => {
  it('is the one the referee speaks', async () => {
    const { VERSION: referee } = await import('../../../workflow/moments/messages.mjs');
    expect(VERSION).toBe(referee);
  });
});

describe('what a tool call asks the referee', () => {
  it('names the one file an edit writes, and never a delete', () => {
    expect(toWrite('Write', { file_path: '/repo/a.ts' })).toEqual({ ask: { version: 1, writes: [{ path: '/repo/a.ts', delete: false }], command: null } });
    expect(toWrite('Edit', { file_path: 'b.ts' })).toEqual({ ask: { version: 1, writes: [{ path: 'b.ts', delete: false }], command: null } });
    expect(toWrite('NotebookEdit', { notebook_path: '/repo/n.ipynb' })).toEqual({ ask: { version: 1, writes: [{ path: '/repo/n.ipynb', delete: false }], command: null } });
  });

  // The referee reads the shell line for locks. The adapter does not judge it.
  it('passes a Bash command line as it is, with no files', () => {
    expect(toWrite('Bash', { command: 'rm -rf x' })).toEqual({ ask: { version: 1, writes: [], command: 'rm -rf x' } });
  });

  // A write to no file cannot be judged, and allowing it would let an edit
  // through whenever Claude Code renamed the field.
  it('denies an edit that names no file', () => {
    for (const toolInput of [{}, { file_path: '' }, { file_path: 3 }, undefined]) {
      const call = toWrite('Write', toolInput);
      expect(call.deny).toMatch(/^The gate cannot tell which file this Write writes/);
    }
  });

  it('asks nothing about a Bash call with no command, or a tool that writes nothing', () => {
    for (const [tool, toolInput] of [['Bash', {}], ['Bash', undefined], ['Bash', { command: '' }], ['Read', { file_path: 'a.ts' }], [undefined, {}]]) {
      expect(toWrite(tool, toolInput)).toBeNull();
    }
  });
});

describe('the answer to a write', () => {
  const writing = { writes: [{ path: 'a.ts', delete: false }], command: null };
  const shell = { writes: [], command: 'ls' };

  it('sends nothing when the referee allows', () => {
    expect(forWrite(answer({ allow: true }), writing)).toBeNull();
  });

  it('denies with the referee\'s message when it does not, a shell command included', () => {
    expect(forWrite(answer({ allow: false }, [said('locked', 'agent', 'This file is locked.')]), writing))
      .toEqual({ via: 'deny', text: 'This file is locked.' });
    expect(forWrite(answer({ allow: false }, [said('locked', 'agent', 'Locked.')]), shell)).toEqual({ via: 'deny', text: 'Locked.' });
  });

  // The denial is shown in the transcript, where the operator sees it too.
  it('denies with a message for the operator the same way', () => {
    expect(forWrite(answer({ allow: false }, [said('stop', 'operator', 'The logbook is broken.')]), writing))
      .toEqual({ via: 'deny', text: 'The logbook is broken.' });
  });

  describe('when the referee gives no usable answer', () => {
    // Which files are safe to write is the referee's to say, so without its
    // answer no file is, a plan or a memory note included.
    it('denies a file write, and says what went wrong', () => {
      const denied = forWrite(problem, writing);
      expect(denied.via).toBe('deny');
      expect(denied.text).toContain('exited with 1');
      expect(denied.text).toMatch(/Stop and tell the operator\.$/);
      expect(denied.text).not.toMatch(/Plan files|FOLLOW-UPS|memory notes/);
    });

    // A referee that half-answers is never read as one that allowed.
    it('denies a write when the answer lacks what it promises, and says what came back', () => {
      const halves = [
        { version: 1 },
        { version: 1, allow: 'yes', messages: [] },
        { version: 1, allow: true },
        { version: 1, allow: true, messages: 'none' },
        { version: 1, allow: false, messages: [{ code: 'locked', text: 'no audience' }] },
        { version: 1, allow: false, messages: [{ code: 'locked', for: 'agent', text: 4 }] },
        { version: 1, allow: false, messages: [{ for: 'agent', text: 'no code' }] },
        { version: 1, allow: false, messages: [null] },
        { version: 1, allow: false, messages: ['Locked.'] },
      ];
      for (const half of halves) {
        const denied = forWrite({ answer: half }, writing);
        expect(denied?.via, JSON.stringify(half)).toBe('deny');
        expect(denied.text).toContain(`The gate got no answer from the referee, so it cannot tell whether this file may be written, and the edit is not permitted: the referee answered without what it promises: ${JSON.stringify(half)}`);
      }
    });

    it('denies a write when the referee denies without saying why', () => {
      const denied = forWrite(answer({ allow: false }), writing);
      expect(denied.via).toBe('deny');
      expect(denied.text).toContain('the referee denied the call without saying why');
    });

    // The referee and the adapter change together, so another number means one
    // of them was left behind, and nothing it says can be read.
    it('denies a write when the answer is in another version, or has none', () => {
      const other = forWrite({ answer: { version: 2, allow: true, messages: [] } }, writing);
      expect(other.via).toBe('deny');
      expect(other.text).toContain('the referee answered version 2, and this adapter speaks 1');
      expect(forWrite({ answer: { version: null, allow: true, messages: [] } }, writing).text).toContain('answered version null');
      const malformed = forWrite({ answer: { version: '1', allow: true, messages: [] } }, writing);
      expect(malformed.via).toBe('deny');
      expect(malformed.text).toContain('answered version "1"');
      const none = forWrite({ answer: { allow: true, messages: [] } }, writing);
      expect(none.via).toBe('deny');
      expect(none.text).toContain('the referee answered without a version');
    });

    // The shell is how anyone finds out what broke, and shell commands were
    // never held for a plan.
    it('leaves a shell command alone', () => {
      expect(forWrite(problem, shell)).toBeNull();
      expect(forWrite({ answer: {} }, shell)).toBeNull();
      expect(forWrite({ answer: { version: 2, allow: false, messages: [] } }, shell)).toBeNull();
    });
  });
});

describe('the answer to a prompt', () => {
  it('puts every message in front of Claude, one line after another, in order', () => {
    const result = answer({}, [
      said('info', 'agent', 'The baseline moved.'),
      said('warning', 'operator', 'settings: a hook is missing. Tell the operator.'),
      said('state', 'agent', 'workflow: open on x'),
    ]);
    expect(forPrompt(result)).toEqual({
      via: 'context',
      text: 'The baseline moved.\nsettings: a hook is missing. Tell the operator.\nworkflow: open on x',
    });
  });

  // Adding a code to the referee must break nothing here.
  it('shows the text of a code it does not know', () => {
    expect(forPrompt(answer({}, [said('something_new', 'agent', 'A new kind of news.')])).text).toBe('A new kind of news.');
  });

  it('says the state is unavailable when there is no answer', () => {
    expect(forPrompt(problem)).toEqual({ via: 'context', text: `workflow: state unavailable (${problem.problem})` });
    expect(forPrompt(answer({})).text).toBe('workflow: state unavailable (the referee answered without what it promises: {"version":1,"messages":[]})');
    expect(forPrompt({ answer: { version: 2, messages: [said('state', 'agent', 'x')] } }).text).toMatch(/^workflow: state unavailable \(the referee answered version 2/);
  });
});

describe('the answer to an approved plan', () => {
  it('passes the referee\'s messages on as one message, a paragraph each', () => {
    const result = answer({ recorded: true }, [
      said('approved', 'agent', 'Plan approval recorded.'),
      said('warning', 'operator', 'This branch already changes 1 file(s).'),
    ]);
    expect(forPlanApproved(result)).toEqual({ via: 'message', text: 'Plan approval recorded.\n\nThis branch already changes 1 file(s).' });
  });

  it('passes a refusal on the same way', () => {
    expect(forPlanApproved(answer({ recorded: false }, [said('refused', 'operator', 'Not recorded: this is main.')])))
      .toEqual({ via: 'message', text: 'Not recorded: this is main.' });
  });

  // The only route to permission, so it must never fail quietly.
  it('says the approval was not recorded when there is no answer', () => {
    expect(forPlanApproved(problem).text).toBe(`The plan was approved, but the workflow hook failed to record it: ${problem.problem}`);
    expect(forPlanApproved(answer({ recorded: 'yes' }, [said('approved', 'agent', 'x')])).text).toMatch(/failed to record it/);
    expect(forPlanApproved(answer({ recorded: true })).text).toMatch(/failed to record it/);
  });
});

describe('the answer to a turn end', () => {
  const report = said('verified', 'operator', 'Verification passed.');
  const triaged = said('triaged', 'operator', 'Triage recorded — risk LOW.');
  const failed = said('verify_failed', 'agent', '`workflow verify` failed.');

  it('sends nothing when the referee has nothing to say', () => {
    expect(forTurnEnd(answer({ keepWorking: false }), false)).toBeNull();
  });

  it('passes the messages on as a message when the turn may end', () => {
    expect(forTurnEnd(answer({ keepWorking: false }, [said('run_triage', 'agent', 'Run triage.')]), false))
      .toEqual({ via: 'message', text: 'Run triage.' });
  });

  // The referee chooses whether the agent keeps working, even after a refused
  // stop: it allows one more there, after a delivered pass, and knows when.
  it('blocks when the referee keeps the agent working, after a refused stop too', () => {
    for (const before of [false, true]) {
      expect(forTurnEnd(answer({ keepWorking: true }, [failed]), before)).toEqual({ via: 'block', text: failed.text });
    }
  });

  // A failure's summary rides on a stop refused anyway to keep Claude working,
  // after a refused stop too, so it never refuses one of its own.
  it('repeats a failure summary for the operator on a stop refused anyway, and only shows it otherwise', () => {
    const summary = said('verify_failed', 'operator', 'Verification failed.');
    const note = said('info', 'agent', '`workflow verify` failed on the current working tree.');
    for (const before of [false, true]) {
      expect(forTurnEnd(answer({ keepWorking: true }, [triaged, summary, note]), before)).toEqual({ via: 'block',
        text: `Repeat this to the operator in full, in your reply:\n\n${triaged.text}\n\n${summary.text}\n\nThen:\n\n${note.text}` });
      expect(forTurnEnd(answer({ keepWorking: false }, [summary, note]), before))
        .toEqual({ via: 'message', text: `${summary.text}\n\n${note.text}` });
    }
  });

  // Only a report is relayed. A stop for the operator already says in its
  // text that the agent is to tell them.
  it('blocks with a stop for the operator as it stands, with no relay', () => {
    expect(forTurnEnd(answer({ keepWorking: true }, [said('stop', 'operator', 'Stop and tell the operator.')]), false))
      .toEqual({ via: 'block', text: 'Stop and tell the operator.' });
  });

  // The desktop app may fold a plain message away, and this is what the
  // operator most needs to read.
  it('refuses the stop to deliver a report for the operator, with every operator message in the relay', () => {
    const warning = said('warning', 'operator', 'settings: a hook is missing. Tell the operator.');
    expect(forTurnEnd(answer({ keepWorking: false }, [triaged, report, warning]), false)).toEqual({
      via: 'block',
      text: 'Repeat this to the operator in full, in your reply:\n\nTriage recorded — risk LOW.\n\nVerification passed.\n\nsettings: a hook is missing. Tell the operator.',
    });
  });

  it('puts the agent\'s own messages after the relay', () => {
    expect(forTurnEnd(answer({ keepWorking: true }, [triaged, failed]), false)).toEqual({
      via: 'block',
      text: 'Repeat this to the operator in full, in your reply:\n\nTriage recorded — risk LOW.\n\nThen:\n\n`workflow verify` failed.',
    });
  });

  it('delivers the fresh verification, warnings and analysis task even after a previous refusal', () => {
    const task = said('info', 'agent', 'Submit the analysis for verification 4.');
    const warning = said('warning', 'operator', 'Setup warning');
    const result = forTurnEnd(answer({ keepWorking: false }, [report, task, warning]), true);
    expect(result.via).toBe('block');
    expect(result.text).toContain('Verification passed.\n\nSetup warning\n\nThen:\n\nSubmit the analysis for verification 4.');
  });

  it.each([
    [triaged, said('info', 'agent', 'Continue after triage.')],
    [report, said('info', 'operator', 'An operator notice.')],
    [report, said('warning', 'agent', 'An agent warning.')],
  ])('does not ask for another stop when the fresh analysis task is absent (%#)', (notice, other) => {
    expect(forTurnEnd(answer({ keepWorking: false }, [notice, other]), true))
      .toEqual({ via: 'message', text: notice.text + '\n\n' + other.text });
  });

  it('relays the compact triage summary and its event link unchanged', () => {
    const summary = said('triaged', 'operator', "Triage recorded.\n\nI assessed the plan's missed predictions and test regressions.\nrisk: LOW\n\nDetails: .katatay/state/topic/0004__triaged.json");
    expect(forTurnEnd(answer({ keepWorking: false }, [summary, report]), false)).toEqual({
      via: 'block',
      text: `Repeat this to the operator in full, in your reply:\n\n${summary.text}\n\nVerification passed.`,
    });
  });

  // Refusing again after a refused stop could hold the turn in a loop.
  it('says a report as a plain message after a refused stop', () => {
    expect(forTurnEnd(answer({ keepWorking: false }, [triaged, report]), true))
      .toEqual({ via: 'message', text: 'Triage recorded — risk LOW.\n\nVerification passed.' });
  });

  // The reminder in phase `verified` is for the agent: relaying it would
  // refuse every stop in that phase.
  it('does not refuse the stop for a report meant for the agent', () => {
    expect(forTurnEnd(answer({ keepWorking: false }, [said('verified', 'agent', 'Verification passed on this tree. Tell the operator.')]), false).via)
      .toBe('message');
  });

  it('shows the text of a code it does not know', () => {
    expect(forTurnEnd(answer({ keepWorking: false }, [said('something_new', 'operator', 'News.')]), false))
      .toEqual({ via: 'message', text: 'News.' });
  });

  // Silence would look exactly like passing.
  it('says nothing was verified when there is no answer, and blocks unless that could loop', () => {
    expect(forTurnEnd(problem, false)).toEqual({ via: 'block', text: `The workflow turn-end hook failed, so nothing was verified: ${problem.problem}` });
    expect(forTurnEnd(problem, true).via).toBe('message');
    expect(forTurnEnd(answer({ keepWorking: 'yes' }, [failed]), false).text).toMatch(/nothing was verified/);
    expect(forTurnEnd({ answer: { version: 2, keepWorking: false, messages: [] } }, false).text).toMatch(/nothing was verified: the referee answered version 2/);
  });
});

// The referee says what to do in words any agent can follow. This adapter adds
// how it is done in Claude Code, for the two codes that need it.
describe('Claude Code\'s own words', () => {
  it('tells the agent how to present a plan when one is needed', () => {
    const denied = forWrite(answer({ allow: false }, [said('needs_plan', 'agent', 'No plan has been approved.')]), { writes: [{ path: 'a.ts', delete: false }], command: null });
    expect(denied.via).toBe('deny');
    expect(denied.text).toBe(`No plan has been approved.\n\n${CLAUDE_WORDS.needs_plan.agent}`);
    expect(denied.text).toMatch(/switch into plan mode \(EnterPlanMode\)[\s\S]*present it with ExitPlanMode/);
    expect(denied.text).toMatch(/memory notes/);
  });

  it('names the commit skill to the agent once the change is recorded', () => {
    expect(forTurnEnd(answer({ keepWorking: true }, [said('recorded', 'agent', 'Recorded. Write the commit message now.')]), false))
      .toEqual({ via: 'block', text: 'Recorded. Write the commit message now.\n\nWrite it with the `commit-message` skill.' });
  });

  // After a refused stop the turn cannot go on, so the operator types `record` for it.
  it('tells the operator Claude writes the commit message with its skill', () => {
    expect(forTurnEnd(answer({ keepWorking: false }, [said('recorded', 'operator', 'Recorded. Type `record` for the commit message.')]), true))
      .toEqual({ via: 'message', text: 'Recorded. Type `record` for the commit message.\n\nClaude writes it with the `commit-message` skill.' });
  });

  it('adds nothing to a code or an audience it has no words for', () => {
    for (const m of [said('locked', 'agent', 'Locked.'), said('needs_plan', 'operator', 'Plan.'), said('something_new', 'agent', 'News.'), said('constructor', 'agent', 'Odd.'), said('recorded', 'toString', 'Odd.')]) {
      expect(inClaudeWords(m), `${m.code}/${m.for}`).toBe(m.text);
    }
  });

  it('adds them in every moment that shows a message', () => {
    const needed = [said('needs_plan', 'agent', 'Present a plan.')];
    expect(forPrompt(answer({}, needed)).text).toContain(CLAUDE_WORDS.needs_plan.agent);
    expect(forPlanApproved(answer({ recorded: false }, needed)).text).toContain(CLAUDE_WORDS.needs_plan.agent);
  });
});
