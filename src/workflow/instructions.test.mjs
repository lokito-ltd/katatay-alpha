/**
 * The workflow's instructions say what the referee does, so they are held to
 * the code here: the plan format it checks, the words the operator types, and
 * the commands it has. Without this, a renamed command or a new plan key would
 * leave the text every project installs quietly wrong.
 *
 * They are installed into projects that have no copy of the harness, so they
 * also point at nothing inside it. `agent-free.test.mjs` and
 * `language-free.test.mjs` hold the same text to no agent's words and no
 * tool's name.
 */
import { describe, expect, it } from 'vitest';
import { readInstructions, readSkills } from './install.mjs';
import { PLAN_KEYS } from './plan-format.mjs';
import { route } from './cli/workflow.mjs';

const text = readInstructions();

/** Every `workflow …` the text names in backticks, as typed. */
const commandsNamed = (source) => [...source.matchAll(/`workflow ([^`]+)`/g)].map((match) => match[1]);

/** A path inside the harness, which a project would not have. */
const HARNESS_PATH = /(?<![\w.-])src\//;

describe('the workflow instructions', () => {
  it('name every key a plan\'s frontmatter may hold', () => {
    for (const key of PLAN_KEYS) expect(text, key).toContain(`\`${key}`);
  });

  it('name both words the operator types', () => {
    expect(text).toContain('`record`');
    expect(text).toContain('`reset`');
  });

  it('name only commands the referee has', () => {
    const named = commandsNamed(text);
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((command) => route(command.split(/\s+/)) === null)).toEqual([]);
  });

  it('list every command a person runs in their table', () => {
    const table = text.slice(text.indexOf('## Commands'));
    for (const command of ['verify', 'triage', 'state show', 'state verify', 'req guard', 'req trace', 'req lint', 'req risk', 'areas', 'coverage', 'report', 'mutate']) {
      expect(table, command).toContain(`\`workflow ${command}`);
    }
  });

  it('point at nothing inside the harness, and neither do the skills', () => {
    expect(HARNESS_PATH.test(text)).toBe(false);
    for (const { name, prompt } of readSkills()) expect(HARNESS_PATH.test(prompt), name).toBe(false);
  });

  // Without these, a pattern that matched nothing would pass on every text.
  it('are read by checks that find what they look for', () => {
    expect(commandsNamed('run `workflow req guard --record` then `workflow nope`')).toEqual(['req guard --record', 'nope']);
    expect(route(['nope'])).toBeNull();
    expect(HARNESS_PATH.test('see src/workflow/x.mjs')).toBe(true);
    expect(HARNESS_PATH.test('the `.katatay/` folder and its src/ list')).toBe(true);
    expect(HARNESS_PATH.test('the my-src/ folder')).toBe(false);
  });
});
