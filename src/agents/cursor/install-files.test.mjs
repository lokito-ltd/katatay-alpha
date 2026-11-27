import { describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import { BUILD_WORDS, INSTRUCTIONS_FILE, SKILL_WORDS, installFiles, skillFile } from './install-files.mjs';

const REQUEST = {
  instructions: '# The workflow\n\nThe rules.\n\n',
  skills: [
    { name: 'plan-change', description: 'Produce a bounded change plan.', prompt: '# Planning\n\nPresent it.\n' },
    { name: 'brand-new', description: 'Something: with a colon, and # a hash.', prompt: '# New\n' },
  ],
};

const at = (path) => installFiles(REQUEST).find((file) => file.path === path)?.text;

describe('what the Cursor adapter installs', () => {
  it('puts the instructions in a rule Cursor always applies, and each skill where Cursor finds a repository\'s skills', () => {
    expect(installFiles(REQUEST).map(({ path }) => path)).toEqual([INSTRUCTIONS_FILE, '.cursor/skills/plan-change/SKILL.md', '.cursor/skills/brand-new/SKILL.md']);
    expect(INSTRUCTIONS_FILE).toBe('.cursor/rules/workflow.mdc');
    expect(skillFile('x')).toBe('.cursor/skills/x/SKILL.md');
    expect(installFiles(REQUEST).some((file) => file.shared)).toBe(false);
  });

  it('opens the rule with frontmatter that applies it always, then the referee\'s text, then what only Cursor needs', () => {
    const { data, content } = matter(at(INSTRUCTIONS_FILE));
    expect(data).toEqual({ description: 'The workflow Katatay enforces in this repository.', alwaysApply: true });
    expect(content.startsWith('\n# The workflow\n\nThe rules.\n\n## In Cursor\n')).toBe(true);
    for (const word of ['beforeSubmitPrompt', 'preToolUse', 'stop', '`Write`', '`Delete`', '`Shell`', 'Plan mode', 'CreatePlan', 'Build',
      BUILD_WORDS, '~/.cursor/plans/', '~/.cursor/projects/', '.claude/settings.json', 'verbatim', '`plan-change`: Produce a bounded change plan.']) {
      expect(content, word).toContain(word);
    }
    expect(content).toContain('Never write those words yourself');
  });

  it('gives each skill its name and description, quoting a description YAML would misread', () => {
    const { data, content } = matter(at('.cursor/skills/brand-new/SKILL.md'));
    expect(data).toEqual({ name: 'brand-new', description: 'Something: with a colon, and # a hash.' });
    expect(content).toBe('\n# New\n');
    expect(matter(at('.cursor/skills/plan-change/SKILL.md')).data.description).toBe('Produce a bounded change plan.');
  });

  it('adds Cursor\'s words to plan-change, and to no skill it has none for', () => {
    const text = at('.cursor/skills/plan-change/SKILL.md');
    expect(text.endsWith(`Present it.\n\n${SKILL_WORDS['plan-change'].trimEnd()}\n`)).toBe(true);
    expect(SKILL_WORDS['plan-change']).toContain('CreatePlan');
    expect(Object.keys(SKILL_WORDS)).toEqual(['plan-change']);
  });
});

describe('details the mutation run found', () => {
  it('lists each skill on its own line', () => {
    expect(at(INSTRUCTIONS_FILE)).toContain('- `plan-change`: Produce a bounded change plan.\n- `brand-new`: Something: with a colon, and # a hash.\n');
  });

  it('quotes a description only when YAML would misread it', () => {
    const cases = [
      ['Produce a bounded change plan.', 'description: Produce a bounded change plan.'],
      ['(brackets) first', 'description: (brackets) first'],
      ['- dash first', 'description: "- dash first"'],
      ['two\nlines', 'description: "two\\nlines"'],
      ['see #1', 'description: "see #1"'],
      ['C#', 'description: C#'],
      ['x', 'description: x'],
    ];
    for (const [description, line] of cases) {
      const text = installFiles({ instructions: 'i', skills: [{ name: 'one', description, prompt: 'p' }] })[1].text;
      expect(text.split('\n')[2], description).toBe(line);
      expect(matter(text).data.description, description).toBe(description);
    }
  });
});
