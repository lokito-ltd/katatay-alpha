/**
 * What the Codex adapter installs into a project: the workflow's
 * instructions and the harness support skills, in the format and the place
 * Codex reads them. The answer to the contract's `install` command (see
 * `src/agents/README.md`).
 *
 * The referee sends the texts in the request. This never reads the referee's
 * files, because a project has no copy of the harness, and nothing installed
 * here points back into `src/`.
 *
 * - The instructions become `AGENTS.md` at the root. Codex reads `AGENTS.md`
 *   from the root down to its working directory, and has no folder of rules
 *   the way Claude Code has `.claude/rules/`, so the workflow's text and the
 *   project's own share this one file. The referee's text comes first, then a
 *   section in Codex's words. The file is marked shared, so on a project that
 *   already has an `AGENTS.md`, `init` appends the workflow's part between
 *   marker lines instead of skipping the file.
 * - Each skill becomes `.agents/skills/<name>/SKILL.md`, where Codex finds a
 *   repository's skills. The frontmatter is the same as Claude Code's: `name`
 *   and `description`.
 *
 * The referee's prompts are a starting point. This adapter may reword them,
 * and so may an agent that runs `init`. Today it only adds.
 *
 * A plain function, so tests run it in process where coverage sees it.
 * `install.mjs` is the command around it.
 */

/** Where Codex reads the workflow's instructions from. */
import { join } from 'node:path';
import { homedir } from 'node:os';

export const userSkillFile = (name) => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', name, 'SKILL.md');

export const INSTRUCTIONS_FILE = 'AGENTS.md';

/** Where Codex finds a repository's skill. */
export const skillFile = (name) => `.agents/skills/${name}/SKILL.md`;

/** How a plan is presented and approved in Codex. Said in the instructions and in `plan-change`. */
const PRESENTING = `Presenting a plan:
- Codex has no plan tool the agent can call. The operator switches Codex into Plan mode (Shift+Tab in the CLI). If a change needs a plan and Codex is not in Plan mode, ask the operator to switch, and make no edits until then.
- In Plan mode, present the whole plan as one \`<proposed_plan>\` block with the plan's sections inside. Codex asks the operator "Implement this plan?": "Yes, implement this plan" sends \`Implement the plan.\`; "Yes, clear context and implement" starts a new thread with the plan in its first prompt; "No, stay in Plan mode" sends nothing, so revise and present again.
- At Stop, the adapter saves the completed Plan item from the current turn to its own file in the rulebook's plans folder and sends the path to the referee as a courtesy check, which may ask once for corrections. Capture problems and an unreadable or misplaced plan file are warnings; the referee still does the turn end's other work. A valid plan grants no approval, and approval does not depend on the check. An ordinary turn never checks an older plan. When the final message is exactly null and no Plan item is found, capture waits up to 1.5 seconds for it to reach disk, then warns that a plan may have gone unchecked.
- Short approval prompts select the latest completed Plan item in this chat, even after intervening discussion: \`Implement the plan\`, \`Implement this plan\`, \`Approve the plan\`, \`Approve this plan\`, \`Yes, implement this plan\`, \`Yes\`, \`Approved\`, \`Go ahead\`, \`Proceed\`, as the whole prompt. Case and surrounding punctuation or Markdown markers are ignored; internal punctuation and spacing are exact. Stop capture still selects only the current turn.
- A desktop approval message may start with the exact prefix \`PLEASE IMPLEMENT THIS PLAN:\`. The text after it is the approved plan, takes precedence over the transcript, and needs no turn ID. When it is absent or blank, the latest completed Plan item in this chat is the fallback. A newer empty or malformed Plan never selects an older one. The clear-context handoff uses the plan in its first prompt.
- Reapproving identical content preserves the current phase and its evidence: the referee reports the plan is already approved. Only changed content starts a revision and freezes the tests again.
- The prompt hook saves the approved text and asks the referee to record it. Approval parses the declarations without rerunning template validation or needing a validation receipt. A plan the operator does not approve records nothing. You cannot approve a plan yourself: only a prompt from the operator does.`;

