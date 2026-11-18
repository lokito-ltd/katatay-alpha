/**
 * The rulebook for a fixture repository.
 *
 * Every workflow tool that asks which files are tests, code or frozen reads
 * the `tests` and `code` sections of `.katatay/rulebook.json`.
 * A test that builds a repository of its own has to write a rulebook. This gives
 * it this repository's own adapter settings, read from the real config, so a
 * fixture cannot drift from the rules the repository runs under. The other
 * sections are bare: no high-risk areas, no extra checks, coverage switched off
 * with "none", mutation switched off, no agent locks, and plans in Claude
 * Code's default folder, under the fixture's own home. A case that needs more passes it in
 * `fields`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRulebook } from '../../../src/workflow/rulebook.mjs';

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONFIG = '.katatay/rulebook.json';

/** This repository's rulebook, as the operator wrote it. */
export const repositoryRulebook = () => parseRulebook(readFileSync(join(REPOSITORY, CONFIG), 'utf8'));

/**
 * The agent check of this repository, as a fixture repository's rulebook names
 * it. It is the real command, found by its absolute path because a fixture
 * repository has no `tools/` of its own. It runs with the fixture as its
 * working directory, so it reads the fixture's settings.
 */
const AGENT_CHECK = `node ${join(REPOSITORY, 'src/agents/claude/check.mjs')}`;

/** A mutation check for fixtures that exercise its command or report. */
export const fixtureMutation = (over = {}) => ({
  command: 'node mutate.mjs', output: 'reports/mutation/mutation.json', timeLimitSeconds: 240, excludePaths: [], ...over,
});
export const mutationChecks = (mutation = fixtureMutation()) => ({ testQuality: { coverage: 'none', mutation } });

/** The fixture defaults shared by all language configurations. */
export const bareSections = () => ({
  version: 1,
  targetBranch: 'origin/main',
  agent: { lockedPaths: [], adapters: { claude: { extraHooks: { check: true, acknowledged: [] }, checkCommand: AGENT_CHECK } } },
  plans: { dir: '~/.claude/plans' },
  highRisk: [],
  checks: { testQuality: { coverage: 'none', mutation: 'none' } },
});

/** Build a fixture rulebook with optional path and command overrides.
 * An explicit null omits both adapter sections for missing-setting tests.
 * @param {{ adapter?: { paths?: Record<string, unknown>, run?: unknown, codePaths?: unknown, compile?: unknown } | null, fields?: Record<string, unknown> }} [options]
 */
export function fixtureRulebook({ adapter = {}, fields = {} } = {}) {
  const config = { ...bareSections(), ...fields };
  if (adapter !== null) {
    const { tests, code } = repositoryRulebook();
    const settings = { run: tests.run, codePaths: code.paths, compile: code.compile, ...adapter };
    config.tests = { paths: { ...tests.paths, ...adapter.paths }, run: settings.run };
    config.code = { paths: settings.codePaths, compile: settings.compile };
  }
  return config;
}

/** Write the configuration a fixture repository will actually read. */
export function writeConfig(root, options = {}) {
  const config = fixtureRulebook(options);
  mkdirSync(dirname(join(root, CONFIG)), { recursive: true });
  writeFileSync(join(root, CONFIG), `${JSON.stringify(config, null, 2)}\n`);
}
