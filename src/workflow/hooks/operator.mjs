/**
 * The operator's vocabulary, as a pure function.
 *
 * An agent cannot write to the `UserPromptSubmit` channel, because it cannot
 * emit a user prompt. Permission to start a change comes from approving a plan
 * in plan mode, which leaves two words here: `reset`, which ends the epoch, and
 * `record`, which is the operator declaring the change finished. The agent
 * writes the change file, so the file existing could never be that declaration.
 *
 * The grammar is deliberately tiny, and the *whole* message must be the word.
 * "Should we reset this?" is a question about a reset, not a reset, and a
 * matcher loose enough to confuse the two would make the word worthless.
 */
const TOKEN = /^(reset|record)(?:\s*:\s*(.+))?$/i;

export const EVENT_FOR = { reset: 'reset', record: 'declared' };

/** @returns {{ token: string, event: string, note: string|null }|null} */
export function operatorToken(prompt) {
  const match = TOKEN.exec(prompt.trim());
  if (!match) return null;
  const token = match[1].toLowerCase();
  return { token, event: EVENT_FOR[token], note: match[2]?.trim() ?? null };
}

export const EXCERPT_LIMIT = 400;

/** What gets committed with a refused plan: enough of the plan to read in a
 *  diff without opening the plan file. */
export const excerpt = (text) =>
  text.length <= EXCERPT_LIMIT ? text : `${text.slice(0, EXCERPT_LIMIT)}…`;
