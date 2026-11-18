/**
 * Noticing when Codex stops sending what a hook reads.
 *
 * The fixtures under `tests/fixtures/codex/` pin the tests to payloads a
 * real session produced, which fixes the bug where a hook and its test agreed
 * with each other and with nothing else. It does not fix the other half: a
 * fixture is a copy of a day that has passed, so no test built on one can
 * notice Codex changing its payloads tomorrow. Only a live session can,
 * and only if something is watching.
 *
 * This is that something. Each hook declares the fields it reads. When one is
 * absent, the hook says so in the message it was already going to send, naming
 * the field. That warning is the signal to recapture the fixtures — it is what
 * `README.md` in the fixtures folder means by "when a hook warns".
 *
 * Absent means absent, not falsy. `stop_hook_active: false` is Codex
 * answering the question, and a check that treated it as missing would cry
 * drift on every ordinary turn until nobody read the warnings any more.
 */

const notes = [];

/** Walk a dotted path. Returns `undefined` for a missing field at any depth. */
const at = (object, path) =>
  path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);

/**
 * @param {object} hook the parsed payload
 * @param {Record<string, string>} fields dotted path → what breaks without it
 */
export function expectFields(hook, fields) {
  const event = hook?.hook_event_name ?? 'workflow';
  for (const [path, consequence] of Object.entries(fields)) {
    if (at(hook, path) === undefined) {
      notes.push(
        `Codex sent no \`${path}\` to the ${event} hook, so ${consequence}. `
        + 'What it sends may have changed. Recapture the payloads under `tests/fixtures/codex/` '
        + 'following the README there, and tell the operator.',
      );
    }
  }
}

export const hasDrift = () => notes.length > 0;

export const drift = () => notes.join('\n\n');
