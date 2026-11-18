import { describe, expect, it } from 'vitest';
import { templateProblems } from './plan-template.mjs';
import { planTemplate } from './plan-format.mjs';
import { parsePlanValidation } from './rulebook.mjs';
import { shapeProblems } from './moments/io.mjs';

const sections = ['Why', 'What', 'How', 'Requirements', 'Predicted failures', 'Test delta'];
const plan = (over = {}) => '# A bounded change\n\n' + sections.map((name) =>
  `## ${name}\n\n${over[name] ?? 'Concrete content.'}\n`).join('\n');

describe('the presented plan template', () => {
  it('accepts content, optional exclusions and explicit None', () => {
    for (const what of ['New behaviour.', 'New behaviour. No exclusions.', 'New behaviour.\n\n### Out of scope\n\nOther work.']) {
      expect(templateProblems(plan({ What: what, Requirements: 'None', 'Predicted failures': 'None.' }))).toEqual([]);
    }
    expect(templateProblems(plan().replaceAll('\n', '\r\n'))).toEqual([]);
  });

  it.each(sections)('reports the missing %s section', (name) => {
    expect(templateProblems(plan().replace(`## ${name}\n\nConcrete content.\n`, ''))).toContain(`section ${name} is missing`);
  });

  it.each(sections)('rejects an empty %s section even with comments or subheadings', (name) => {
    expect(templateProblems(plan({ [name]: '\n<!-- explain later -->\n### Subheading\n' }))).toContain(`section ${name} is empty`);
  });

  it('reports duplicate, missing and placeholder problems together', () => {
    const text = plan({ Why: '{{WHY}}' }).replace('## What', '### What') + '\n## Why\nMore content.\n';
    expect(templateProblems(text)).toEqual(expect.arrayContaining([
      'section Why appears more than once',
      'section What is missing; found `### What` — a section heading is exactly `## What`', 'section Why still contains a template placeholder',
    ]));
    expect(templateProblems(planTemplate()).filter((p) => p.includes('placeholder'))).toHaveLength(6);
  });

  it('does not take headings from examples, blockquotes, indented code or comments', () => {
    for (const example of ['```markdown\n## Why\nExample.\n```', '~~~~\n## Why\nExample.\n~~~~',
      '> ## Why\n> Example.', '    ## Why\n    Example.', '<!--\n## Why\nExample.\n-->']) {
      expect(templateProblems(example + '\n' + plan())).toEqual([]);
      expect(templateProblems(example)).toContain('section Why is missing');
    }
    expect(templateProblems(plan().replace('## Why', '## WHY'))).toContain('section Why is missing; found `## WHY` — a section heading is exactly `## Why`');
  });

  it('accepts subordinate headings and a closing declaration block', () => {
    expect(templateProblems(plan({ How: '### Design\nA design.' }) + '\n```workflow\npredicted-failures: []\n```')).toEqual([]);
  });

  it('reports the missing heading when a CRLF plan shows it only in a fenced example', () => {
    const example = '```markdown\n## Why\nExample reason.\n```';
    const text = plan().replace('## Why', example).replaceAll('\n', '\r\n');
    expect(templateProblems(text)).toEqual(['section Why is missing']);
  });

  it('reports an empty Test delta above a CRLF declaration block', () => {
    const text = plan({ 'Test delta': '```workflow\ntest-only: true\n```' }).replaceAll('\n', '\r\n');
    expect(templateProblems(text)).toEqual(['section Test delta is empty']);
  });

  it('keeps a section-named subheading and its prose inside its parent section', () => {
    expect(templateProblems(plan({ How: '### Why\nThis explains the design.\n#### What\nDetails.' }))).toEqual([]);
  });

  it('names level, case and spacing near misses without accepting them as sections', () => {
    for (const heading of ['### Predicted Failures', '## Predicted  failures', '# Predicted failures',
      '## Predictedfailures', '  ### Predicted Failures  ']) {
      expect(templateProblems(plan().replace('## Predicted failures', heading))).toEqual([
        `section Predicted failures is missing; found \`${heading.trim()}\` — a section heading is exactly \`## Predicted failures\``,
      ]);
    }
    expect(templateProblems(plan().replace('## Predicted failures', '## Predicted # failures'))).toEqual([
      'section Predicted failures is missing',
    ]);
  });

  it('reports a duplicate once and checks order using only first occurrences', () => {
    expect(templateProblems(plan() + '\n## Why\nAnother reason.\n## Why\nYet another.')).toEqual([
      'section Why appears more than once',
    ]);
    const swapped = plan().replace('## Why', '## Swap').replace('## What', '## Why').replace('## Swap', '## What');
    expect(templateProblems(swapped)).toEqual(['section Why is out of order']);
  });

  it('ignores placeholders in fenced examples and matched inline code spans', () => {
    for (const content of ['```markdown\n{{WHY}}\n```', '~~~~\n{{WHY}}\n~~~~',
      'Example: `{{WHY}}`.', 'Example: ``a ` {{WHY}}``.', 'Example: ``{{WHY}}\n{{WHAT}}``.',
      'Example: ````````{{WHY}}````````.', '{{WH\nY}}']) {
      expect(templateProblems(plan({ How: content })), content).toEqual([]);
    }
    for (const content of ['Use {{WHY}} here.', 'Unclosed `{{WHY}}', '`Example` then {{WHY}}', '{{WHY}} then `Example`',
      '```markdown\n{{WHY}}\n```\nReplace {{HOW}}.']) {
      expect(templateProblems(plan({ How: content })), content).toContain('section How still contains a template placeholder');
    }
  });

  it('accepts Markdown heading whitespace and closing hashes, without treating inline hashes as closers', () => {
    expect(templateProblems(plan().replaceAll('## ', '##   ').replace('##   Why', '##   Why  ###'))).toEqual([]);
    for (const heading of ['## Why###', '## Why ### extra']) {
      expect(templateProblems(plan().replace('## Why', heading))).toContain('section Why is missing');
    }
  });

  it('does not let other sections or headings supply an empty section’s content', () => {
    expect(templateProblems(plan({ Why: '## Notes\nUnrelated content.' }))).toContain('section Why is empty');
    expect(templateProblems(plan({ Why: '###' }))).toContain('section Why is empty');
    // The deeper heading and its prose now belong to Why. What is missing.
    expect(templateProblems(plan({ Why: '' }).replace('## What', '### What'))).not.toContain('section Why is empty');
    expect(templateProblems(plan({ Why: '' }).replace('## What', '### What'))).toContain('section What is missing; found `### What` — a section heading is exactly `## What`');
    expect(templateProblems(plan({ Why: '' }).replace('## Why', '# Intro\nEarlier content.\n## Why'))).toContain('section Why is empty');
  });

  it('counts ordinary indented prose and inline markers as content', () => {
    for (const content of [' One leading space.', 'Ordinary    spaced prose.', 'Text > quote', 'Inline # heading', 'Two\nlines']) {
      expect(templateProblems(plan({ Why: content })), content).toEqual([]);
    }
    expect(templateProblems(plan({ Why: '    Indented content.' }))).toEqual([]);
    expect(templateProblems(plan({ Why: '> Quoted reason.' }))).toEqual([]);
    expect(templateProblems(plan({ How: '```js\nperformChange();\n```' }))).toEqual([]);
    expect(templateProblems(plan({ Why: '> ## Heading alone' }))).toContain('section Why is empty');
    expect(templateProblems(plan({ Why: '```markdown\n## Heading alone\n```' }))).toContain('section Why is empty');
    expect(templateProblems(plan({ 'Test delta': '```workflow\npredicted-failures: []\n```' }))).toContain('section Test delta is empty');
  });

  it('ignores an unclosed comment and keeps placeholders local to their section', () => {
    expect(templateProblems('<!--\n' + plan())).toContain('section Why is missing');
    const problems = templateProblems(plan({ Why: '{{WHAT}}' }));
    expect(problems).toEqual(['section Why still contains a template placeholder']);
  });
});

describe('the template validation switch', () => {
  it('defaults on and accepts only booleans when supplied', () => {
    expect(parsePlanValidation({ plans: { dir: 'plans' } })).toBe(true);
    expect(parsePlanValidation({ plans: { validateFormat: true } })).toBe(true);
    expect(parsePlanValidation({ plans: { validateFormat: false } })).toBe(false);
    for (const value of [null, 'false', 0, [], {}]) {
      expect(() => parsePlanValidation({ plans: { validateFormat: value } })).toThrow(/plans.validateFormat/);
    }
  });
});

describe('an optional plan file on the wire', () => {
  it('accepts omitted, null and nonempty paths, and rejects every other value', () => {
    const shape = { planFile: 'optional string|null' };
    for (const planFile of [undefined, null, 'a.md']) expect(shapeProblems({ planFile }, shape)).toEqual([]);
    for (const planFile of ['', false, 3, [], {}]) expect(shapeProblems({ planFile }, shape)).toHaveLength(1);
  });
});
