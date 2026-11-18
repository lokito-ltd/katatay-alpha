/**
 * The referee's answers, turned into what Claude Code reads from a hook.
 *
 * Every moment answers in one shape: `{ version, <decision>, messages }`, with
 * each message `{ code, for, text }` (see "One answer shape" in
 * `../../README.md`). One function per moment takes what `ask` in
 * `referee.mjs` returned — `{ answer }` or `{ problem }` — and gives back what
 * the hook should send: `{ via, text }`, where `via` is one of the shapes
 * `io.mjs` writes, or `null` when the hook should send nothing. Pure, so every
 * case, the failures above all, can be tested without starting a process.
 *
 * How a message reaches the operator is this adapter's choice. Claude Code has
 * no way to show the operator something at a stop except a message the
 * desktop app may fold away, so the reports the operator most needs to read,
 * `verified` and `triaged`, are delivered by refusing the stop and having
 * Claude repeat them. Every other message is shown as its text, whatever its
 * code. A code this file does not know is shown the same way, so the referee
 * can add one without breaking anything here.
 *
 * Each moment handles an unusable answer in the way
 * its hook failed before the referee was a command:
 *
 * - a file write is denied, and a shell command allowed;
 * - presentation warns without blocking the operator's dialog;
 * - the prompt context says the state is unavailable;
 * - an approval says it was not recorded;
 * - a turn end says nothing was verified, and refuses the stop if it still may.
 *
 * An answer with another version, without the decision its moment promises, or
 * with a message that is not `{ code, for, text }`, counts as no answer, so a
 * referee that half-answers is never read as one that allowed.
 */

import { HARNESS_SCHEMA_VERSION as VERSION } from '../../../schema-version.mjs';
export { VERSION };

/** Claude Code's tools that write one file, named in `file_path` or `notebook_path`. */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * What to ask `on write` about a tool call, from what Claude Code sent.
 *
 * - `{ ask: { version, writes, command } }`: an edit names its one file, never
 *   a delete (no Claude tool deletes a file except through the shell), and a
 *   Bash call passes its command line as it is.
 * - `{ deny: text }`: an edit tool with no file path. The referee cannot judge
 *   a write to no file, and allowing it would let an edit through whenever
 *   Claude Code renamed the field.
 * - `null`: nothing the referee needs to see, such as a Bash call with no
 *   command.
 *
 * Which files are locked or need no plan is the referee's to decide. This
 * only translates.
 */
export function toWrite(tool, toolInput) {
  if (tool === 'Bash') {
    const command = toolInput?.command;
    return typeof command === 'string' && command !== '' ? { ask: { version: VERSION, writes: [], command } } : null;
  }
  if (!EDIT_TOOLS.has(tool)) return null;
  const path = toolInput?.file_path ?? toolInput?.notebook_path;
  if (typeof path !== 'string' || path === '') {
    return { deny: `The gate cannot tell which file this ${tool} writes, because Claude Code sent no file path, so the edit is not permitted. Stop and tell the operator: the hook's payload has changed shape.` };
  }
  return { ask: { version: VERSION, writes: [{ path, delete: false }], command: null } };
}

const isText = (value) => typeof value === 'string';
const isMessage = (m) => m !== null && typeof m === 'object' && isText(m.code) && isText(m.for) && isText(m.text);

/**
 * What is wrong with the result, or null when it is a usable answer.
 *
 * @param {{ answer: object } | { problem: string }} result
 * @param {string|null} decision the boolean field the moment promises, or null for none
 * @param {{ atLeastOne?: boolean }} [rules] whether the answer must say something
 */
function trouble(result, decision, { atLeastOne = false } = {}) {
  if ('problem' in result) return result.problem;
  const a = result.answer;
  if (a.version !== VERSION) {
    return a.version === undefined
      ? `the referee answered without a version: ${JSON.stringify(a)}`
      : `the referee answered version ${JSON.stringify(a.version)}, and this adapter speaks ${VERSION}`;
  }
  const wrong = `the referee answered without what it promises: ${JSON.stringify(a)}`;
  if (decision !== null && typeof a[decision] !== 'boolean') return wrong;
  if (!Array.isArray(a.messages) || !a.messages.every(isMessage)) return wrong;
  if (atLeastOne && a.messages.length === 0) return wrong;
  return null;
}

/**
 * Claude Code's words, added after the referee's text for the codes that need
 * them. The referee speaks no agent's vocabulary (see "One answer shape" in
 * `../../README.md`), so it says "present a plan" and "write the commit
 * message", and this adapter says how that is done in Claude Code: which tools
 * open and close plan mode, which skill writes the message. Keyed by code, then
 * by who the message is for. A code or audience with nothing here is shown as
 * the referee wrote it.
 */
export const CLAUDE_WORDS = {
  needs_plan: {
    agent: 'In Claude Code: switch into plan mode (EnterPlanMode), write the plan to the plan file, and present it with ExitPlanMode. '
      + 'The operator approves it in the plan-mode dialog. That click is the approval, and a hook records it. '
      + 'Your memory notes can still be written too.',
  },
  recorded: {
    agent: 'Write it with the `commit-message` skill.',
    operator: 'Claude writes it with the `commit-message` skill.',
  },
};

/** A message's text, with Claude Code's words for its code added. */
export const inClaudeWords = (m) => {
  const words = Object.hasOwn(CLAUDE_WORDS, m.code) && Object.hasOwn(CLAUDE_WORDS[m.code], m.for) ? CLAUDE_WORDS[m.code][m.for] : undefined;
  return words === undefined ? m.text : `${m.text}\n\n${words}`;
};

