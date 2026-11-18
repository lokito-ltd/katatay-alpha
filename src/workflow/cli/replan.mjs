import { fileURLToPath } from 'node:url';
import { append } from '../chain.mjs';
import { command } from '../commands.mjs';
import { RECORDED_PLAN_GUIDANCE, REPLAN_PENDING } from '../phase.mjs';
import { current } from '../state.mjs';

export function replan(args) {
  const resume = args.length === 1 && args[0] === '--resume';
  if (args.length && !resume) throw new Error(`Usage: ${command('replan')} [--resume].`);
  const state = current();
  if (state.broken) throw new Error(state.broken);
  if (state.live.some(e => e.event === 'recorded')) {
    throw new Error('This branch already holds a recorded change. ' + RECORDED_PLAN_GUIDANCE);
  }
  if (resume && state.replan) {
    append(state.dir, 'replan_resumed', { request: state.replan.seq }, state.branch, state.entries.length);
    return 'The operator chose the original plan. Continue in ' + state.phase + '.';
  }
  if (state.phase !== 'implementing' && state.phase !== 'converging') {
    throw new Error(`A revision request needs an implementing or converging change. This change is ${state.phase}.`);
  }
  if (resume) return 'There is no pending revision to resume from.';
  if (!state.replan) append(state.dir, 'replan_requested', { approval: state.grant.seq }, state.branch, state.entries.length);
  return REPLAN_PENDING;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(replan(process.argv.slice(2)));
  } catch (error) {
    console.error('For the operator: ' + error.message);
    process.exitCode = 2;
  }
}
