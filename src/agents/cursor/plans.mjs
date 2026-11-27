/**
 * Capturing a plan presented in the current turn, for the referee's courtesy
 * check at the turn end. Nothing here interprets the plan: the text the agent
 * gave `CreatePlan` is saved as it is.
 */
import { savePlan } from './approval.mjs';
import { planInTurn } from './transcript.mjs';

/**
 * `{ planFile }`, null when the turn presented no plan, or `{ problem }` for
 * the operator.
 *
 * @param {{ transcriptPath: unknown, root: string, home?: string }} where
 * @param {{ read: (path: string) => string, write: (path: string, text: string) => void,
 *   makeFolder: (path: string) => void, exists?: (path: string) => boolean }} world
 */
export function capturePlan({ transcriptPath, root, home }, world) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') {
    return { problem: 'Cursor sent no transcript_path, so a plan presented in this turn could not be checked.' };
  }
  let plan;
  try {
    plan = planInTurn(world.read(transcriptPath));
  } catch (error) {
    return { problem: `The transcript ${transcriptPath} could not be read (${error.code ?? error.message}); a plan presented in this turn could not be checked.` };
  }
  if (plan === null || plan.trim() === '') return { planFile: null };
  const written = savePlan(plan, root, home, world);
  if ('problem' in written) return { problem: `The presented plan could not be checked: ${written.problem}.` };
  return { planFile: written.file };
}
