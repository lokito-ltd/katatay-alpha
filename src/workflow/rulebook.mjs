/**
 * The rulebook: `.katatay/rulebook.json`, the one file the operator writes
 * to say how this project is held to account.
 *
 * Before this file existed, each setting had its own reader and its own idea of
 * where in the file to look, and several rules were written into the referee as
 * constants: which files are high-risk, how long mutation may run, where the
 * requirements live. A project that wanted different answers had to change the
 * referee. Now the referee asks here, and the file answers.
 *
 *     {
 *       "version": 1,
 *       "targetBranch": "origin/main",
 *       "tests":        { paths, run },
 *       "code":         { paths, compile },
 *       "agent":        { "lockedPaths": [...paths],
 *                         "adapters": { "<name>": { "checkCommand": "...",
 *                           "extraHooks": { "check": true, "acknowledged": [...] } } } },
 *       "plans":        { "dir": "~/.katatay/plans" },
 *       "followUpsFile": "FOLLOW-UPS.md",
 *       "highRisk":     [ { "paths": [...globs], "why": "..." } ],
 *       "checks":       { "testQuality": { "coverage": "none", "mutation": "none", "<name>": {...} }, "codeQuality": { "<name>": {...} } },
 *       "requirementsDir": "requirements"
 *     }
 *
 * Every caller starts with a fully validated rulebook. A malformed high-risk
 * list stops the freeze and the test run too: until the operator fixes it,
 * no command should act on settings from that file.
 *
 * Every load checks the plans directory, follow-ups file, requirements
 * directory and locks together. These paths control which edits need a plan
 * and which files contribute to the tree fingerprint. See `checkGating`.
 *
 * `version` says which shape the file is in. This referee reads one, and refuses
 * any other, so that a file written for a later referee is not read with the
 * generous guess that its new keys do not matter: a key the referee ignores could
 * be a safety setting.
 *
 * The file sits under `.katatay/`, which the referee's locks keep sessions
 * out of, so a session cannot lower a floor, shorten a list or point the tools
 * at a branch of its choosing. The one rule the rulebook cannot remove: an edit
 * to the file itself is always high-risk (`highRiskAreas`).
 *
 * Plain Node and no imports from `node_modules`, because the hooks load it.
 */
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkRulebookKeys } from './rulebook-keys.mjs';
import { globToRegExp, isGlobList, matcher } from './glob.mjs';
import { lockTest, locksFor } from './locks.mjs';

import { CONFIG, TargetError, isObject, parseExitCodes } from './rulebook-values.mjs';
import { parseAdapter } from './adapter-settings.mjs';
import { STATE_FOLDER } from './folder.mjs';

export { CONFIG, TargetError, parseExitCodes };

/** Hash the exact bytes, including edits that leave the parsed settings equal. */
export function rulebookFingerprint(root = process.cwd()) {
  try {
    return createHash('sha256').update(readFileSync(join(root, CONFIG))).digest('hex');
  } catch {
    return null;
  }
}

const refuse = (problem) =>
  new TargetError(`${problem}. The workflow refuses to run without it. The operator edits ${CONFIG}; src/schemas/rulebook.schema.json, in the folder 'ktty path' prints, describes its shape.`);

// The freeze asks for the parsed test and code settings once per file.
const adapterSettings = new WeakMap();

/** Validate every section before returning any project settings.
 * @param {string} text
 * @returns {any}
 */
export function parseRulebook(text, root = process.cwd(), home = homedir()) {
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw refuse(`${CONFIG} is not readable as JSON (${error.message})`);
  }
  if (!isObject(config)) throw refuse(`${CONFIG} must hold a JSON object`);
  if (!Object.hasOwn(config, 'version')) throw refuse(`${CONFIG} must specify "version": ${HARNESS_SCHEMA_VERSION}`);
  if (config.version !== HARNESS_SCHEMA_VERSION) {
    throw refuse(`${CONFIG} says "version": ${JSON.stringify(config.version)}, and this referee reads version ${HARNESS_SCHEMA_VERSION}`);
  }
  checkRulebookKeys(config, refuse);
  parseAgentAdapters(config);
  parseTargetBranch(config);
  parseChecks(config);
  checkGating(config, root, home);
  parsePlanValidation(config);
  parseHighRisk(config);
  adapterSettings.set(config, parseAdapter(config));
  return config;
}

