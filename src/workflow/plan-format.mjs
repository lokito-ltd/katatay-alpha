/**
 * The plan format the referee checks, said in words any agent can follow.
 *
 * It sits in a module of its own, with no imports, because the write gate
 * (`hooks/gate.mjs`) prints it when it asks for a plan, and the gate runs
 * before every tool call. The parser that checks the format (`readPlan` in
 * `plan.mjs`) needs `gray-matter`, and the gate should not load a library to
 * print a paragraph.
 *
 * The text is the referee's own, so nothing the referee requires depends on a
 * skill explaining it. A skill may say more; it may not be the only place this
 * is said.
 */

/** The keys a plan's `workflow` block may hold. Anything else is refused. */
export const PLAN_KEYS = ['test-only', 'requirement-changes', 'predicted-failures'];

/** The requirement statuses a `requirement-changes` entry may name. */
export const LIFECYCLE = ['accepted', 'active', 'superseded', 'withdrawn'];

/** One source for the template shown to an agent and the sections checked. */
export const PLAN_SECTIONS = [
  { heading: 'Why', placeholder: '{{WHY}}', help: 'The problem or need, and what prompted it.' },
  { heading: 'What', placeholder: '{{WHAT}}', help: 'The new behaviour. Exclusions are optional, as prose or an Out of scope subsection.' },
  { heading: 'How', placeholder: '{{HOW}}', help: 'The design and implementation approach.' },
  { heading: 'Requirements', placeholder: '{{REQUIREMENTS}}', help: 'Requirements to add, modify or retire, or None.' },
  { heading: 'Predicted failures', placeholder: '{{PREDICTED_FAILURES}}', help: 'Which existing tests will fail and why, or None. Put predictions in the closing workflow block.' },
  { heading: 'Test delta', placeholder: '{{TEST_DELTA}}', help: 'The tests to add.' },
];

export const planTemplate = () => PLAN_SECTIONS.map(({ heading, placeholder, help }) =>
  `## ${heading}\n\n<!-- ${help} -->\n${placeholder}`).join('\n\n');

export const templateGuidance = () => `Use these six sections once each, in this order and at heading level two. Replace every placeholder with content. Requirements and Predicted failures may say None. Exclusions are optional. At turn end, agent adapters should send \`planFile\` for a presented plan. This courtesy helps the operator see problems before approving; approval does not depend on it. Its messages never replace the freeze check, verification, mutation or recording. The rulebook's \`plans.validateFormat\` defaults to true. False skips template checks, but YAML and declaration checks still apply.\n\n\`\`\`\`markdown\n${planTemplate()}\n\`\`\`\``;

/** Expanded before installation, so the installed texts share the template. */
export const expandPlanTemplate = (text) => text.replaceAll('<!-- PLAN_TEMPLATE -->', templateGuidance());

/**
 * @param {string} folder the plans folder, as the rulebook spells it
 */
export const planFormat = (folder) => `A plan is a Markdown file directly in ${folder}, the rulebook's plans folder. It uses the template below, and may end with a fenced code block labelled \`workflow\`: a line of three backticks and the word workflow, the block, then a line of three backticks, as the last thing in the file. The block is YAML holding only these keys:

- \`test-only: true\` declares a change made only of tests. Leave it out otherwise.
- \`requirement-changes:\` lists each requirement the change adds, rewords or retires, as it will read afterwards. Each entry has \`id\` (such as AC0004 or INV0002), \`status\` (${LIFECYCLE.join(', ')}), \`statement\`, and \`scenarios\` when the requirement has any, each one a string such as '[AC0004.1] The scenario as it will read.'. A renumbered requirement adds \`renumberedFrom\` with its old id.
- \`predicted-failures:\` lists the existing tests the change is expected to make fail. Every test it leaves out is expected to pass. Each entry is one string: a scenario id such as AC0004.1, for every acceptance test tagged with it; a test file's path from the repository root, for every test in it, as when it fails to load; or the path, \`::\` and a test's name, such as src/a.test.ts::refuses a missing key, for that one test. The triage reports a failure no entry predicted, and a predicted test that passed.

Only that closing block declares anything. A \`workflow\` block anywhere else, and \`---\` frontmatter at the top of the plan, are refused. An example of the block inside a plan uses another label, such as yaml.

${templateGuidance()}`;
