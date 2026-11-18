/**
 * Asking the agent adapter what is wrong with the agent's own setup.
 *
 * The referee knows no agent. It asks each command the rulebook names under
 * `agent.adapters.<name>.checkCommand` and reads JSON back, the way it asks the language
 * adapter (see `adapter.mjs` and `src/adapters/README.md`). The agent
 * adapter's contract is in `src/agents/README.md`.
 *
 * The request, on stdin, is `{ version, root, extraHooks }`: the repository
 * root, and the adapter's `extraHooks` with its acknowledged hooks, or
 * null when the rulebook switches that check off. The adapter may read the
 * rulebook for anything else, but this section is the referee's to parse, so
 * a section it refuses is refused in one place. The answer is
 * `{ version, warnings: ["..."] }`: plain sentences for the operator, an
 * empty list when nothing is wrong. Everything here is a warning and never a
 * failure, for the reason `cli/verify.mjs` gives: only the operator can fix
 * the agent's configuration, and a red check would block the change that
 * noticed.
 *
 * A command that crashes, runs too long or prints something else gives no
 * answer, and no answer is never a pass (VISION rule 11). It becomes one
 * warning that says so, so the operator hears about a check that stopped
 * working instead of reading silence as a clean report.
 *
 * The adapter's other commands, `defaults` and `install`, are asked by `init`
 * and not through the rulebook, because it runs before one exists.
 * `agentDefaults` and `agentInstall` below read them with the same rules.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { locksFor, lockTest } from './locks.mjs';
import { TargetError, readAgentAdapters, parseExtraHooks } from './rulebook.mjs';
import { VERSION, message } from './moments/messages.mjs';

/** Seconds. A backstop for a check that hangs; a healthy one takes a second. */
export const BACKSTOP = 30;

/** What is wrong with the agent's setup, as sentences. Empty means nothing, or
 *  that the rulebook names no check. */
export function agentWarnings(root = process.cwd(), { backstop = BACKSTOP } = {}) {
  let adapters;
  try {
    adapters = readAgentAdapters(root);
  } catch (error) {
    // A rulebook the referee cannot read is the rulebook's failure to report, here as
    // one more warning, since the agent's setup is the one thing left unchecked.
    if (error instanceof TargetError) return [error.message];
    throw error;
  }
  const warnings = [];
  for (const [name, adapter] of Object.entries(adapters)) {
    const named = (warning) => `${name}: ${warning}`;
    const line = adapter.checkCommand;
    const setting = parseExtraHooks(adapter, name);
    const extraHooks = setting.check ? { acknowledged: setting.acknowledged } : null;
    const asked = ask(line, root, { version: VERSION, root, extraHooks }, backstop, (output) => {
      const warnings = output.warnings;
      return Array.isArray(warnings) && warnings.every((warning) => typeof warning === 'string')
        ? null
        : 'it printed JSON without a "warnings" list of strings';
    });
    if ('none' in asked) {
      warnings.push(named(`the agent check (\`${line}\`) gave no answer: ${asked.none}. Nothing was concluded from it, so the agent's setup is unchecked.`));
    } else {
      warnings.push(...asked.answer.warnings.map(named));
    }
  }
  return warnings;
}

/**
 * Starts an adapter command with `request` on stdin and reads its answer.
 * Returns `{ answer }`, or `{ none: problem }` when there was no answer: it
 * crashed, ran past `backstop` seconds, printed something that is not JSON,
 * answered another version, or failed `problemWith`, which gets the parsed
 * answer and returns a problem or null. Each caller says in its own words what
 * no answer means.
 */
function ask(line, root, request, backstop, problemWith) {
  const run = spawnSync(line, {
    shell: true,
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(request),
    stdio: ['pipe', 'pipe', 'inherit'],
    timeout: backstop * 1000,
  });
  if (run.error?.code === 'ETIMEDOUT') return { none: `it was still running after ${backstop} seconds` };
  // `EPIPE` means the command closed its input before the whole request was
  // written: it exited without reading it, or read only part. It still ran,
  // and its exit status and output say what happened, so they decide. Read as
  // a failure to start, it turned `exit 3` into "could not be started" whenever
  // the shell exited before the write finished, which under load it sometimes
  // did, and it refused a command that answers without reading its request.
  if (run.error && !(run.error.code === 'EPIPE' && (run.status !== null || run.signal !== null))) return { none: `it could not be started (${run.error.message})` };
  if (run.status !== 0) return { none: `it exited with ${run.status ?? run.signal}` };
  let output;
  try {
    output = JSON.parse(run.stdout);
  } catch {
    return { none: 'it printed something that is not JSON' };
  }
  if (output?.version !== VERSION) {
    return { none: output?.version === undefined ? 'it answered without a version' : `it answered version ${JSON.stringify(output.version)}, not ${VERSION}` };
  }
  const problem = problemWith(output);
  return problem === null ? { answer: output } : { none: problem };
}

const isText = (value) => typeof value === 'string' && value !== '';
const isTextList = (value) => Array.isArray(value) && value.every(isText);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** What is wrong with a defaults answer, or null. The fields are the
 *  contract's `DefaultsAnswer` in `src/agents/contract.json`. */
