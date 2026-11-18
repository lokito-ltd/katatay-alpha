#!/usr/bin/env node
/**
 * The install command: the files `init` should write for Claude Code, as JSON.
 *
 * `init` runs where no rulebook exists yet. It finds this command in the
 * adapter's defaults, under `commands.install`, and starts it itself (see
 * `src/agents/README.md`).
 *
 * In:  `{ version, instructions, skills: [{ name, description, prompt }],
 *      plansFolder? }` on stdin: the referee's texts, so the adapter needs
 *      none of the harness's files, and the rulebook's plans folder.
 * Out: `{ version, files: [{ path, text }], registration: { path, text } }`,
 *      paths from the project root, with exit 0. `files` come from
 *      `install-files.mjs`. `registration` is `.claude/settings.json` with the
 *      workflow's hooks merged into what the project's file already holds,
 *      from `mergedSettings`.
 *
 * A request that does not match is refused with exit 2 and a sentence on
 * stderr, as `check.mjs` refuses its own: it is a bug in the caller. Settings
 * that cannot be merged into, because they are not JSON, fail with exit 1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installFiles } from './install-files.mjs';
import { SETTINGS_FILE, mergedSettings } from './registration.mjs';
import { HARNESS_SCHEMA_VERSION as VERSION } from '../../schema-version.mjs';

/** A skill's name, as the referee names skills. Paths are built from it. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

const refuse = (why) => {
  process.stderr.write(`install: refused, ${why}.\n`);
  process.exit(2);
};

const isSkill = (skill) => skill !== null && typeof skill === 'object'
  && typeof skill.name === 'string' && SKILL_NAME.test(skill.name)
  && typeof skill.description === 'string' && skill.description !== ''
  && typeof skill.prompt === 'string';

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
if (typeof request.instructions !== 'string' || request.instructions.trim() === '') refuse('`instructions` must be the workflow\'s instructions as text');
if (!Array.isArray(request.skills) || !request.skills.every(isSkill)) refuse('`skills` must be a list of { name, description, prompt }, each name lower case, digits and dashes');
if (request.plansFolder !== undefined && (typeof request.plansFolder !== 'string' || request.plansFolder === '')) refuse('`plansFolder` must be a path when it is given');

const root = process.cwd();
const settings = join(root, SETTINGS_FILE);
let registration;
try {
  registration = { path: SETTINGS_FILE, text: mergedSettings(existsSync(settings) ? readFileSync(settings, 'utf8') : null, { root, plansFolder: request.plansFolder }) };
} catch (error) {
  process.stderr.write(`install: ${error.message}.\n`);
  process.exit(1);
}

const answer = JSON.stringify({ version: VERSION, files: installFiles(request), registration });
process.stdout.write(answer, () => process.exit(0));