/**
 * What only Codex needs to know, after the referee's text. The list of skills
 * is built from the request, so a skill the referee adds is named too.
 */
const codexSection = (skills) => `## In Codex

Hooks, registered in \`.codex/hooks.json\`:
- \`UserPromptSubmit\`: puts the phase in front of every turn, records an approved plan as \`plan_approved\`, and catches the operator's \`record\` and \`reset\`.
- \`PreToolUse\`: asks the referee before every \`apply_patch\` and \`Bash\` call. In phase \`open\`, a patch is denied, except on plan files and the follow-ups file.
- \`Stop\`: the turn-end hook. Runs verify, the test-quality report, the record step and the staging. When it sends you back to work, its reason arrives as a new prompt. A newly recorded verification can request one chat reply even after an earlier stop asked for a fix.

Reports:
- Run triage in a separate tool call. If it refuses, follow the refusal. If it records a triage, end the turn before editing.
- Start that final reply with **Triage recorded** on its own line, so it stays visible when work details are collapsed. Then copy the summary it prints verbatim into a plain-text code block, its link included. The lines after the link are for you. If the output was truncated, read the run's saved output.
- Unless a revision is pending, the Stop hook then asks you to resume. The referee records \`convergence_requested\` for that triage reply. Continue the approved work or request a revision before asking for Plan mode.
- When Stop asks you to post a verification summary, copy it verbatim, through its \`Details:\` line, into your chat reply. The reply is what delivers it, in the CLI and the desktop app.
- After \`workflow checks-analysis\` accepts an analysis, post the summary it prints verbatim. Never paste the full analysis.

${PRESENTING}

Harness support skills, to use where they fit:
${skills.map(({ name, description }) => `- \`${name}\`: ${description}`).join('\n')}

Codex's own settings:
- Locked by the rulebook's \`agent.lockedPaths\`: \`.codex/\`, \`~/.codex/config.toml\`, \`~/.codex/hooks.json\` and \`~/.codex/sessions/\`, so a session cannot switch off its hooks or rewrite the transcript a plan is approved from.
- Not lockable, and warned about on every turn by the adapter's check: a workflow hook missing, disabled or not trusted in \`/hooks\`; \`[features] hooks = false\`, which turns every hook off; \`allow_managed_hooks_only\`, which skips this repository's hooks; a hook from another layer (user, plugin, managed) that is not the workflow's; this file missing, or longer than Codex's \`project_doc_max_bytes\`.
- The prompt hook warns when Codex runs with approvals off (\`permission_mode\` is \`bypassPermissions\`, as \`codex exec\` sends).
- Pass every such warning on to the operator.
`;

/**
 * Codex's words for a skill, by name, added at the end of the prompt. A skill
 * not listed is installed as the referee wrote it.
 */
export const SKILL_WORDS = {
  'plan-change': `## In Codex

Before asking the operator to switch to Plan mode, if the current checkout is not on a working branch based on the configured baseline, create and switch to a new branch from that baseline.

${PRESENTING}
`,
};

/** A frontmatter value, quoted only when YAML would read it as something else. */
const yamlValue = (text) => (/^[\w(][^\n]*$/.test(text) && !/: |\s#/.test(text) ? text : JSON.stringify(text));

/**
 * The files to write, `{ path, text }` each, paths from the project root,
 * with `shared: true` on the one the project's own text shares.
 *
 * @param {{ instructions: string, skills: { name: string, description: string, prompt: string }[] }} request
 */
export function installFiles({ instructions, skills }) {
  return [
    // Shared: the project's own instructions live in this file too, so `init`
    // adds the workflow's part to one that exists instead of skipping it.
    { path: INSTRUCTIONS_FILE, text: `${instructions.trimEnd()}\n\n${codexSection(skills)}`, shared: true },
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