/**
 * Parsed files, by path, kept while the file's size and time stay the same.
 * `isFrozen` is asked once per file in the repository by the freeze, and
 * reading and parsing the rulebook each time would be most of what it costs.
 */
const cache = new Map();

/**
 * Drafted rulebooks, by the path their file would have. `init` proves a
 * rulebook's commands before it writes the file, and the readers that do the
 * proving find the rulebook through `readConfig`. So the probe reads a draft
 * here, and nothing else does.
 *
 * Kept in this process only, and only while the probe runs. The draft is not
 * written first and deleted on a failure, because a run killed halfway would
 * leave a rulebook nobody proved, and `init` never overwrites one. It is not
 * named by an environment variable, because any session could set that.
 */
const drafts = new Map();

/**
 * Runs `run` while `readConfig(root)` answers with `config`, a rulebook that
 * is not on disk yet. The draft is parsed first, as a file would be, so a
 * draft the parsers refuse throws before `run` starts. It is forgotten when
 * `run` ends, also when it throws.
 *
 * @template T
 * @param {string} root
 * @param {unknown} config the rulebook as an object
 * @param {() => T | Promise<T>} run
 * @param {string} [home]
 * @returns {Promise<T>}
 */
export async function withDraftConfig(root, config, run, home = homedir()) {
  const path = join(root, CONFIG);
  drafts.set(path, parseRulebook(JSON.stringify(config), root, home));
  try {
    return await run();
  } finally {
    drafts.delete(path);
  }
}

/**
 * The rulebook of the repository at `root`, or a `TargetError` saying why there
 * is none. The same object comes back while the file is unchanged.
 *
 * @param {string} [root]
 */
export function readConfig(root = process.cwd()) {
  const path = join(root, CONFIG);
  const draft = drafts.get(path);
  if (draft !== undefined) return draft;
  if (!existsSync(path)) {
    throw refuse(`there is no ${CONFIG}, which starts as ${EXAMPLE}`);
  }
  const { size, mtimeMs, ctimeMs } = statSync(path);
  const held = cache.get(path);
  if (held && held.size === size && held.mtimeMs === mtimeMs && held.ctimeMs === ctimeMs) return held.config;
  const config = parseRulebook(readFileSync(path, 'utf8'), root);
  cache.set(path, { size, mtimeMs, ctimeMs, config });
  return config;
}

/** The test and code settings parsed during the full read.
 * @returns {ReturnType<typeof parseAdapter>}
 */
export const readAdapterSettings = (root) => adapterSettings.get(readConfig(root));

// ------------------------------------------------------------- target

const EXAMPLE = `{ "version": ${HARNESS_SCHEMA_VERSION}, "targetBranch": "origin/main" }`;

/** The target as written, checked, without asking git anything. */
export function parseTargetBranch(config) {
  const value = config.targetBranch;
  if (typeof value !== 'string' || value.trim() === '') {
    throw refuse(`${CONFIG} has no "targetBranch" key, as in ${EXAMPLE}`);
  }
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw refuse(`${CONFIG} says "targetBranch": ${JSON.stringify(value)}, which is not <remote>/<branch>`);
  }
  const remote = value.slice(0, slash);
  const branch = value.slice(slash + 1);
  return { remote, branch, ref: `refs/remotes/${remote}/${branch}`, name: value };
}

// ------------------------------------------------------------- high-risk areas

/**
 * Why an edit to the rulebook is always listed. The referee says so itself,
 * because a rulebook that could leave itself off the list could hide its own
 * edits. Lowering a coverage floor passes that check without a test written,
 * and it is a one-number change in a data file, which reads as housekeeping.
 * No session may write the file, so an edit to it on a branch is the
 * operator's. It is listed anyway: the path hook reads shell commands by
 * pattern and can be got round, and a reviewer on the hosting platform cannot
 * tell who made an edit, only that it is there. Only the file is named, and not the folder:
 * the logbook under `.katatay/state/` grows in every change, and listing it would
 * put a line in every report that nobody needs to read.
 */
export const RULEBOOK_WHY = 'The rulebook. A floor, a list or a limit changed here changes what passes, with no test written.';

/**
 * The high-risk areas, checked: `{ paths, why }` entries, each saying that a
 * reviewer must read changes to these files, and why.
 * The reason is what the reviewer reads, so each area has its own and one
 * sentence does not have to be right about all of them.
 */
