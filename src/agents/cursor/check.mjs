#!/usr/bin/env node
/**
 * The agent check: what is wrong with Cursor's setup here, as JSON.
 *
 * This is the command the rulebook names under `agent.adapters.<name>.checkCommand` when
 * Cursor is the agent, and the only way the referee asks about it (see
 * `src/agents/README.md`).
 *
 * In:  `{ version, root, extraHooks }` on stdin. `root` is the repository,
 *      absolute. `extraHooks` is the adapter's `extraHooks` settings as the
 *      referee read it, `{ acknowledged: [...] }`, or null when the rulebook
 *      switches the extra-hooks check off.
 * Out: `{ version, warnings: ["..."] }`, an empty list when nothing is wrong,
 *      with exit 0 whenever it could answer.
 *
 * A request that does not match is refused with exit 2 and a sentence on
 * stderr, as the referee's moments refuse theirs: it is a bug in the referee.
 *
 * Only files are read, and no program is started. The warnings come from
 * `setup.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { INSTRUCTIONS_FILE } from './install-files.mjs';
import { HOOKS_FILE } from './registration.mjs';
import { ENTERPRISE_FILES, setupWarnings } from './setup.mjs';
import { HARNESS_SCHEMA_VERSION as VERSION } from '../../schema-version.mjs';

const refuse = (why) => {
  process.stderr.write(`check: refused, ${why}.\n`);
  process.exit(2);
};

const isHook = (hook) => hook !== null && typeof hook === 'object'
  && typeof hook.event === 'string' && typeof hook.command === 'string'
  && (hook.matcher === undefined || typeof hook.matcher === 'string');

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let request;
try {
  request = JSON.parse(raw);
} catch (error) {
  refuse(`the request is not JSON (${error.message})`);
}
if (request === null || typeof request !== 'object' || Array.isArray(request)) refuse('the request is not a JSON object');
if (request.version !== VERSION) refuse(`\`version\` must be ${VERSION}, and is ${JSON.stringify(request.version) ?? 'missing'}`);
if (typeof request.root !== 'string' || request.root === '') refuse('`root` must be the repository root');
const { root, extraHooks } = request;
if (extraHooks !== null && !(typeof extraHooks === 'object' && Array.isArray(extraHooks?.acknowledged) && extraHooks.acknowledged.every(isHook))) {
  refuse('`extraHooks` must be null or { acknowledged: [{ event, matcher, command }] }');
}

/** A file's text, or null when there is none. One that cannot be read is said to be unreadable. */
const textOf = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? null : `<unreadable: ${error.code ?? error.message}>`;
  }
};

const files = { [HOOKS_FILE]: textOf(join(root, HOOKS_FILE)), '~/.cursor/hooks.json': textOf(join(homedir(), '.cursor', 'hooks.json')) };
const enterprise = ENTERPRISE_FILES[process.platform];
if (enterprise !== undefined) files[enterprise] = textOf(enterprise);

const warnings = setupWarnings({ files, extraHooks, instructions: existsSync(join(root, INSTRUCTIONS_FILE)) });
process.stdout.write(JSON.stringify({ version: VERSION, warnings }), () => process.exit(0));
