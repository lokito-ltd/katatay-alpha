/**
 * The `ktty-init` skill's text: that it can be read as a skill, and that
 * what it tells an agent to type is something `init` has. These checks tie its interview and probe examples
 * to the questions and failure states the command accepts.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PROBE_STATES } from '../../evidence/probe-states.mjs';
import { questions } from '../../workflow/init.mjs';
import { readSkills } from '../../workflow/install.mjs';

const FOLDER = fileURLToPath(new URL('.', import.meta.url));
const skills = readSkills(FOLDER);
const { prompt } = skills[0];
const quoted = [...prompt.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
const ids = questions().map(({ id }) => id);

describe('the ktty-init skill', () => {
  it('is the one skill in its folder, read as the support skills are', () => {
    expect(skills.map(({ name }) => name)).toEqual(['ktty-init']);
    expect(skills[0].description).toMatch(/set a project up/i);
    expect(prompt).toMatch(/^# /);
  });

  it('is not among the skills installed into every project', () => {
    expect(readSkills().map(({ name }) => name)).not.toContain('ktty-init');
  });

  it('names only question ids that init asks', () => {
    // A quoted word with a dot in it, and no slash or space, is a question id here.
    const dotted = quoted.filter((text) => /^[a-z][A-Za-z]*(\.[A-Za-z]+)+$/.test(text));
    expect(dotted.length).toBeGreaterThan(10);
    expect(dotted.filter((text) => !ids.includes(text))).toEqual([]);
  });

  it('names every answer the commands are built from', () => {
    const named = ['tests.all', 'tests.acceptance', 'tests.slow', 'testSupport', 'code', 'testRun.command', 'testRun.reports', 'testRun.tagComment',
      'compile.command', 'compile.pattern', 'compile.exitCodes', 'coverage.command', 'coverage.minimum',
      'mutation.command', 'mutation.report', 'mutation.timeLimitSeconds', 'checks.codeQuality', 'wrappers'];
    expect(named.filter((id) => !ids.includes(id))).toEqual([]);
    expect(named.filter((id) => !quoted.includes(id))).toEqual([]);
  });

  it('asks for each break the probe can look for, and no other', () => {
    const expected = [...prompt.matchAll(/--expect ([a-z-]+)/g)].map((match) => match[1]);
    expect([...new Set(expected)].sort()).toEqual([...PROBE_STATES].sort());
  });

  it('probes before it runs init', () => {
    const probing = prompt.indexOf('ktty init --probe --answers <file>');
    const setting = prompt.indexOf('Run `ktty init --answers <file>`');
    expect(probing).toBeGreaterThan(-1);
    expect(setting).toBeGreaterThan(probing);
  });

  it('keeps all glue in the project\'s own repository', () => {
    expect(prompt).toContain('**All glue goes in the project\'s own repository.**');
    expect(prompt).toMatch(/Write nothing\s+into the harness, the operator's home folder or anywhere else on the machine/);
  });

  it('names no agent, no agent\'s tools and no file a project does not have', () => {
    const text = `${skills[0].description}\n${prompt}`;
    expect(text).not.toMatch(/\b(claude|codex|cursor|anthropic|openai)\b/i);
    expect(text).not.toMatch(/\b(ExitPlanMode|EnterPlanMode|AskUserQuestion|PreToolUse|PostToolUse)\b/);
    expect(text).not.toMatch(/\.claude\b|\.codex\b|\.agents\b|AGENTS\.md/);
    expect(text).not.toMatch(/(^|[\s`'"(])src\//m);
  });
});
