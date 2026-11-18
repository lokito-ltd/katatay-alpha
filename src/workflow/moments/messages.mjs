/**
 * The one answer shape every moment uses: a decision, when the moment has one,
 * and a list of `{ code, for, text }` messages, with the contract's version.
 *
 * - `code` names a situation that someone handles differently. An adapter may
 *   branch on it, for example to add its agent's words for presenting a plan.
 *   An adapter that gets a code it does not know shows the text as it is, so
 *   adding a code breaks nothing.
 * - `for` is `agent` or `operator`. The agent sees every message. `operator`
 *   means the operator must see it too, and how that happens is the adapter's
 *   choice.
 * - `text` is Markdown. Messages never decide anything: only the decision
 *   field does.
 *
 * The list of codes is the same as the `Code` schema in
 * `src/agents/contract.json`, and a test holds the two together. See "One
 * answer shape" and "The codes" in `src/agents/README.md`.
 */

import { HARNESS_SCHEMA_VERSION as VERSION } from '../../schema-version.mjs';
export { VERSION };

/** One list for every moment. `contract.json` says what each one asks for. */
export const CODES = [
  'state',
  'info',
  'warning',
  'stop',
  'needs_plan',
  'locked',
  'approved',
  'refused',
  'reset',
  'declared',
  'held',
  'not_declared',
  'frozen',
  'run_triage',
  'triaged',
  'verify_failed',
  'verified',
  'change_file',
  'recorded',
];

export const AUDIENCES = ['agent', 'operator'];

/**
 * One message. A code or audience the contract does not list is a bug in the
 * referee, so it throws rather than sending something no adapter can read.
 *
 * @param {string} code
 * @param {'agent' | 'operator'} audience
 * @param {string} text
 */
export function message(code, audience, text) {
  if (!CODES.includes(code)) throw new Error(`message: "${code}" is not one of the contract's codes`);
  if (!AUDIENCES.includes(audience)) throw new Error(`message: "${audience}" is not one of the contract's audiences`);
  if (typeof text !== 'string' || text.trim() === '') throw new Error(`message: a "${code}" message has no text`);
  return { code, for: audience, text };
}

/**
 * Write the harness schema version first, then the decision fields and finally
 * the messages. Only this writer supplies the two envelope fields.
 *
 * @param {Record<string, unknown>} fields such as `{ allow: true }`, or `{}` for `on prompt`
 * @param {ReturnType<typeof message>[]} messages
 */
export function answer(fields, messages) {
  const { version: _version, messages: _messages, ...decisionFields } = fields;
  return { version: VERSION, ...decisionFields, messages };
}
