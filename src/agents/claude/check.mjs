#!/usr/bin/env node
/**
 * The agent check: what is wrong with Claude Code's setup here, as JSON.
 *
 * This is the command the rulebook names under `agent.adapters.<name>.checkCommand`, and the
 * only way the referee asks about the agent (see `src/workflow/agent.mjs` and
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
 * stderr, as the referee's moments refuse theirs: it is a bug in the referee,
 * and warnings made up from half a request would hide it.
 *
 * The warnings are the ones the hooks already print each turn, from
 * `settings.mjs`: hooks missing from `.claude/settings.json`, hooks that other
 * settings files add, `disableAllHooks`, Claude's `plansDirectory`
 * differing from the rulebook's `plans.dir`, and the workflow's
 * instructions missing from `.claude/rules/workflow.md`.
 */
import { settingsWarnings } from './settings.mjs';
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
const { extraHooks } = request;
if (extraHooks !== null && !(typeof extraHooks === 'object' && Array.isArray(extraHooks?.acknowledged) && extraHooks.acknowledged.every(isHook))) {
  refuse('`extraHooks` must be null or { acknowledged: [{ event, matcher, command }] }');
}

const answer = JSON.stringify({ version: VERSION, warnings: settingsWarnings({ root: request.root, extraHooks }) });
process.stdout.write(answer, () => process.exit(0));
