/**
 * What the Claude adapter installs into a project: the workflow's
 * instructions and the harness support skills, in the format and the place
 * Claude Code reads them. The answer to the contract's `install` command (see
 * `src/agents/README.md`).
 *
 * The referee sends the texts in the request. This never reads the referee's
 * files, because a project has no copy of the harness: once the harness is
 * packaged, nothing under `src/` is there. For the same reason nothing
 * installed here points back into `src/`.
 *
 * - The instructions become `.claude/rules/workflow.md`. Claude Code loads
 *   every Markdown file in `.claude/rules/` at the start of each session, so
 *   `CLAUDE.md` stays the project's own and needs no edit. The referee's text
 *   comes first, then a section in Claude Code's words.
 * - Each skill becomes `.claude/skills/<name>/SKILL.md`, where Claude Code
 *   finds skills, with Claude's words added where they help.
 *
 * The referee's prompts are a starting point. This adapter may reword them as
 * it wishes, and so may an agent that runs `init`. Today it only adds.
 *
 * A plain function, so tests run it in process where coverage sees it.
 * `install.mjs` is the command around it.
 */

/** Where Claude Code reads the workflow's instructions from. */
import { join } from 'node:path';
import { homedir } from 'node:os';

export const userSkillFile = (name) => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills', name, 'SKILL.md');

export const INSTRUCTIONS_FILE = '.claude/rules/workflow.md';

/** Where Claude Code finds a skill. */
export const skillFile = (name) => `.claude/skills/${name}/SKILL.md`;

/** How a plan is presented and approved in Claude Code. Said in the instructions and in `plan-change`. */
const PRESENTING = `Presenting a plan:
- Switch into plan mode with \`EnterPlanMode\`, write the plan to the plan file Claude Code names, and present it with \`ExitPlanMode\`.
- The operator's approval in the plan-mode dialog is the approval. The \`PostToolUse\` hook records it against the text they approved, edits included.
- A rejected plan records nothing. "Keep planning" means revise the plan file and call \`ExitPlanMode\` again.
- Before \`ExitPlanMode\`, the \`PreToolUse\` hook sends the plan file to the referee for a courtesy check. Invalid contents request a correction once per session and prompt; another presentation can proceed. Missing inputs, read failures and checker failures warn without blocking. A valid plan is silent.
- The hook never approves the dialog, and approval does not depend on the check.
- Upgrading an existing registration: the operator adds \`ExitPlanMode\` to the pre-tool matcher and starts a new session.
- Your memory notes sit outside the repository and can be written in any phase.`;

/**
 * What only Claude Code needs to know, after the referee's text. The list of
 * skills is built from the request, so a skill the referee adds is named too.
 */
const claudeSection = (skills) => `## In Claude Code

Hooks, registered in \`.claude/settings.json\`:
- \`UserPromptSubmit\`: puts the phase in front of every turn, and catches the operator's \`record\` and \`reset\`.
- \`PreToolUse\`: asks the referee before every \`Edit\`, \`Write\`, \`NotebookEdit\` and \`Bash\` call. In phase \`open\`, \`Edit\`, \`Write\` and \`NotebookEdit\` are denied, except on plan files and the follow-ups file. For \`ExitPlanMode\`, it checks the presented plan as a courtesy.
- \`PostToolUse\` on \`ExitPlanMode\`: records the operator’s approval as \`plan_approved\`.
- \`Stop\`: the turn-end hook. Runs verify, the test-quality report, the record step and the staging. Its block is one-shot; stopping past it only stalls the phase.

Reports:
- After \`workflow checks-analysis\` accepts an analysis, post the summary it prints verbatim. Never paste the full analysis.
- After \`workflow triage\`, post its report verbatim, through the \`Details:\` line. The rest is for you.
- When the Stop hook asks you to repeat a verification summary, passed or failed, post it verbatim, through the \`Details:\` line. Then act on what follows it.

${PRESENTING}

Harness support skills, to use where they fit:
${skills.map(({ name, description }) => `- \`${name}\`: ${description}`).join('\n')}

Claude Code's own settings:
- Locked by the rulebook's \`agent.lockedPaths\`: \`.claude/settings.json\`, \`.claude/settings.local.json\`, \`.claude/hooks/\` and \`~/.claude/settings.json\`.
- Not lockable, and warned about on every turn by the adapter's check: a hook registered in \`~/.claude/settings.json\` or another settings file, which can answer the plan dialog for the operator; \`disableAllHooks\`, which turns every hook off; a \`plansDirectory\` that differs from the rulebook's \`plans.dir\`; an \`env\` entry such as \`CI\`, which changes what the requirements guard fails on; hooks in a skill's or an agent's frontmatter; this file missing.
- Pass every such warning on to the operator.
`;

/**
 * Claude's words for a skill, by name, added at the end of the prompt. A
 * skill not listed is installed as the referee wrote it.
 */
export const SKILL_WORDS = {
  'plan-change': `## In Claude Code

${PRESENTING}
`,
  'commit-message': `## In Claude Code

Ask for commit approval, and whether to stage or push, in plain chat text, never with \`AskUserQuestion\`: in the desktop app its dialog covers the text before it and does not show an option's \`preview\`, so the operator would approve a message they cannot see.
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
    { path: INSTRUCTIONS_FILE, text: `${instructions.trimEnd()}\n\n${claudeSection(skills)}` },
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
