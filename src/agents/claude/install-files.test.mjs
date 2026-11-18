import { describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import { INSTRUCTIONS_FILE, SKILL_WORDS, installFiles, skillFile } from './install-files.mjs';

const REQUEST = {
  instructions: '# The workflow\n\nThe rules.\n\n',
  skills: [
    { name: 'plan-change', description: 'Produce a bounded change plan.', prompt: '# Planning\n\nPresent it.\n' },
    { name: 'brand-new', description: 'Something: with a colon, and # a hash.', prompt: '# New\n' },
  ],
};

// Built inside each test, never when the file loads: a mutation tool switches
// a mutant on per test, so files built at load time would never meet one.
const at = (path) => installFiles(REQUEST).find((file) => file.path === path)?.text;

describe('what the Claude adapter installs', () => {
  it('puts the instructions where Claude Code loads them by itself, and each skill where it finds skills', () => {
    expect(installFiles(REQUEST).map(({ path }) => path)).toEqual([INSTRUCTIONS_FILE, '.claude/skills/plan-change/SKILL.md', '.claude/skills/brand-new/SKILL.md']);
    expect(INSTRUCTIONS_FILE).toBe('.claude/rules/workflow.md');
    expect(skillFile('x')).toBe('.claude/skills/x/SKILL.md');
  });

  it('keeps the referee\'s instructions first, then adds what only Claude Code needs', () => {
    const text = at(INSTRUCTIONS_FILE);
    expect(text.startsWith('# The workflow\n\nThe rules.\n\n## In Claude Code\n')).toBe(true);
    for (const word of ['EnterPlanMode', 'ExitPlanMode', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'memory notes', 'disableAllHooks', 'plansDirectory', '~/.claude/settings.json']) {
      expect(text, word).toContain(word);
    }
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('names every skill it was given, with its description, so the agent knows when to use one', () => {
    const text = at(INSTRUCTIONS_FILE);
    expect(text).toContain('\n- `plan-change`: Produce a bounded change plan.\n- `brand-new`: Something: with a colon, and # a hash.\n');
  });

  it('explains when the courtesy runs and who approves', () => {
    for (const path of [INSTRUCTIONS_FILE, skillFile('plan-change')]) {
      const text = at(path);
      expect(text).toContain('Before `ExitPlanMode`, the `PreToolUse` hook');
      expect(text).toContain('never approves the dialog');
    }
  });

  it('gives each skill the frontmatter Claude Code reads, with the name and description carried over', () => {
    for (const { name, description } of REQUEST.skills) {
      const { data } = matter(at(skillFile(name)));
      expect(data).toEqual({ name, description });
    }
  });

  it('adds Claude\'s words to a skill it has words for, after the prompt', () => {
    const text = at(skillFile('plan-change'));
    expect(text).toContain('# Planning\n\nPresent it.\n\n## In Claude Code\n');
    expect(text).toContain('ExitPlanMode');
    expect(Object.keys(SKILL_WORDS).sort()).toEqual(['commit-message', 'plan-change']);
    expect(SKILL_WORDS['commit-message']).toContain('AskUserQuestion');
  });

  it('still installs a skill it has no words for, as the referee wrote it', () => {
    expect(at(skillFile('brand-new'))).toBe('---\nname: brand-new\ndescription: "Something: with a colon, and # a hash."\n---\n\n# New\n');
  });

  it('quotes a description only when YAML would misread it', () => {
    const one = (description) => installFiles({ instructions: 'x', skills: [{ name: 'a', description, prompt: 'p' }] })[1].text.split('\n')[2];
    expect(one('Plain words, and a dash — fine.')).toBe('description: Plain words, and a dash — fine.');
    expect(one('Key: value')).toBe('description: "Key: value"');
    expect(one('- a list?')).toBe('description: "- a list?"');
    expect(one('ends with # comment')).toBe('description: "ends with # comment"');
    expect(one('two\nlines')).toBe('description: "two\\nlines"');
  });

  it('points at nothing inside the harness, which a project does not have', () => {
    for (const { path, text } of installFiles(REQUEST)) expect(/(?<![\w.-])src\//.test(text), path).toBe(false);
  });
});
