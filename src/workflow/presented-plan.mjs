/** The courtesy shared by presentation hooks and the normal turn end. No state writes. */
import { homedir } from 'node:os';
import { readPlanFile } from './plan-file.mjs';
import { readPlan } from './plan.mjs';
import { parsePlanValidation, readConfig } from './rulebook.mjs';
import { templateProblems } from './plan-template.mjs';
import { planFormat } from './plan-format.mjs';
import { message } from './moments/messages.mjs';

export function checkPresentedPlan(planFile, { root = process.cwd(), home = homedir() } = {}) {
  try {
    const file = readPlanFile(planFile, root, home);
    if (file.problem) return {
      needsCorrection: false,
      messages: [message('warning', 'operator', `The presented plan could not be checked: ${file.problem}.`)],
    };
    const problems = readPlan(file.text).problems;
    if (parsePlanValidation(readConfig(root))) problems.push(...templateProblems(file.text));
    return {
      needsCorrection: problems.length > 0,
      messages: problems.length === 0 ? [] : [message('refused', 'agent', `The presented plan in ${file.path} has these problems:\n\n`
        + problems.map((problem) => `- ${problem}`).join('\n')
        + `\n\n${planFormat(file.folder)}\n\nCorrect these mistakes and present the complete plan again. No approval was recorded by this check.`)],
    };
  } catch (error) {
    // The caller still does its other work. Turn end retains its one-shot
    // correction; a pre-tool adapter can deliver a checker failure as a warning.
    return { checkFailed: true, needsCorrection: false, messages: [message('stop', 'operator', `The presented-plan check failed: ${error.message}`)] };
  }
}
