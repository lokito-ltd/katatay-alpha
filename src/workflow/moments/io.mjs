/**
 * How a moment command talks: one JSON object in on stdin, one JSON object out
 * on stdout.
 *
 * A moment is a point where the agent hands control to the workflow: before a
 * write, when a prompt arrives, when a plan is approved, when a turn ends. The
 * agent adapter turns what its agent sends into the input here, starts the
 * command (`workflow.mjs on <moment>`), and turns the answer back into what its
 * agent expects. The contract is in `src/agents/README.md`.
 *
 * "Moment" and not "event", because an event is an entry in the workflow logbook.
 *
 * Input that does not match the shape is refused with exit 2 and a sentence on
 * stderr. It is an adapter bug, and an answer made up from half an input would
 * hide it. Every decision a moment makes is in its answer, so the exit code is
 * 0 whenever there is one. The answer is written whole before the command
 * exits; `written` below says why that needs waiting for.
 */
import { fileURLToPath } from 'node:url';
import { VERSION } from './messages.mjs';

export const versionShape = String(VERSION);

/** What an input field may hold. `'string|null'` allows null as well. */
const TYPES = {
  // The contract's version. Any other number is input that does not match:
  // the referee and its adapters change together, so a different number means
  // one of them was left behind.
  [versionShape]: (value) => value === VERSION,
  boolean: (value) => typeof value === 'boolean',
  string: (value) => typeof value === 'string',
  'nonempty string': (value) => typeof value === 'string' && value.length > 0,
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  'string|null': (value) => value === null || typeof value === 'string',
  'optional string|null': (value) => value === undefined || value === null || (typeof value === 'string' && value.length > 0),
  // The files one tool call writes: `on write`'s list. A path that is empty
  // names no file, so it is an adapter bug like any other wrong type.
  'list of { path, delete }': (value) => Array.isArray(value) && value.every((write) => (
    write !== null && typeof write === 'object'
    && typeof write.path === 'string' && write.path !== '' && typeof write.delete === 'boolean'
  )),
};

/**
 * What is wrong with `input` against `shape`, as sentences. Empty means
 * nothing is. Fields the shape does not name are ignored, so an adapter may
 * send more than a moment reads.
 *
 * @param {unknown} input
 * @param {Record<string, keyof typeof TYPES>} shape
 */
export function shapeProblems(input, shape) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return ['the input is not a JSON object'];
  return Object.entries(shape)
    .filter(([field, type]) => !TYPES[type](input[field]))
    .map(([field, type]) => `\`${field}\` must be ${type.replace('|', ' or ')}, and is ${JSON.stringify(input[field]) ?? 'missing'}`);
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/**
 * Runs `decide` as a command when `moduleUrl` is the program started, and does
 * nothing when the file is only imported, as a test does.
 *
 * @param {string} moduleUrl the moment file's `import.meta.url`
 * @param {string} name the moment, for the refusal message
 * @param {Record<string, keyof typeof TYPES>} shape
 * @param {(input: object) => object | Promise<object>} decide
 */
export async function serve(moduleUrl, name, shape, decide) {
  if (process.argv[1] !== fileURLToPath(moduleUrl)) return;
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (error) {
    process.stderr.write(`on ${name}: the input is not JSON (${error.message}).\n`);
    process.exit(2);
  }
  const problems = shapeProblems(input, shape);
  if (problems.length > 0) {
    process.stderr.write(`on ${name}: refused, ${problems.join('; ')}.\n`);
    process.exit(2);
  }
  // Two `try`s, so a failure names the step that failed. A crash in the
  // decision is a bug in the moment, and its stack says where; a failed write
  // is the pipe to the agent. One `try` around both called every crash a
  // failed write, and sent the reader to stdout.
  let answer;
  try {
    answer = JSON.stringify(await decide(input));
  } catch (error) {
    process.stderr.write(`on ${name}: the decision failed: ${error?.stack ?? error}\n`);
    process.exit(1);
  }
  try {
    await written(answer);
  } catch (error) {
    process.stderr.write(`on ${name}: the answer could not be written (${error.message}).\n`);
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Writes `text` to stdout and settles once it has all gone out.
 *
 * The agent reads the answer through a pipe. On a pipe, Node finishes a write
 * in the background, and `process.exit` does not wait for it, so an exit
 * straight after the write keeps only what fit in the pipe: 65,536 bytes on
 * macOS. A turn-end answer carries the verify tail, mutation survivors and
 * review areas, and can be larger than that. Cut short, it is not JSON, and
 * the hook reads it as no answer and blocks a turn whose verify passed.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
function written(text) {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}
