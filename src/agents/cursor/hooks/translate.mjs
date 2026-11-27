/**
 * The referee's answers, turned into what Cursor reads from a hook.
 *
 * Every moment answers in one shape: `{ version, <decision>, messages }`, with
 * each message `{ code, for, text }` (see "One answer shape" in
 * `../../README.md`). One function per moment takes what `ask` in
 * `referee.mjs` returned, `{ answer }` or `{ problem }`, and gives back what
 * the hook should print. Pure, so every case, the failures above all, can be
 * tested without starting a process.
 *
 * How a message reaches the operator is this adapter's choice. The capture
 * found no hook field that Cursor is known to show the operator, so every
 * message for the operator goes to the agent with an instruction to post it
 * word for word: as context on a prompt, and as a follow-up at the turn end.
 *
 * Every moment fails closed when the referee gives no usable answer, as the
 * other adapters' do:
 *
 * - a file write is denied, and a shell command allowed;
 * - the prompt context says the state is unavailable;
 * - an approval says it was not recorded;
 * - a turn end says nothing was verified, and refuses the stop if it still may.
 *
 * An answer with another version, without the decision its moment promises, or
 * with a message that is not `{ code, for, text }`, counts as no answer, so a
 * referee that half-answers is never read as one that allowed.
 */
import { isAbsolute, resolve } from 'node:path';
import { HARNESS_SCHEMA_VERSION as VERSION } from '../../../schema-version.mjs';
export { VERSION };

/** Texts joined into one message, the ones that are missing left out. */
export const joined = (...texts) => {
  const present = texts.filter((text) => typeof text === 'string' && text !== '');
  return present.length === 0 ? undefined : present.join('\n\n');
};

/**
 * What to ask `on write` about a tool call, from what Cursor sent.
 *
 * - `{ ask: { version, writes, command } }`: a `Write` names the file it
 *   writes, a `Delete` the file it removes, and a `Shell` call passes its
 *   command line as it is.
 * - `{ deny: text }`: a `Write` or `Delete` that names no file. The referee
 *   cannot judge a write to no file, and allowing it would let edits through
 *   whenever Cursor renamed the field.
 * - `null`: nothing the referee needs to see, such as another tool, or a
 *   shell call with no command.
 *
 * Which files are locked or need no plan is the referee's to decide. This
 * only translates. Cursor sends absolute paths; a relative one is read from
 * the repository root.
 *
 * @param {string} tool `tool_name`
 * @param {object} toolInput `tool_input`
 * @param {string} root the repository
 */
