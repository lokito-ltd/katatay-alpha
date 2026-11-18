/** What verify and the turn-end message share about mutation runs. */

/** Seconds reserved for reporting when verify runs under a hook deadline. */
export const MARGIN = 20;

/** Whether the run leaves part of the mutation measurement unproven.
 * Shared by the receipt's summary and the detailed checks report. */
export function mutationIncomplete(outcome, findings) {
  const { counts } = findings;
  return Boolean(findings.partial || outcome === 'nothing' || counts.unproven || counts.statuses.Pending
    || counts.statuses.NoCoverage || counts.statuses.RuntimeError || counts.statuses.CompileError);
}

export function mutationReason(outcome, { counts }) {
  return `${outcome === 'nothing' ? 'inconclusive: ' : ''}${counts.total} mutant${counts.total === 1 ? '' : 's'}, ${counts.caught} caught, ${counts.survived} survived`;
}
