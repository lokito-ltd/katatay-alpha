import { sha256 } from './chain.mjs';
import { approvedPlans, readSnapshot } from './local-snapshot.mjs';
import { readPlan } from './plan.mjs';

export class PlanEvidenceError extends Error {}

/** Only commands that need predictions require the approved snapshot’s local bytes. */
export function approvedPredictions(branch, grant, root = process.cwd()) {
  const { payload } = grant;
  const reference = payload.planSnapshot;
  try {
    const bytes = readSnapshot(branch, approvedPlans, reference, root);
    if (sha256(bytes) !== payload.proposal) throw new Error('snapshot differs from the approved plan hash');
    const plan = readPlan(bytes.toString('utf8'));
    if (plan.problems.length) throw new Error(plan.problems.join('. '));
    return plan.predictedFailures;
  } catch (error) {
    throw new PlanEvidenceError(`approval ${grant.seq} ${reference}: ${error.message}. Restore the exact approved snapshot at the recorded path and retry.`);
  }
}