export function parseHighRisk(config) {
  const list = config.highRisk;
  if (!Array.isArray(list)) throw refuse(`${CONFIG} has no "highRisk" list. Write [] if no files are high-risk`);
  return list.map((entry, index) => {
    const at = `"highRisk[${index}]"`;
    if (!isObject(entry)) throw refuse(`${at} must be { "paths": [...], "why": "..." }`);
    if (!isGlobList(entry.paths, { empty: false })) throw refuse(`${at}.paths must be a non-empty list of globs`);
    if (typeof entry.why !== 'string' || entry.why.trim() === '') throw refuse(`${at}.why must say why a change to these files needs reading`);
    for (const glob of entry.paths) {
      try {
        globToRegExp(glob);
      } catch (error) {
        throw refuse(`${at}.paths holds a malformed glob: ${error.message}`);
      }
    }
    return { paths: entry.paths, why: entry.why };
  });
}

/**
 * Which of the changed files sit in a high-risk area, as `{ why, items }` in
 * the order the rulebook lists them, the rulebook's own rule first. A file in two areas is listed under each, because each has
 * its own reason. Areas with
 * no changed file are left out.
 *
 * @param {string[]} changed paths from the repository root
 * @param {string} [root]
 * @returns {{ why: string, items: string[] }[]}
 */
export function highRiskAreas(changed, root = process.cwd()) {
  const areas = [];
  const own = changed.filter((file) => file === CONFIG);
  if (own.length > 0) areas.push({ why: RULEBOOK_WHY, items: own });
  const config = readConfig(root);
  for (const { paths, why } of parseHighRisk(config)) {
    const matches = matcher(paths);
    const items = changed.filter((file) => matches(file));
    if (items.length > 0) areas.push({ why, items });
  }
  return areas;
}

// ------------------------------------------------------------- checks

/**
 * The two chains of checks. `testQuality` is for checks about how well the tests
 * test, and `codeQuality` for checks about the code: lint, static analysis, security
 * scans, architecture rules, the build. Verify runs the quality chain first,
 * then the code chain. Coverage and mutation run first in that fixed order;
 * the other checks keep the order the rulebook lists them.
 */
export const CHAINS = ['testQuality', 'codeQuality'];

/**
 * What an exit code of a check can mean.
 *
 * - `clean`: it checked and found nothing.
 * - `findings`: it checked and found something, which is in its output.
 * - `broken`: it could not check. A code the rulebook does not list means this
 *   too, so a crash is never read as a clean run or as findings.
 */
export const CHECK_MEANINGS = ['clean', 'findings', 'broken'];

/** How often a check runs: on every verify, or until it has run once on a
 *  verified pass of the plan. */
export const CHECK_RUNS = ['always', 'oncePerPlan'];

/** What a check that is not clean does: fail verify, or be printed while
 *  verify goes on. */
export const CHECK_ON_FAILURE = ['block', 'report'];

/** The longest a check may run when the rulebook says nothing, in seconds.
 *  Past it the run is stopped and counts as broken. */
export const CHECK_TIME_LIMIT = 300;

/**
 * Names a check may not have. Verify reports a failure by the step's name, so
 * a check named like one of the referee's own steps would make "failed at
 * coverage" ambiguous. `coverage` and `mutation` are also kept free for the
 * quality chain. The referee's step
 * names are `REFEREE_STEPS` in `referee-verify.ts`, which a test holds to
 * this list.
 */
export const RESERVED_CHECK_NAMES = ['req:lint', 'req:guard', 'state:verify', 'compile', 'tests', 'req:trace', 'coverage', 'mutation'];

/** A destination the referee owns, never a glob or a path outside the tree. */
export function outputPath(value, at = 'output') {
  if (typeof value !== 'string' || value === '' || /[\\\\:*?\[\]{}\x00-\x1f]/.test(value)
    || value.split('/').some((part) => ['', '.', '..'].includes(part))
    || ['.git', STATE_FOLDER].includes(value.split('/')[0])) {
    throw refuse(`"${at}" must be one repository-relative output file, without wildcards or dot segments`);
  }
  return value;
}

/**
 * What is wrong with the minimums themselves, before any report is read.
 *
 * Each of these would otherwise switch part of the check off without failing
 * anything. A folder with no `branches` entry has no branch check. A minimum
 * that is not a number compares as false against every figure, which reads as
 * a pass. A folder written without its closing `/` also matches its
 * neighbours: `src/work` would claim `src/workflow/` and anything else
 * that starts that way.
 */
