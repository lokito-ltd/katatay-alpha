/**
 * What the Cursor adapter installs into a project: the workflow's
 * instructions and the harness support skills, in the format and the place
 * Cursor reads them. The answer to the contract's `install` command (see
 * `src/agents/README.md`).
 *
 * The referee sends the texts in the request. This never reads the referee's
 * files, because a project has no copy of the harness, and nothing installed
 * here points back into `src/`.
 *
 * - The instructions become `.cursor/rules/workflow.mdc`, a project rule with
 *   `alwaysApply: true`, so Cursor puts it in front of every chat. A folder of
 *   rules, like Claude Code's `.claude/rules/`, so the project's own rules
 *   stay the project's. The referee's text comes first, then a section in
 *   Cursor's words.
 * - Each skill becomes `.cursor/skills/<name>/SKILL.md`, with the same
 *   `name` and `description` frontmatter as the other agents' skills.
 *
 * The referee's prompts are a starting point. This adapter may reword them,
 * and so may an agent that runs `init`. Today it only adds.
 *
 * A plain function, so tests run it in process where coverage sees it.
 * `install.mjs` is the command around it.
 */

/** Where Cursor reads the workflow's instructions from. */
export const INSTRUCTIONS_FILE = '.cursor/rules/workflow.mdc';

/** Where Cursor finds a repository's skill. */
export const skillFile = (name) => `.cursor/skills/${name}/SKILL.md`;

/** The first sentence of the prompt Cursor sends when the operator clicks Build. Said here so the agent never sends it. */
export const BUILD_WORDS = 'Implement the plan as specified, it is attached for your reference.';

/** How a plan is presented and approved in Cursor. Said in the instructions and in `plan-change`. */
const PRESENTING = `Presenting a plan:
- The operator switches Cursor into Plan mode. If a change needs a plan and Cursor is not in Plan mode, ask the operator to switch, and make no edits until then.
- In Plan mode, present the plan with \`CreatePlan\`. Put the plan's six sections, and the closing \`workflow\` block when it has one, in its \`plan\` text. Give it a short \`name\`. The frontmatter Cursor adds to its own copy is dropped when the plan is approved.
- The operator approves by clicking Build. Build sends the prompt "${BUILD_WORDS} …", and the prompt hook saves the plan Cursor kept for it, the operator's edits included, to its own file in the rulebook's plans folder and asks the referee to record it.
- Never write those words yourself, in a reply, a file or a command. Only the operator's click approves a plan.
- At the turn end, a plan presented in the turn is sent to the referee as a courtesy check, which may ask once for corrections. A valid plan grants no approval, and approval does not depend on the check.
- Reapproving identical content preserves the current phase and its evidence. Only changed content starts a revision and freezes the tests again.
- A plan the operator does not build records nothing.`;

/**
 * What only Cursor needs to know, after the referee's text. The list of skills
 * is built from the request, so a skill the referee adds is named too.
 */
const cursorSection = (skills) => `## In Cursor

Hooks, registered in \`.cursor/hooks.json\`:
- \`beforeSubmitPrompt\`: puts the phase in front of every turn, records the plan the operator built as \`plan_approved\`, and catches the operator's \`record\` and \`reset\`.
- \`preToolUse\`: asks the referee before every \`Write\`, \`Delete\` and \`Shell\` call. In phase \`open\`, a write is denied, except on plan files and the follow-ups file.
- \`stop\`: the turn-end hook. Runs verify, the test-quality report, the record step and the staging. When it sends you back to work, or has a report for the operator, its message arrives as a new prompt.

Reports:
- Messages marked for the operator arrive in your context. Post each one verbatim in your reply, through its \`Details:\` line: Cursor shows the operator nothing a hook says.
- After \`workflow triage\`, post its report verbatim, through the \`Details:\` line. The rest is for you.
- When the stop hook asks you to post a verification summary, post it verbatim, through its \`Details:\` line. Then act on what follows it.
- After \`workflow checks-analysis\` accepts an analysis, post the summary it prints verbatim. Never paste the full analysis.

${PRESENTING}

Harness support skills, to use where they fit:
${skills.map(({ name, description }) => `- \`${name}\`: ${description}`).join('\n')}

Cursor's own settings:
- Locked by the rulebook's \`agent.lockedPaths\`: \`.cursor/hooks.json\`, \`.cursor/hooks/\`, \`~/.cursor/hooks.json\`, \`~/.cursor/plans/\` and \`~/.cursor/projects/\`, so a session cannot switch off its hooks or rewrite the plan or transcript an approval is read from.
- Not lockable, and warned about on every turn by the adapter's check: a workflow hook missing or changed in \`.cursor/hooks.json\`; a hook in a project, user or enterprise hooks file that is not the workflow's; this file missing. Team and plugin hooks cannot be seen.
- Cursor also runs the hooks in \`.claude/settings.json\`. The Claude Code workflow hooks answer nothing when Cursor runs them.
- Pass every such warning on to the operator.
`;

/**
 * Cursor's words for a skill, by name, added at the end of the prompt. A skill
 * not listed is installed as the referee wrote it.
 */
export const SKILL_WORDS = {
  'plan-change': `## In Cursor

${PRESENTING}
`,
};

/** A frontmatter value, quoted only when YAML would read it as something else. */
const yamlValue = (text) => (/^[\w(][^\n]*$/.test(text) && !/: |\s#/.test(text) ? text : JSON.stringify(text));

/**
 * The files to write, `{ path, text }` each, paths from the project root.
 *
 * @param {{ instructions: string, skills: { name: string, description: string, prompt: string }[] }} request
 */
export function installFiles({ instructions, skills }) {
  return [
    {
      path: INSTRUCTIONS_FILE,
      text: [
        '---',
        'description: The workflow Katatay enforces in this repository.',
        'alwaysApply: true',
        '---',
        '',
        `${instructions.trimEnd()}\n\n${cursorSection(skills)}`,
      ].join('\n'),
    },
    ...skills.map(({ name, description, prompt }) => ({
      path: skillFile(name),
      text: [
        '---',
        `name: ${name}`,
        `description: ${yamlValue(description)}`,
        '---',
        '',
        prompt.trimEnd(),
        ...(Object.hasOwn(SKILL_WORDS, name) ? ['', SKILL_WORDS[name].trimEnd()] : []),
        '',
      ].join('\n'),
    })),
  ];
}