function defaultsProblem(output) {
  if (!isTextList(output.locked)) return 'its "locked" is not a list of paths';
  if (!isText(output.plansFolder)) return 'its "plansFolder" is not a path';
  if (!isText(output.instructions)) return 'its "instructions" is not a file name';
  if (!isObject(output.commands) || !Object.values(output.commands).every(isText)) return 'its "commands" is not an object of command lines';
  const { registration } = output;
  if (!isObject(registration) || !isText(registration.file) || typeof registration.text !== 'string' || !isTextList(registration.steps)) {
    return 'its "registration" is not { file, text, steps }';
  }
  return null;
}

/**
 * What an agent adapter proposes for a new project, from its `defaults`
 * command: the agent's locked paths, its plans folder, its instructions file,
 * its commands and its hook registration.
 *
 * `init` asks it, before any rulebook exists, so the command line comes from
 * whoever runs `init` and not from the rulebook. Returns `{ proposal }`, or
 * `{ none: sentence }` when the command gave no answer. No answer is never a
 * pass (VISION rule 11): a half-filled proposal is never returned, because a
 * draft rulebook with the agent's locks missing would leave its config
 * writable and look complete.
 */
export function agentDefaults(line, root = process.cwd(), { backstop = BACKSTOP } = {}) {
  const asked = ask(line, root, { version: VERSION }, backstop, defaultsProblem);
  if ('none' in asked) return { none: `the agent's defaults (\`${line}\`) gave no answer: ${asked.none}.` };
  const { version, ...proposal } = asked.answer;
  return { proposal };
}

/**
 * What is wrong with an install answer, or null. The fields are the
 * contract's `InstallAnswer` in `src/agents/contract.json`.
 *
 * `init` writes these files, so a path must stay inside the project and off
 * every lock: the referee's own and the agent's `locked` from its defaults. An
 * adapter that answered `.git/hooks/pre-commit`, or its own settings file,
 * would otherwise have `init` write what no session may.
 */
const installProblem = (root, home, locked, registrationFile) => (output) => {
  const { files, registration } = output;
  if (!Array.isArray(files) || !files.every((file) => isObject(file) && isText(file.path) && typeof file.text === 'string'
    && (file.shared === undefined || typeof file.shared === 'boolean'))) {
    return 'its "files" is not a list of { path, text, shared? }';
  }
  const lockTests = (globs) => globs.map((lock) => ({ glob: lock.glob, test: lockTest(lock.glob, root, home) }));
  const locks = lockTests(locksFor(locked));
  const placeProblem = (path, against) => {
    if (isAbsolute(path) || path === '~' || path.startsWith('~/')) return `its path ${JSON.stringify(path)} is not relative to the project`;
    const where = resolve(root, path);
    const inside = relative(root, where);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return `its path ${JSON.stringify(path)} leaves the project`;
    const lock = against.find(({ test }) => test.covers(where));
    return lock ? `its path ${JSON.stringify(path)} is locked (${lock.glob})` : null;
  };
  const seen = new Set();
  for (const { path } of files) {
    const problem = placeProblem(path, locks);
    if (problem !== null) return problem;
    const inside = relative(root, resolve(root, path));
    if (seen.has(inside)) return `it names ${JSON.stringify(path)} twice`;
    seen.add(inside);
  }
  // The registration is the one locked file `init` writes: the agent's own,
  // which no session may write, and which the operator, running `init`, asked
  // for. So it is checked against the referee's locks alone, and must be the
  // file the agent's defaults named, never another the answer chose.
  if (registration === undefined) {
    return registrationFile === undefined ? null : `it answers no "registration", and its defaults named ${JSON.stringify(registrationFile)}`;
  }
  if (!isObject(registration) || !isText(registration.path) || typeof registration.text !== 'string') return 'its "registration" is not { path, text }';
  if (registrationFile !== undefined && relative(root, resolve(root, registration.path)) !== relative(root, resolve(root, registrationFile))) {
    return `its registration is ${JSON.stringify(registration.path)}, and its defaults named ${JSON.stringify(registrationFile)}`;
  }
  return placeProblem(registration.path, lockTests(locksFor([])));
};

/**
 * The files an agent adapter would install for its agent, from its `install`
 * command: the workflow's instructions and the harness support skills, in the
 * agent's format and location, and its hook registration.
 *
 * `request` is `{ instructions, skills }`, as `installRequest` in
 * `install.mjs` reads them, with `plansFolder` set to the configured `plans.dir`. `locked` is the agent's locked paths, from its defaults, since `init`
 * asks this before any rulebook exists. `registrationFile` is the defaults'
 * `registration.file`: when it is given, the answer must carry the whole
 * registration for that file and no other. Returns `{ files, registration }`
 * (`registration` undefined when the adapter answered none), or `{ none: sentence }`
 * when the command gave no answer, under the same rules as `agentDefaults`:
 * a half answer is never returned.
 */
export function agentInstall(line, request, { root = process.cwd(), home = homedir(), locked = [], registrationFile, backstop = BACKSTOP } = {}) {
  const asked = ask(line, root, { ...request, version: VERSION }, backstop, installProblem(root, home, locked, registrationFile));
  if ('none' in asked) return { none: `the agent's install command (\`${line}\`) gave no answer: ${asked.none}.` };
  return { files: asked.answer.files, registration: asked.answer.registration };
}

/**
 * The warnings as messages, one `warning` for the operator each. The moments
 * add them to their answers, so an adapter can put them in front of the
 * operator however its agent allows.
 */
export const setupMessages = (root = process.cwd()) =>
  agentWarnings(root).map((warning) => message('warning', 'operator', `settings: ${warning} Tell the operator.`));