export function coverageMinimumProblems(minimum, at) {
  if (minimum === null || typeof minimum !== 'object' || Array.isArray(minimum) || Object.keys(minimum).length === 0) {
    return [`${CONFIG} has no ${at} section, so there is nothing to check against.`];
  }
  const problems = [];
  for (const [folder, entry] of Object.entries(minimum)) {
    if (!folder.endsWith('/')) problems.push(`${folder}: a folder in ${CONFIG} must end with "/".`);
    for (const kind of ['lines', 'branches']) {
      const value = entry?.[kind];
      const whole = typeof value === 'number' && Number.isFinite(value) && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
      if (!whole || value < 0 || value > 100) {
        problems.push(`${folder}: the ${kind} minimum must be a number from 0 to 100 with at most one decimal, and is ${JSON.stringify(value)}.`);
      }
    }
  }
  return problems;
}

/** The mutation command writes a standard report and receives changed lines on stdin. */
function mutationSettings(entry, at) {
  if (entry.output === 'none') throw refuse(`"${at}.output" must name the report file`);
  const report = outputPath(entry.output, `${at}.output`);
  const globs = entry.excludePaths;
  if (!isGlobList(globs, { empty: true })) throw refuse(`"${at}.excludePaths" must be a list of globs, empty if none`);
  for (const glob of globs) {
    try { globToRegExp(glob); }
    catch (error) { throw refuse(`"${at}.excludePaths" holds a malformed glob: ${error.message}`); }
  }
  return { report, exclude: globs };
}

/** One entry of a chain, checked, with the defaults filled in. */
function parseCheck(entry, chain, name) {
  const at = `checks.${chain}.${name}`;
  const coverage = chain === 'testQuality' && name === 'coverage';
  const mutation = chain === 'testQuality' && name === 'mutation';
  if (!isObject(entry)) throw refuse(`"${at}" must be an object with a "command" and its "exitCodes"`);
  validateCommand(entry.command, `${at}.command`);
  const exitCodes = mutation ? { 0: 'clean', 1: 'findings', 2: 'findings' } : coverage ? { 0: 'clean' }
    : parseExitCodes(entry.exitCodes, `${at}.exitCodes`, CHECK_MEANINGS, ['clean', 'findings'], refuse);
  const { runs = mutation ? 'oncePerPlan' : 'always', onFailure = mutation ? 'report' : 'block', timeLimitSeconds = CHECK_TIME_LIMIT, suppressions = [], skipInCi = false } = entry;
  if (!CHECK_RUNS.includes(runs)) throw refuse(`"${at}.runs" must be one of ${CHECK_RUNS.join(', ')}, or left out for ${mutation ? 'oncePerPlan' : 'always'}`);
  if (!CHECK_ON_FAILURE.includes(onFailure)) throw refuse(`"${at}.onFailure" must be one of ${CHECK_ON_FAILURE.join(', ')}, or left out for ${mutation ? 'report' : 'block'}`);
  if (mutation && (runs !== 'oncePerPlan' || onFailure !== 'report')) throw refuse(`"${at}" must run oncePerPlan and report findings`);
  if (mutation && entry.command === 'none') throw refuse(`set "${at}" to "none" to switch mutation off`);
  if (coverage && (runs !== 'always' || onFailure !== 'block')) throw refuse(`"${at}" must run always and block on failure`);
  // Only a boolean: a string such as "false" would otherwise read as true.
  if (typeof skipInCi !== 'boolean') throw refuse(`"${at}.skipInCi" must be true or false, or left out for false`);
  // Coverage that is switched on measures every tree, CI's included, so the
  // folder minimums hold on what merges.
  if (coverage && skipInCi) throw refuse(`"${at}" must run on every verify, so it cannot skip CI`);
  if (coverage && entry.command.includes('{changedFiles}')) throw refuse(`"${at}.command" cannot use {changedFiles}: coverage must measure every code file`);
  if (coverage) {
    const key = `${at}.minimum`;
    const problems = coverageMinimumProblems(entry.minimum, key);
    if (problems.length) throw refuse(`"${key}": ${problems.join(' ')}`);
  }
  if (!Number.isInteger(timeLimitSeconds) || timeLimitSeconds <= 0) {
    throw refuse(`"${at}.timeLimitSeconds" must be a positive whole number of seconds, or left out for ${CHECK_TIME_LIMIT}`);
  }
  if (!isGlobList(suppressions, { empty: true })) throw refuse(`"${at}.suppressions" must be a list of regular expressions`);
  for (const pattern of suppressions) {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw refuse(`"${at}.suppressions" holds a malformed regular expression: ${error.message}`);
    }
  }
  const check = { name, chain, command: entry.command, exitCodes, runs, onFailure, timeLimitSeconds, suppressions, skipInCi };
  if (mutation) return { ...check, ...mutationSettings(entry, at) };
  const output = coverage || entry.output !== undefined ? outputPath(entry.output, `${at}.output`) : undefined;
  return { ...check, ...(output === undefined ? {} : { output }), ...(coverage ? { minimum: entry.minimum } : {}) };
}

