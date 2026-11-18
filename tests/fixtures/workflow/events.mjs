import { sha256 } from '../../../src/workflow/chain.mjs';
import { approvedPlans, publishSnapshot } from '../../../src/workflow/local-snapshot.mjs';

/** Valid evidence for exercising the chain without running an entire change. */
export const treeFingerprint = 'a'.repeat(64);
export const verificationInputs = { baseline: 'b'.repeat(40), rulebookFingerprint: 'c'.repeat(64) };
export const approval = (over = {}) => ({ proposal: treeFingerprint,
  testOnly: false, requirementChanges: [], planSnapshot: '.katatay/local/feat_x/plans/20261103T120000.000Z_' + 'A'.repeat(43) + '.md', baseline: verificationInputs.baseline, ...over });
export const triageAnalysis = snapshot => ({ role: 'analysis', title: 'Triage analysis', snapshot });
export const analysisPath = payload => payload.evidence.find(item => item.role === 'analysis').snapshot;
export const triaged = (over = {}) => ({
  treeFingerprint, implementationFingerprint: treeFingerprint, level: 'LOW', reasons: [], predicted: { failed: 0, total: 0 }, surprise: { failed: 0, total: 0 },
  overPredicted: { count: 0, total: 0 }, notRun: { predicted: 0, unpredicted: 0 },
  evidence: [triageAnalysis('.katatay/local/feat_x/triage/20261103T120000.000Z_' + 'A'.repeat(43) + '.json')],
  testCount: 0, implemented: true, ...over,
});
export const skippedChecks = () => ['tests', 'coverage', 'mutation']
  .map(name => ({ name, status: 'skipped', reason: 'Not measured.', evidence: [], summary: {} }));
export const verified = (over = {}) => ({ ...verificationInputs, treeFingerprint, implementationFingerprint: '1'.repeat(64),
  testFingerprint: '2'.repeat(64), results: skippedChecks(), ...over });
export const recorded = { treeFingerprint, changes: treeFingerprint, files: ['requirements/changes/change.md'] };

export function snapshotGrant(branch, markdown, root) {
  const bytes = Buffer.from(markdown);
  return { seq: 1, payload: approval({ proposal: sha256(bytes),
    planSnapshot: publishSnapshot(branch, approvedPlans, bytes, root) }) };
}
