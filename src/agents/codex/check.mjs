#!/usr/bin/env node
/**
 * The agent check: what is wrong with Codex's setup here, as JSON.
 *
 * This is the command the rulebook names under `agent.adapters.<name>.checkCommand` when
 * Codex is the agent, and the only way the referee asks about it (see
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
 * Codex is asked through its app server (`app-server.mjs`), and the answers
 * become warnings in `setup.mjs`. A Codex that cannot be started or does not
 * answer is a warning too, not a failure: only the operator can fix it, and
 * the referee would otherwise report a check that gave no answer, which says
 * less.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gitText } from '../../workflow/git.mjs';
import { askAppServer } from './app-server.mjs';
import { INSTRUCTIONS_FILE } from './install-files.mjs';
import { setupWarnings } from './setup.mjs';
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

/**
 * The repository's `AGENTS.md` files and their sizes: tracked, or untracked
 * and not ignored, as Codex would find them. None when git cannot list them,
 * which leaves the size unchecked rather than failing the check.
 */
function agentsDocs() {
  try {
    const listed = gitText(['ls-files', '-co', '--exclude-standard', '-z', '--', ':(glob)**/AGENTS.md'], { cwd: root });
    return listed.split('\0').filter(Boolean).map((path) => ({ path, bytes: statSync(join(root, path)).size }));
  } catch {
    return [];
  }
}

// Git lists the main checkout first. Trust that path only for a listed worktree.
function mainCheckout() {
  try {
    const records = gitText(['worktree', 'list', '--porcelain', '-z'], { cwd: root }).split('\0\0');
    const paths = records.map(record => record.split('\0', 1)[0]).filter(field => field.startsWith('worktree '))
      .map(field => field.slice('worktree '.length));
    return paths.includes(root) ? paths[0] : root;
  } catch {
    return root;
  }
}

async function check() {
  if (process.env.CI === 'true') {
    const warnings = ['Codex live setup check skipped in CI.'];
    if (!existsSync(join(root, INSTRUCTIONS_FILE))) warnings.push(`${INSTRUCTIONS_FILE} is missing.`);
    return warnings;
  }
  const asked = await askAppServer([
    { method: 'hooks/list', params: { cwds: [root] } },
    { method: 'config/read', params: { cwd: root } },
  ], { cwd: root });
  const [hooksList, config] = 'problem' in asked ? [asked.problem, asked.problem] : asked.answers;
  return setupWarnings({ root, mainCheckout: mainCheckout(), hooksList, config, extraHooks, docs: agentsDocs() });
}

const answer = JSON.stringify({ version: VERSION, warnings: await check() });
process.stdout.write(answer, () => process.exit(0));