/** What `checks.testQuality.coverage` says when the operator switched coverage off. */
export const COVERAGE_OFF = 'none';

export function analysisRequired(config = readConfig()) {
  const value = config.checks?.requireAnalysis;
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw refuse('"checks.requireAnalysis" must be true or false');
  return value;
}

/**
 * The checks, checked: `{ testQuality, codeQuality }`, each the chain's entries in the
 * order the rulebook lists them. `allChecks` puts coverage and mutation in their
 * fixed execution order. See "Checks" in `src/workflow/README.md`.
 *
 * Every rulebook names coverage and mutation in the quality chain. The code chain may
 * be left out. A check's own config files, such as
 * `.dependency-cruiser.cjs`, belong in `highRisk`, which already lists files
 * with a reason.
 *
 * @returns {{ testQuality: Check[], codeQuality: Check[] }}
 * @typedef {{ name: string, chain: string, command: string, exitCodes: Record<string, string>,
 *   runs: string, onFailure: string, timeLimitSeconds: number, suppressions: string[], skipInCi: boolean, output?: string,
 *   report?: string, exclude?: string[], minimum?: Record<string, { lines: number, branches: number }> }} Check
 */
export function parseChecks(config) {
  checkRulebookKeys(config, refuse);
  analysisRequired(config);
  const checks = config.checks;
  if (!isObject(checks)) throw refuse(`${CONFIG} has no "checks" object. Set "checks.testQuality.coverage" to "${COVERAGE_OFF}" to switch coverage off`);
  const seen = new Set();
  const outputs = new Set();
  const chains = { testQuality: [], codeQuality: [] };
  for (const chain of CHAINS) {
    // Validate supplied entries first so a malformed check gets its own error.
    const entries = checks[chain] === undefined ? {} : checks[chain];
    if (!isObject(entries)) throw refuse(`"checks.${chain}" must be an object of checks by name`);
    // Only the two built-in quality checks can be explicitly switched off.
    const builtin = (name) => chain === 'testQuality' && ['coverage', 'mutation'].includes(name);
    const listed = Object.entries(entries).filter(([name, entry]) => !(builtin(name) && entry === COVERAGE_OFF));
    chains[chain] = listed.map(([name, entry]) => {
      if (name.trim() === '') throw refuse(`"checks.${chain}" must name each check`);
      if (RESERVED_CHECK_NAMES.includes(name) && !builtin(name)) {
        throw refuse(`"checks.${chain}.${name}" uses a name the referee keeps for itself: ${RESERVED_CHECK_NAMES.join(', ')}`);
      }
      if (seen.has(name)) throw refuse(`"checks.${chain}.${name}": two checks are named "${name}". Verify reports a check by its name, so each needs its own`);
      seen.add(name);
      const check = parseCheck(entry, chain, name);
      for (const file of [check.output, check.report].filter(Boolean)) {
        if (outputs.has(file)) {
          throw refuse(`"checks.${chain}.${name}": two checks write "${file}"`);
        }
        outputs.add(file);
      }
      return check;
    });
  }
  for (const name of ['coverage', 'mutation']) {
    if (checks.testQuality?.[name] === undefined) {
      throw refuse(`${CONFIG} has no "checks.testQuality.${name}" entry. Set it to "none" to switch ${name} off`);
    }
  }
  return chains;
}

export const readChecks = (root = process.cwd()) => parseChecks(readConfig(root));

/** Coverage reads the test run before mutation assesses it. Their order is
 * fixed; the remaining quality checks, then code checks, keep configured order. */