/** The messages' texts, in the order the referee gave them, in Claude Code's words. */
const said = (messages, between = '\n\n') => messages.map(inClaudeWords).join(between);

/**
 * Before a tool call: `deny` with the referee's reasons, or nothing.
 *
 * Claude Code shows a denial's reason in the transcript, where the operator
 * sees it as well, so a message for the operator needs nothing more.
 *
 * With no usable answer, a file write is denied, whatever the file: which
 * files are safe to write is the referee's to say, and nobody said it. A
 * shell command is allowed. Shell commands were never held for a plan, and
 * with the referee down the shell is how anyone finds out what broke. The
 * locks it would have checked are the price, until the referee answers again.
 *
 * @param {{ answer: object } | { problem: string }} result
 * @param {{ writes: object[], command: string|null }} asked what the hook asked
 */
export function forWrite(result, { writes }) {
  // A denial with nothing to say why would leave the agent guessing, so it is
  // no answer, like any other half answer.
  const wrong = trouble(result, 'allow') ?? (result.answer.allow === false && result.answer.messages.length === 0
    ? `the referee denied the call without saying why: ${JSON.stringify(result.answer)}`
    : null);
  if (wrong === null) return result.answer.allow ? null : { via: 'deny', text: said(result.answer.messages) };
  if (writes.length === 0) return null;
  return {
    via: 'deny',
    text: `The gate got no answer from the referee, so it cannot tell whether this file may be written, and the edit is not permitted: ${wrong}\n\n`
      + 'Stop and tell the operator.',
  };
}

/**
 * A prompt: the context to put in front of Claude for this turn, every
 * message one after another. A message for the operator says in its text that
 * it is to be passed on, as the change report at `record` does.
 */
export function forPrompt(result) {
  const wrong = trouble(result, null, { atLeastOne: true });
  return { via: 'context', text: wrong === null ? said(result.answer.messages, '\n') : `workflow: state unavailable (${wrong})` };
}

/** An approved plan: a message saying what was recorded, or that nothing was. */
export function forPlanApproved(result) {
  const wrong = trouble(result, 'recorded', { atLeastOne: true });
  return {
    via: 'message',
    text: wrong === null ? said(result.answer.messages) : `The plan was approved, but the workflow hook failed to record it: ${wrong}`,
  };
}

/** A courtesy failure warns; only invalid contents can request one correction. */
export function planCheck(result) {
  const wrong = trouble(result, 'needsCorrection');
  if (wrong !== null) return { needsCorrection: false, text: `The presented plan could not be checked: ${wrong}` };
  const { needsCorrection, messages } = result.answer;
  if (needsCorrection && messages.length === 0) {
    return { needsCorrection: false, text: 'The presented-plan checker requested a correction without an explanation; presentation continues.' };
  }
  return {
    needsCorrection,
    text: said(messages),
  };
}

/** The reports the operator most needs to read, which a stop is refused to deliver. */
const REPORTS = new Set(['verified', 'triaged']);

/**
 * The turn's end: `block` to keep Claude going, `message` for the operator, or
 * nothing.
 *
 * The stop is refused when the referee says `keepWorking`, and also to deliver
 * a report for the operator. Claude then repeats every message for the
 * operator in its reply, and does what the rest ask after that. A report is
 * delivered this way only when no stop was refused before in this turn:
 * refusing again there could hold the turn in a loop, so it goes out as a
 * plain message instead. The referee knows which stops a turn has had, and
 * allows one more `keepWorking` after a delivery, so a failure found on that
 * pass still gets through. A failed verify's summary for the operator is
 * repeated the same way, but only on a stop refused anyway to keep Claude
 * working.
 *
 * Only when there is no answer does this choose by itself, and it refuses the
 * stop unless `stopRefusedBefore` says that may loop.
 *
 * @param {{ answer: object } | { problem: string }} result
 * @param {boolean} stopRefusedBefore Claude Code's `stop_hook_active`
 */
export function forTurnEnd(result, stopRefusedBefore) {
  const wrong = trouble(result, 'keepWorking');
  if (wrong !== null) {
    return { via: stopRefusedBefore ? 'message' : 'block', text: `The workflow turn-end hook failed, so nothing was verified: ${wrong}` };
  }
  const { keepWorking, messages } = result.answer;
  if (messages.length === 0) return null;
  const forOperator = messages.filter((m) => m.for === 'operator');
  const freshAnalysis = forOperator.some(m => m.code === 'verified') && messages.some(m => m.for === 'agent' && m.code === 'info');
  // A failed verify's summary rides on a stop already refused to keep Claude
  // working. It never refuses a stop of its own, so a failure cannot hold a
  // turn in a loop.
  const failure = keepWorking && forOperator.some((m) => m.code === 'verify_failed');
  const deliver = freshAnalysis || failure || (!stopRefusedBefore && forOperator.some((m) => REPORTS.has(m.code)));
  if (!keepWorking && !deliver) return { via: 'message', text: said(messages) };
  if (!deliver) return { via: 'block', text: said(messages) };
  const rest = messages.filter((m) => m.for !== 'operator');
  return {
    via: 'block',
    text: `Repeat this to the operator in full, in your reply:\n\n${said(forOperator)}`
      + (rest.length > 0 ? `\n\nThen:\n\n${said(rest)}` : ''),
  };
}
