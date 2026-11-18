import { agentActions } from '../agents/programs.mjs';
import { ROUTES } from '../workflow/cli/workflow.mjs';

const descriptions = {
  help: 'List the available commands.',
  version: 'Print the Katatay release and harness schema version.',
  path: 'Print the folder containing Katatay and its adapters.',
  verify: 'Run the checks used by CI.',
  'verify --rerun': 'Run verification again and record the result.',
  triage: 'Run the suite and compare failures with the plan.',
  replan: 'Request a revised plan, or use --resume to continue the approved plan.',
  'state show': 'Show the current phase and next step.',
  'state verify': 'Check the logbook against Git and report agent settings warnings.',
  areas: 'List the changed files that need review.',
  coverage: 'Measure coverage against the configured minimums.',
  mutate: 'Run mutation tests on changed lines.',
  defaults: 'Show an agent adapter’s default settings.',
  init: 'Set up Katatay in a project.',
  'checks-analysis': 'Submit the analysis for a verification sequence on stdin.',
  report: 'Show the recorded change summary or a preview.',
  'req lint': 'Check the structure of the requirements catalogue.',
  'req guard': 'Check requirement changes against approvals and change files.',
  'req trace': 'Check that every active scenario has acceptance evidence.',
  'req risk': 'Report missed predictions and test regressions.',
  'req renumber': 'Move a requirement to another ID and update its references.',
  'on write': 'Check whether a proposed write is allowed.',
  'on prompt': 'Process an operator prompt and report the current state.',
  'on plan-approved': 'Record the plan approved by the operator.',
  'on plan-presented': 'Check the format of a presented plan.',
  'on turn-end': 'Run the workflow steps due at the end of a turn.',
};

const actionDescriptions = {
  defaults: 'Print the adapter defaults.',
  install: 'Install the adapter in the project.',
  check: 'Check the adapter settings and report warnings.',
  'pre-tool': 'Check a tool request before it runs.',
  'post-tool': 'Process a completed tool call.',
  'user-prompt': 'Process an operator prompt.',
  'turn-end': 'Handle the end of an agent turn.',
};

export function helpText() {
  const names = new Set(['version', 'help', 'path', ...Object.keys(ROUTES)]);
  const lines = ['Usage: ktty <command> [arguments]', '', 'Commands:'];
  for (const name of names) {
    lines.push(`  ${name.padEnd(24)}  ${descriptions[name]}`);
  }
  for (const pair of agentActions()) {
    const [, action] = pair.split(' ');
    lines.push(`  ${('agent ' + pair).padEnd(24)}  ${actionDescriptions[action]}`);
  }
  return lines.join('\n');
}