export function toWrite(tool, toolInput, root) {
  if (tool === 'Shell') {
    const command = toolInput?.command;
    return typeof command === 'string' && command !== '' ? { ask: { version: VERSION, writes: [], command } } : null;
  }
  if (tool !== 'Write' && tool !== 'Delete') return null;
  const path = toolInput?.file_path;
  if (typeof path !== 'string' || path === '') {
    return { deny: `The gate cannot tell which file this ${tool} call writes, because Cursor sent no \`tool_input.file_path\`, so it is not permitted. Stop and tell the operator: Cursor's tool format may have changed.` };
  }
  return { ask: { version: VERSION, writes: [{ path: isAbsolute(path) ? path : resolve(root, path), delete: tool === 'Delete' }], command: null } };
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
 * Cursor's words, added after the referee's text for the codes that need them.
 * The referee speaks no agent's vocabulary, so it says "present a plan", and
 * this adapter says how that is done in Cursor. Keyed by code, then by who the
 * message is for.
 */
export const CURSOR_WORDS = {
  needs_plan: {
    agent: 'In Cursor: the operator switches Cursor into Plan mode. If it is not in Plan mode, ask them to, and make no edits until then. '
      + 'In Plan mode, present the plan with `CreatePlan`, its sections in the `plan` text. The operator approves it by clicking Build, and the prompt hook records that.',
  },
  recorded: {
    agent: 'Write it with the `commit-message` skill.',
    operator: 'The agent writes it with the `commit-message` skill.',
  },
};

/** A message's text, with Cursor's words for its code added. */
export const inCursorWords = (m) => {
  const words = Object.hasOwn(CURSOR_WORDS, m.code) && Object.hasOwn(CURSOR_WORDS[m.code], m.for) ? CURSOR_WORDS[m.code][m.for] : undefined;
  return words === undefined ? m.text : `${m.text}\n\n${words}`;
};

/** The messages' texts, in the order the referee gave them, in Cursor's words. */
const said = (messages, between = '\n\n') => messages.map(inCursorWords).join(between);

/** How a text for the operator is handed to the agent, which is the only one Cursor shows it to. */
export const forTheOperator = (text) => (text === undefined ? undefined
  : `Post the following for the operator verbatim in your reply, through any \`Details:\` line:\n\n${text}`);

/** The operator's messages only, or undefined when there are none. */
const forOperator = (messages) => {
  const theirs = messages.filter((m) => m.for === 'operator');
  return theirs.length === 0 ? undefined : said(theirs);
};

/**
 * Before a tool call: a denial with the referee's reasons, or null to let the
 * call go on.
 *
 * With no usable answer, a file write is denied, whatever the file: which
 * files are safe to write is the referee's to say, and nobody said it. A
 * shell command is allowed. With the referee down, the shell is how anyone
 * finds out what broke.
 *
 * @param {{ answer: object } | { problem: string }} result
 * @param {{ writes: object[] }} asked what the hook asked
 * @returns {{ deny: string } | null}
 */
export function forWrite(result, { writes }) {
  const wrong = trouble(result, 'allow') ?? (result.answer.allow === false && result.answer.messages.length === 0
    ? `the referee denied the call without saying why: ${JSON.stringify(result.answer)}`
    : null);
  if (wrong === null) return result.answer.allow ? null : { deny: said(result.answer.messages) };
  if (writes.length === 0) return null;
  return {
    deny: `The gate got no answer from the referee, so it cannot tell whether this file may be written, and the call is not permitted: ${wrong}\n\n`
      + 'Stop and tell the operator.',
  };
}

/** A prompt: the context for the agent, every message, with the operator's marked for posting. */
export function forPrompt(result) {
  const wrong = trouble(result, null, { atLeastOne: true });
  if (wrong !== null) return `workflow: state unavailable (${wrong})`;
  const { messages } = result.answer;
  return joined(forTheOperator(forOperator(messages)), said(messages.filter((m) => m.for !== 'operator'), '\n'));
}

/**
 * An approved plan: `{ context }`. Whether it was recorded matters to both
 * the operator, who clicked Build, and the agent, which is about to act on it.
 */
export function forPlanApproved(result) {
  const wrong = trouble(result, 'recorded', { atLeastOne: true });
  const text = wrong === null ? said(result.answer.messages) : `The plan was built, but the workflow hook failed to record it: ${wrong}`;
  return { context: forTheOperator(text) };
}

/**
 * The turn's end: `{ followup }`, the message Cursor sends the agent as a new
 * prompt, or undefined to let the turn end.
 *
 * - The referee says `keepWorking`: every message goes back to the agent.
 * - A fresh verification for the operator: the report goes back to the agent
 *   to post word for word, even after a refused stop. The referee addresses
 *   it to the operator once.
 * - Anything else for the operator: posted the same way, unless the stop was
 *   already refused once in this turn, so a turn end cannot loop.
 * - Messages only for the agent, with nothing to do: dropped. No agent reads
 *   them after its turn, and the next prompt carries the state.
 *
 * @param {{ answer: object } | { problem: string }} result
 * @param {boolean} stopRefusedBefore whether Cursor's `loop_count` is above 0
 * @param {string} [warning] the adapter's own warning, such as a plan capture problem
 */
export function forTurnEnd(result, stopRefusedBefore, warning) {
  const wrong = trouble(result, 'keepWorking');
  if (wrong !== null) {
    const text = `The workflow turn-end hook failed, so nothing was verified: ${wrong}`;
    return { followup: stopRefusedBefore ? undefined : forTheOperator(joined(text, warning)) };
  }
  const { keepWorking, messages } = result.answer;
  if (messages.some((m) => m.code === 'verified' && m.for === 'operator')) {
    const report = messages.filter((m) => m.for === 'operator');
    const instructions = messages.filter((m) => m.for !== 'operator');
    return {
      followup: 'Post the following report verbatim in your reply, including every warning.\n\n'
        + joined(...report.map((m) => m.text), warning)
        + (instructions.length ? `\n\nThen follow these instructions:\n\n${said(instructions)}` : ''),
    };
  }
  if (keepWorking) {
    return { followup: joined(forTheOperator(joined(forOperator(messages), warning)), said(messages.filter((m) => m.for !== 'operator'))) };
  }
  const operator = joined(forOperator(messages), warning);
  return { followup: stopRefusedBefore ? undefined : forTheOperator(operator) };
}

/*
 * What each hook prints. Cursor's shapes, from its hook documentation and the
 * 2026-11-26 capture.
 */

/**
 * Before a tool call: a denial, or `{}` to let the call go on.
 *
 * Never `permission: "allow"`: that could answer for the operator a question
 * Cursor would otherwise ask them, such as whether to run a shell command.
 * The capture showed `{}` from one hook letting the call go on beside
 * another hook's answer. A permission hook must print JSON, because Cursor
 * blocks the call when one prints anything else.
 *
 * @param {{ deny: string } | null} decision
 * @param {string} [warning] a drift warning, carried in front of the agent's message
 */
export const preToolOutput = (decision, warning) => {
  if (decision === null) return warning === undefined ? {} : { agent_message: warning };
  const text = joined(warning, decision.deny);
  return { permission: 'deny', agent_message: text, user_message: text };
};

/** A prompt: let it through, with context for the agent. */
export const promptOutput = (context) => ({ continue: true, ...(context === undefined ? {} : { additional_context: context }) });

/** The turn's end: a follow-up for the agent, or `{}`. */
export const stopOutput = ({ followup }) => (followup === undefined ? {} : { followup_message: followup });