export const allChecks = (checks) => [
  ...['coverage', 'mutation'].flatMap(name => checks.testQuality.filter(check => check.name === name)),
  ...checks.testQuality.filter(check => !['coverage', 'mutation'].includes(check.name)),
  ...checks.codeQuality,
];

/** Missing settings are rejected while parsing the chains. An absent result here means explicit "none". */
export const readMutation = (root = process.cwd()) => readChecks(root).testQuality.find((check) => check.name === 'mutation');
export const MUTATION_SWITCHED_OFF = 'not checked: mutation (checks.testQuality.mutation is "none")';

// ------------------------------------------------------------- agent adapter

function agentSection(config) {
  if (!isObject(config.agent)) throw refuse('"agent" must be an object with locks and at least one named adapter, for example "agent": { "lockedPaths": [], "adapters": { "local": { "checkCommand": "node check.mjs" } } }');
  return config.agent;
}

/**
 * Named setup checks, in the rulebook's entry order. Names are labels only;
 * the referee knows no agent-specific command or setting. At least one
 * adapter must be named. Each must name a check, so a misspelling
 * cannot silently switch it off. Every adapter
 * must have valid extra-hook settings before any setup check can run.
 */
export function parseAgentAdapters(config) {
  const section = agentSection(config);
  checkRulebookKeys({ agent: section }, refuse);
  const adapters = section.adapters;
  if (!isObject(adapters)) throw refuse('"agent.adapters" must be an object keyed by agent name');
  if (Object.keys(adapters).length === 0) throw refuse('"agent.adapters" must contain at least one named adapter');
  for (const [name, adapter] of Object.entries(adapters)) {
    const at = `agent.adapters.${name}`;
    if (name.trim() === '') throw refuse('"agent.adapters" must name each agent');
    if (!isObject(adapter)) throw refuse(`"${at}" must be an object`);
    validateCommand(adapter.checkCommand, `${at}.checkCommand`);
    parseExtraHooks(adapter, name);
  }
  return adapters;
}

function validateCommand(value, key) {
  if (typeof value !== 'string' || value.trim() === '') throw refuse(`"${key}" must be a command`);
}

export const readAgentAdapters = (root = process.cwd()) => parseAgentAdapters(readConfig(root));

/**
 * The agent's own files that must stay locked: its settings and hooks, as
 * paths or globs. A relative entry is from the repository root, `~/` is the
 * home folder, and an absolute one is itself, because an agent keeps settings
 * outside the repository too.
 *
 * The referee enforces the list in `on write` (`locks.mjs`), and
 * `checkGating` refuses a plans folder it reaches. The list is required, for the
 * reason `target.mjs` gives about `targetBranch`: a missing list would read as
 * nothing to lock, and nobody would have said so. `[]` says it.
 *
 * @returns {string[]}
 */
export function parseLockedPaths(config) {
  const paths = agentSection(config).lockedPaths;
  if (!isGlobList(paths, { empty: true })) {
    throw refuse(`"agent.lockedPaths" must be a list of the agent's own files to keep locked, such as the files that hold its settings and hooks. Write [] if there are none`);
  }
  for (const entry of paths) {
    try {
      globToRegExp(entry);
    } catch (error) {
      throw refuse(`"agent.lockedPaths" holds a malformed glob: ${error.message}`);
    }
  }
  return paths;
}

/**
 * The extra-hooks check: whether the agent check lists hooks that are not the
 * workflow's own, and the ones the operator has said are theirs.
 *
 * The list lives here because no session may write this file. Anywhere a
 * session could write, it could acknowledge its own hook. `check: false`
 * silences only the list of extra hooks. Missing workflow hooks and hooks
 * switched off are still reported, because those say the workflow is not
 * running, which is a different fact from "something else runs too".
 *
 * Each adapter owns its settings. The request contains only the resolved
 * settings for that adapter, so acknowledgements never cross agent boundaries.
 *
 * @returns {{ check: boolean, acknowledged: { event: string, matcher: string, command: string }[] }}
 */
