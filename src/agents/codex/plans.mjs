/** Capture a presented plan without interpreting its contents. */
import { newPlanFile, plansDir } from './approval.mjs';
import { planInTurn } from './transcript.mjs';

/** Save exactly the completed Plan text. No template or YAML decisions here. */
export function capturePlan({ transcriptPath, turnId, lastAssistantMessage, root, home }, world) {
  if (typeof turnId !== 'string' || !turnId || typeof transcriptPath !== 'string' || !transcriptPath) {
    return { problem: 'Codex sent no transcript_path or turn_id, so the presented plan could not be checked.' };
  }
  let plan;
  try {
    plan = planInTurn(world.read(transcriptPath), turnId);
    // A null final message is the only captured hint of a Plan turn. Give
    // its completed item time to reach disk, without delaying ordinary turns.
    // The count also bounds injected waits that deliberately take no time.
    if (plan === null && lastAssistantMessage === null && world.wait) {
      const deadline = Date.now() + 1500;
      for (let attempt = 0; attempt < 15 && plan === null; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        world.wait(Math.min(100, remaining));
        plan = planInTurn(world.read(transcriptPath), turnId);
      }
      if (plan === null) {
        return { problem: 'This turn may have presented a plan that could not be read, so it was not checked.' };
      }
    }
  } catch (error) {
    return { problem: `The transcript ${transcriptPath} could not be read (${error.code ?? error.message}); the presented plan could not be checked.` };
  }
  if (plan === null) return { planFile: null };
  const where = plansDir(root, home);
  if (where.problem) return { problem: `The presented plan could not be saved: ${where.problem}.` };
  let file;
  try {
    world.makeFolder(where.folder);
    file = newPlanFile(where.folder, world.exists === undefined ? {} : { exists: world.exists });
    world.write(file, plan);
  } catch (error) {
    return { problem: `The presented plan could not be written to ${file ?? where.folder} (${error.code ?? error.message}).` };
  }
  return { planFile: file };
}
