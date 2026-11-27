/**
 * How a hook asks the referee: one moment command, JSON in and JSON out.
 *
 * The hooks hold no workflow rules. Each turns what Cursor sent into the
 * referee's input, starts `workflow.mjs on <moment>`, and turns the answer back
 * (see `translate.mjs`). The contract is in `src/agents/README.md`, and a
 * dependency rule (`hooks-talk-through-commands` in `.dependency-cruiser.cjs`)
 * stops a hook importing the referee instead.
 *
 * The referee is found from this file, so a hook works in a repository other than
 * the one it lives in, as the machine suite runs it. Packaging the referee would
 * change this one line.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REFEREE = fileURLToPath(new URL('../../../workflow/cli/workflow.mjs', import.meta.url));

/** Start the referee command with one JSON object on stdin. */
export function runCommand(args, input) {
  return spawnSync(process.execPath, args, {
    input: JSON.stringify(input),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    // A verify tail, mutation survivors and review areas can make a large answer.
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Starts the moment and reads its answer.
 *
 * Returns `{ answer }` with the parsed object, or `{ problem }` with a sentence
 * saying why there is no answer: it could not start, it exited with a code
 * other than 0, or it printed something that is not a JSON object. A problem is
 * never read as an answer. Each hook decides what no answer means for it, and
 * every one of them fails closed (see `translate.mjs`).
 *
 * `program` is the file to start, a parameter so a test can aim it at a stub.
 * It is never read from the environment: a variable a session could set would
 * let it point the gate at a stand-in that allows everything.
 *
 * @param {string} moment such as `write` or `turn-end`
 * @param {object} input
 * @param {{ program?: string }} [options]
 * @returns {{ answer: object } | { problem: string }}
 */
export function ask(moment, input, { program = REFEREE } = {}) {
  const run = runCommand([program, 'on', moment], input);
  // The first lines, because that is where a refusal's sentence and a crash's
  // error are. Node ends a crash with stack frames and its own version.
  const said = (run.stderr ?? '').trim().split('\n').filter((line) => line.trim() !== '').slice(0, 8).join('\n');
  const where = `the referee (\`on ${moment}\`)`;
  if (run.error) return { problem: `${where} could not be started: ${run.error.message}` };
  if (run.status !== 0) {
    return { problem: `${where} exited with ${run.status ?? run.signal}${said ? `: ${said}` : ''}` };
  }
  let answer;
  try {
    answer = JSON.parse(run.stdout);
  } catch {
    return { problem: `${where} printed something that is not JSON` };
  }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return { problem: `${where} printed JSON that is not an object` };
  }
  return { answer };
}
