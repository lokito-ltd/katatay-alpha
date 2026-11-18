/**
 * The referee's answers, turned into what Codex reads from a hook.
 *
 * Every moment answers in one shape: `{ version, <decision>, messages }`, with
 * each message `{ code, for, text }` (see "One answer shape" in
 * `../../README.md`). One function per moment takes what `ask` in
 * `referee.mjs` returned, `{ answer }` or `{ problem }`, and gives back what
 * the hook should print. Pure, so every case, the failures above all, can be
 * tested without starting a process.
 *
 * How a message reaches the operator is this adapter's choice. Codex shows a
 * hook's `systemMessage` to the operator, so every message for the operator
 * normally goes there. A fresh verification report goes in the block reason
 * instead, so Codex posts it in the chat in both the CLI and desktop app.
 *
 * Every moment fails closed when the referee gives no usable answer, as the
 * Claude adapter's do:
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
import { createHash } from 'node:crypto';
import { patchWrites } from '../patch.mjs';
import { joined } from './io.mjs';
import { HARNESS_SCHEMA_VERSION as VERSION } from '../../../schema-version.mjs';
export { VERSION };

/** Only the current Stop payload can announce a triage reply. Both copies of
 * a Stop get the same key, and another turn reporting the same counts does not.
 */
export function triageReplyId(turnId, text) {
  if (typeof turnId !== 'string' || !turnId || typeof text !== 'string') return undefined;
  const heading = text.trimStart().split('\n', 1)[0].trim();
  if (!/^(?:#{1,6} )?(?:Triage recorded|\*\*Triage recorded\*\*)$/.test(heading)) return undefined;
  return createHash('sha256').update(JSON.stringify([turnId, text])).digest('hex');
}

/**
 * What to ask `on write` about a tool call, from what Codex sent.
 *
 * - `{ ask: { version, writes, command } }`: a patch names each file it
 *   writes, and a shell call passes its command line as it is.
 * - `{ deny: text }`: a patch that names no file. The referee cannot judge a
 *   write to no file, and allowing it would let a patch through whenever
 *   Codex changed its format.
 * - `null`: nothing the referee needs to see, such as another tool, or a
 *   shell call with no command.
 *
 * Which files are locked or need no plan is the referee's to decide. This
 * only translates.
 *
 * @param {string} tool `tool_name`
 * @param {object} toolInput `tool_input`
 * @param {string} cwd the payload's `cwd`, which a patch's relative paths are resolved against
 */
export function toWrite(tool, toolInput, cwd) {
  const command = toolInput?.command;
  if (tool === 'Bash') {
    return typeof command === 'string' && command !== '' ? { ask: { version: VERSION, writes: [], command } } : null;
  }
  if (tool !== 'apply_patch') return null;
  const writes = typeof command === 'string' ? patchWrites(command, cwd) : [];
  if (writes.length === 0) {
    return { deny: 'The gate cannot tell which files this patch writes, because it names none in an `*** Add File:`, `*** Update File:`, `*** Move to:` or `*** Delete File:` line, so it is not permitted. Stop and tell the operator: the patch format may have changed.' };
  }
  return { ask: { version: VERSION, writes, command: null } };
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
 * Codex's words, added after the referee's text for the codes that need them.
 * The referee speaks no agent's vocabulary, so it says "present a plan", and
 * this adapter says how that is done in Codex. Keyed by code, then by who the
 * message is for.
 */
export const CODEX_WORDS = {
  needs_plan: {
    agent: 'In Codex: the operator switches Codex into Plan mode (Shift+Tab). If it is not in Plan mode, ask them to, and make no edits until then. '
      + 'In Plan mode, present the whole plan as one `<proposed_plan>` block. The operator approves it with "Yes, implement this plan", '
      + 'or "Yes, clear context and implement", and the prompt hook records that.',
  },
  recorded: {
    agent: 'Write it with the `commit-message` skill.',
    operator: 'Codex writes it with the `commit-message` skill.',
  },
};

/** A message's text, with Codex's words for its code added. */
export const inCodexWords = (m) => {
  const words = Object.hasOwn(CODEX_WORDS, m.code) && Object.hasOwn(CODEX_WORDS[m.code], m.for) ? CODEX_WORDS[m.code][m.for] : undefined;
  return words === undefined ? m.text : `${m.text}\n\n${words}`;
};

/** The messages' texts, in the order the referee gave them, in Codex's words. */
const said = (messages, between = '\n\n') => messages.map(inCodexWords).join(between);

/** The operator's messages only, or undefined when there are none. */
const forOperator = (messages) => {
  const theirs = messages.filter((m) => m.for === 'operator');
  return theirs.length === 0 ? undefined : said(theirs);
};

/**
 * Before a tool call: a denial with the referee's reasons, or null to allow.
 *
 * With no usable answer, a file write is denied, whatever the file: which
 * files are safe to write is the referee's to say, and nobody said it. A
 * shell command is allowed. With the referee down, the shell is how anyone
 * finds out what broke. The locks it would have checked are the price, until
 * the referee answers again.
 *
 * @param {{ answer: object } | { problem: string }} result
 * @param {{ writes: object[] }} asked what the hook asked
 * @returns {{ deny: string } | null}
 */
export function forWrite(result, { writes }) {
  // A denial with nothing to say why would leave the agent guessing, so it is
  // no answer, like any other half answer.
  const wrong = trouble(result, 'allow') ?? (result.answer.allow === false && result.answer.messages.length === 0
    ? `the referee denied the call without saying why: ${JSON.stringify(result.answer)}`
    : null);
  if (wrong === null) return result.answer.allow ? null : { deny: said(result.answer.messages) };
  if (writes.length === 0) return null;
  return {
    deny: `The gate got no answer from the referee, so it cannot tell whether these files may be written, and the patch is not permitted: ${wrong}\n\n`
      + 'Stop and tell the operator.',
  };
}

/**
 * A prompt: `{ context, operator }`. `context` is every message, for the
 * agent. `operator` is the ones for the operator, which Codex shows them, or
 * undefined.
 */
export function forPrompt(result) {
  const wrong = trouble(result, null, { atLeastOne: true });
  if (wrong !== null) return { context: `workflow: state unavailable (${wrong})`, operator: undefined };
  return { context: said(result.answer.messages, '\n'), operator: forOperator(result.answer.messages) };
}

/**
 * An approved plan: `{ context, operator }`. Whether it was recorded matters
 * to both: the operator approved it, and the agent is about to act on it.
 */
export function forPlanApproved(result) {
  const wrong = trouble(result, 'recorded', { atLeastOne: true });
  const text = wrong === null ? said(result.answer.messages) : `The plan was approved, but the workflow hook failed to record it: ${wrong}`;
  return { context: text, operator: text };
}

/**
 * The turn's end: `{ block, operator }`.
 *
 * `block` is the reason to refuse the stop, which Codex sends the agent as a
 * new prompt, or undefined to let the turn end. The stop is refused when the
 * referee says `keepWorking`. `operator` is what Codex shows the operator.
 * When the stop is refused, the reason carries every message and `operator`
 * the ones for the operator. When it is not, every message goes to the
 * operator, because no agent reads anything after its turn has ended.
 *
 * A fresh verification is addressed to the operator exactly once. It can
 * request a relay even after a refused stop. The receipt reminder on the
 * following stop is addressed to the agent and cannot request another relay.
 *
 * @param {{ answer: object } | { problem: string }} result
 * @param {boolean} stopRefusedBefore Codex's `stop_hook_active`
 * @param {string} [warning] the adapter's optional plan capture warning
 */
export function forTurnEnd(result, stopRefusedBefore, warning) {
  const wrong = trouble(result, 'keepWorking');
  if (wrong !== null) {
    const text = `The workflow turn-end hook failed, so nothing was verified: ${wrong}`;
    return { block: stopRefusedBefore ? undefined : text, operator: joined(text, warning) };
  }
  const { keepWorking, messages } = result.answer;
  if (messages.some((m) => m.code === 'verified' && m.for === 'operator')) {
    const report = messages.filter((m) => m.for === 'operator');
    const instructions = messages.filter((m) => m.for !== 'operator');
    return {
      block: 'Post the following report verbatim in your reply, including every warning.\n\n'
        + joined(...report.map((m) => m.text), warning)
        + (instructions.length ? `\n\nThen follow these instructions:\n\n${said(instructions)}` : ''),
      operator: undefined,
    };
  }
  if (messages.length === 0) return { block: undefined, operator: warning };
  if (!keepWorking) return { block: undefined, operator: joined(said(messages), warning) };
  return { block: said(messages), operator: joined(forOperator(messages), warning) };
}

/**
 * The adapter's own warning, when Codex runs with approvals off. A capture
 * showed `codex exec` sending `bypassPermissions` while its sandbox was still
 * `workspace-write`, so this says approvals, not the sandbox.
 *
 * @param {unknown} permissionMode the payload's `permission_mode`
 * @returns {string|undefined}
 */
export function bypassWarning(permissionMode) {
  if (permissionMode !== 'bypassPermissions') return undefined;
  return 'Codex is running with approvals off (`permission_mode` is `bypassPermissions`), so no command waits for the operator before it runs. '
    + 'The workflow\'s hooks still gate every write, but whether the sandbox is on is not something the hook can see.';
}

/*
 * What each hook prints. Codex's shapes, from its hook documentation and the
 * 2026-10-29 capture. Only fields the event supports: Codex fails a hook whose
 * answer has one it does not, and for a tool call that means the call goes
 * through.
 */

/** Before a tool call: a denial, or null for nothing, which allows the call. */
export const preToolOutput = (decision) => (decision === null ? null : {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.deny },
});

/**
 * A drift warning carried by the pre-tool hook, which takes no
 * `systemMessage`: in front of a denial's reason, or as context for the agent
 * on a call that is allowed.
 */
export function preToolDrift(out, warning) {
  if (out === null) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning } };
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  return { hookSpecificOutput: { ...out.hookSpecificOutput, permissionDecisionReason: `${warning}\n\n${reason}` } };
}

/** A prompt: context for the agent, and a message for the operator when there is one. */
export const promptOutput = ({ context, operator }) => ({
  ...(operator === undefined ? {} : { systemMessage: operator }),
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
});

/** The turn's end: a refused stop with its reason, a message for the operator, both, or `{}`. */
export const stopOutput = ({ block, operator }) => ({
  ...(block === undefined ? {} : { decision: 'block', reason: block }),
  ...(operator === undefined ? {} : { systemMessage: operator }),
});
