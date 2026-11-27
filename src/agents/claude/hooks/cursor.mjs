/**
 * Standing aside when Cursor, not Claude Code, runs these hooks.
 *
 * Cursor also runs the hooks a project registers in `.claude/settings.json`,
 * beside its own. A capture under Cursor 3.32.10 on 2026-11-26 (see
 * `tests/fixtures/cursor/README.md`) showed every one of them running with
 * Cursor's payload. In a project set up for both agents, that would run each
 * moment twice: verify twice at every turn end, and the operator's `record`
 * handled twice. Cursor's own adapter is the one that knows Cursor's tools,
 * follow-ups and Build, so these hooks answer nothing and leave it to that one.
 *
 * Cursor puts `cursor_version` in every payload, and Claude Code sends no such
 * field. The payload is the agent's, never the model's: a session cannot add a
 * field to it.
 */

/** Whether Cursor started this hook. */
export const runByCursor = (hook) => typeof hook?.cursor_version === 'string' && hook.cursor_version !== '';
