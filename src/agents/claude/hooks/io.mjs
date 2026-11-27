/** Stdin/stdout plumbing shared by the workflow hooks. */
import { drift, hasDrift } from './drift.mjs';

export async function input() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

/**
 * A hook gets one JSON object on stdout, so a drift warning cannot be a second
 * write. It rides along in whatever message the hook was already sending, and
 * `carry` puts it at the front: a hook that has just noticed Claude Code
 * changed its payload is reporting on itself, and that outranks what it was
 * going to say.
 */
let said = false;

const carry = (payload, field) => {
  if (!hasDrift()) return payload;
  said = true;
  const existing = payload[field];
  return { ...payload, [field]: existing ? `${drift()}\n\n${existing}` : drift() };
};

/** Writes still going out. `leave` waits for them before the hook exits. */
const pending = [];

/**
 * Claude Code reads a hook's stdout through a pipe. On a pipe, Node finishes a
 * write in the background, and `process.exit` does not wait for it, so a hook
 * that exits straight after writing keeps only what fit in the pipe: 65,536
 * bytes on macOS. A turn-end block carries the verify tail, mutation survivors
 * and review areas, and can be larger. So every write is kept here until it
 * has gone out, and `leave` is how a hook exits.
 *
 * A failed write settles too. It means Claude Code is no longer reading, and
 * there is nobody left to tell.
 */
const write = (payload) => {
  const done = new Promise((resolve) => {
    process.stdout.write(JSON.stringify(payload), () => resolve());
  });
  pending.push(done);
  return done;
};

export const emit = (payload) => write(carry(payload, 'systemMessage'));

export const deny = (reason) => {
  const out = carry({ permissionDecisionReason: reason }, 'permissionDecisionReason');
  write({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', ...out } });
};

export const context = (additionalContext) =>
  write({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', ...carry({ additionalContext }, 'additionalContext') } });

export const block = (reason) => write(carry({ decision: 'block', reason }, 'reason'));

const SHAPES = { deny, context, block, message: (text) => emit({ systemMessage: text }) };

/**
 * Sends what `translate.mjs` decided: `{ via, text }`, or nothing for `null`.
 * A drift warning still goes out on exit when nothing else carried it.
 */
export function send(action) {
  if (action === null) return;
  SHAPES[action.via](action.text);
}

/**
 * How a hook exits: once everything it wrote has gone out, with 0.
 *
 * Some paths end a turn without sending anything — a gate that allows the edit,
 * a phase with nothing to report. A warning must not be lost down one of them,
 * so an unsaid one is written here, on the way out. It is written only when
 * nothing else carried it, so a hook still writes a single object.
 *
 * @returns {Promise<never>}
 */
export async function leave() {
  if (hasDrift() && !said) {
    said = true;
    write({ systemMessage: drift() });
  }
  await Promise.all(pending);
  process.exit(0);
}

/**
 * How a hook exits when Cursor started it (see `cursor.mjs`): with `{}` and
 * nothing else, no drift warning either, since Cursor's payload is not
 * Claude Code's and every field this hook reads would look missing. Cursor
 * blocks a tool call when a permission hook prints something that is not
 * JSON, so an empty object, never silence.
 *
 * @returns {Promise<never>}
 */
export async function standAside() {
  said = true;
  await write({});
  process.exit(0);
}

/**
 * The same warning, for a hook that crashes before it reaches `leave`. Nothing
 * can wait for the write here, so a long warning may be cut short, but a short
 * one still gets through.
 */
process.on('exit', () => {
  if (hasDrift() && !said) write({ systemMessage: drift() });
});