export function parseExtraHooks(adapter, name) {
  const at = `agent.adapters.${name}.extraHooks`;
  const extra = adapter.extraHooks;
  if (extra === undefined) return { check: true, acknowledged: [] };
  if (!isObject(extra)) throw refuse(`"${at}" must be an object such as { "check": true, "acknowledged": [] }`);
  const check = extra.check === undefined ? true : extra.check;
  if (typeof check !== 'boolean') throw refuse(`"${at}.check" must be true or false`);
  const list = extra.acknowledged === undefined ? [] : extra.acknowledged;
  if (!Array.isArray(list)) throw refuse(`"${at}.acknowledged" must be a list of hooks`);
  const acknowledged = list.map((entry, index) => {
    const entryAt = `"${at}.acknowledged[${index}]"`;
    if (!isObject(entry)) throw refuse(`${entryAt} must be { "event": "...", "matcher": "...", "command": "..." }`);
    const { event, matcher: on = '', command } = entry;
    if (typeof event !== 'string' || event === '') throw refuse(`${entryAt}.event must name a hook event`);
    if (typeof on !== 'string') throw refuse(`${entryAt}.matcher must be a string, or left out`);
    if (typeof command !== 'string' || command === '') throw refuse(`${entryAt}.command must be the hook's command`);
    return { event, matcher: on, command };
  });
  return { check, acknowledged };
}

// ------------------------------------------------------------- plans and follow-ups

/** The follow-ups file when the rulebook names none. */
export const DEFAULT_FOLLOW_UPS = 'FOLLOW-UPS.md';

/**
 * Where a path in the rulebook points, as an absolute path. Relative is from
 * the repository root, `~/` is the home folder, absolute is itself. The home
 * folder is `os.homedir()`, which follows `HOME`, so a fixture repository with
 * a home of its own reads the right place.
 */
export function resolvePath(value, root = process.cwd(), home = homedir()) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return resolve(root, value);
}

/**
 * The plans folder as written: where plan files live, inside the repository
 * or out. The files directly in it are written without a plan and, inside the
 * repository, left out of the tree fingerprint. Its subfolders are not.
 * Required, because the referee cannot guess an agent's folder.
 */
export function parsePlansDir(config) {
  const value = config.plans?.dir;
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\\')) {
    throw refuse(`"plans.dir" is ${JSON.stringify(value)}, which is not a folder, such as "~/${STATE_FOLDER}/plans"`);
  }
  return value;
}

/** The plans folder as an absolute path. */
export const plansDir = (root = process.cwd(), home = homedir()) =>
  resolvePath(parsePlansDir(readConfig(root)), root, home);

/** Template checks are on unless the operator explicitly turns them off. */
export function parsePlanValidation(config) {
  const value = config.plans?.validateFormat;
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw refuse('"plans.validateFormat" must be true or false');
  return value;
}

/**
 * The follow-ups file, from the repository root: the operator's list of work
 * parked for later, writable in every phase and left out of the tree
 * fingerprint. `FOLLOW-UPS.md` unless the rulebook says otherwise.
 *
 * A Markdown file inside the repository. The change report reads it at the
 * baseline from git, so it has to be a file git holds. Markdown, because a
 * file the gate never asks about should not be one anything runs.
 */
export function parseFollowUpsFile(config) {
  const { followUpsFile: value = DEFAULT_FOLLOW_UPS } = config;
  const file = typeof value === 'string' ? value.trim() : '';
  const segments = file.split('/');
  // An empty name and a leading `/` both leave an empty segment, so the
  // segment check refuses them too.
  if (file.includes('\\') || file.startsWith('~')
    || segments.some((part) => part === '..' || part === '.' || part === '') || !file.endsWith('.md')) {
    throw refuse(`"followUpsFile" is ${JSON.stringify(value)}, which is not a Markdown file inside the repository, such as "FOLLOW-UPS.md"`);
  }
  return file;
}

export const followUpsFile = (root = process.cwd()) => parseFollowUpsFile(readConfig(root));

// ------------------------------------------------------------- the folders that must not overlap

const PROBE = 'a-plan.md';

/**
 * Refuses a rulebook whose plans folder or follow-ups file would leave edits
 * ungated. See "Folders the rulebook must not overlap" in
 * `src/agents/README.md`. Called by `readConfig`, so every moment refuses.
 *
 * Two cases.
 *
 * The plans folder is the repository root. Then the manifests, the agent's
 * instructions and every other file there would be written without a plan,
 * and no edit to them would cancel a verified tree.
 *
 * The plans folder or the follow-ups file overlaps a lock: either sits under a
 * locked path, or a locked file sits directly in the plans folder. Locks are
 * checked before the exemption, so an overlap with `.katatay/`, `.git/` or
 * the agent's own files could never unlock anything. It would only make plans
 * unwritable, and the refusal says so before the first approval fails. The
 * requirements folder counts too, for the opposite reason: it is locked only
 * against deletion, so a plans folder there would let requirements be edited
 * with no plan and outside the fingerprint.
 *
 * A folder above the repository is not refused. Only files directly in the
 * plans folder are exempt, so `~/dev` exempts `~/dev/*` and nothing in a
 * repository below it.
 *
 * @param {any} config the parsed rulebook
 * @param {string} [root]
 * @param {string} [home]
 */
export function checkGating(config, root = process.cwd(), home = homedir()) {
  const written = parsePlansDir(config);
  const followUps = parseFollowUpsFile(config);
  const requirements = parseRequirementsDir(config);
  const locks = parseLockedPaths(config);
  const shaped = (problem) => new TargetError(`${problem} The workflow refuses to run on this rulebook. The operator edits ${CONFIG}.`);

  const plans = resolvePath(written, root, home);
  if (plans === resolve(root)) {
    throw shaped(`The rulebook puts \`plans.dir\` at \`${written}\`, the repository root. Files there are written without a plan and left out of the tree fingerprint, so every edit to the manifests, the README and the other files at the root would be ungated, and none would cancel a verified tree. Point \`plans.dir\` at a folder of its own, such as \`~/.katatay/plans\`.`);
  }
  const followUpsPath = resolvePath(followUps, root, home);

  for (const { glob, why } of locksFor(locks)) {
    const source = locks.includes(glob) ? ' from agent.lockedPaths' : '';
    const lock = lockTest(glob, root, home);
    const unwritable = 'Locks are checked first, so the exemption could never unlock anything there. It would only make the file unwritable, and the first attempt would fail.';
    if (lock.matches(join(plans, PROBE)) || lock.holdsDirectly(plans)) {
      throw shaped(`The rulebook puts \`plans.dir\` at \`${written}\`, which overlaps the lock \`${glob}\`${source}: ${why}. ${unwritable} Point \`plans.dir\` at a folder no lock reaches, such as \`~/.katatay/plans\`.`);
    }
    if (lock.matches(followUpsPath)) {
      throw shaped(`The rulebook puts \`followUpsFile\` at \`${followUps}\`, under the lock \`${glob}\`${source}: ${why}. ${unwritable} Point \`followUpsFile\` at a file no lock reaches, such as \`FOLLOW-UPS.md\`.`);
    }
  }

  const tree = lockTest(`${requirements}/**`, root, home);
  const ungated = `Requirements are locked only against deletion, so files there would be edited without a plan and left out of the tree fingerprint, and a reworded requirement would cancel nothing.`;
  if (tree.matches(join(plans, PROBE))) {
    throw shaped(`The rulebook puts \`plans.dir\` at \`${written}\`, inside the requirements folder \`${requirements}/\` from requirementsDir. ${ungated} Point \`plans.dir\` at a folder of its own, such as \`~/.katatay/plans\`.`);
  }
  if (tree.matches(followUpsPath)) {
    throw shaped(`The rulebook puts \`followUpsFile\` at \`${followUps}\`, inside the requirements folder \`${requirements}/\` from requirementsDir. ${ungated} Point \`followUpsFile\` at a file outside it, such as \`FOLLOW-UPS.md\`.`);
  }
}

// ------------------------------------------------------------- requirements

export const DEFAULT_REQUIREMENTS = 'requirements';

/**
 * The folder the requirements live in, from the repository root, without a
 * trailing slash. `requirements` unless the rulebook says otherwise.
 *
 * Relative and inside the repository: an absolute path or one climbing out
 * with `..` would point the guard, which reads the folder from git, at files
 * git does not hold.
 */
export function parseRequirementsDir(config) {
  const { requirementsDir: value = DEFAULT_REQUIREMENTS } = config;
  const folder = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  const segments = folder.split('/');
  if (folder === '' || value.includes('\\') || segments.some((part) => part === '..' || part === '.' || part === '')) {
    throw refuse(`"requirementsDir" is ${JSON.stringify(value)}, which is not a folder inside the repository, such as "requirements"`);
  }
  return folder;
}

export const requirementsDir = (root = process.cwd()) => parseRequirementsDir(readConfig(root));

/** The folder with its trailing slash, for matching and for git pathspecs. */
export const requirementsPrefix = (root = process.cwd()) => `${requirementsDir(root)}/`;
