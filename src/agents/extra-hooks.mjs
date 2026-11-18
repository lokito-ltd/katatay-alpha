const acknowledgement = "extraHooks.acknowledged in this adapter's agent.adapters entry in .katatay/rulebook.json";
const outsideGate = "It runs outside the workflow's gate.";
const onMatcher = (matcher) => matcher === '' ? '' : ` on ${matcher}`;

/** The adapter has already checked ownership, acknowledgements and approval risk
 *  for each registration. Only their presentation is shared. */
export function extraHookWarnings(registrations, approvalRisk) {
  const warnings = [];
  const groups = Map.groupBy(registrations, ({ file, layer, command }) => JSON.stringify([file, layer, command]));
  for (const group of groups.values()) {
    const { file, layer, command } = group[0];
    const source = layer ? `${file} (${layer})` : file;
    const distinct = Map.groupBy(group, ({ event, matcher }) => JSON.stringify([event, matcher]));
    const hooks = Array.from(distinct.values(), ([first]) => first);
    if (hooks.length === 1) {
      const [{ event, matcher, affectsApproval }] = hooks;
      warnings.push(`${source} registers an extra ${event} hook${onMatcher(matcher)}: \`${command}\`. `
        + `${affectsApproval ? approvalRisk : outsideGate} If it is the operator's, they list it under ${acknowledgement}.`);
      continue;
    }

    const names = (items) => items.map(({ event, matcher }) => `${event}${onMatcher(matcher)}`).join(', ');
    const approval = hooks.filter((hook) => hook.affectsApproval);
    const other = hooks.filter((hook) => !hook.affectsApproval);
    const lines = [`${source} has ${hooks.length} extra hook registrations for \`${command}\`:`];
    if (approval.length) lines.push(`  - Can affect plan approval: ${names(approval)}.`);
    if (other.length) lines.push(`  - Outside the workflow's gate: ${names(other)}.`);
    if (approval.length) lines.push(approvalRisk);
    lines.push(`If you trust these registrations, list each event, matcher and command under ${acknowledgement}.`);
    warnings.push(lines.join('\n'));
  }
  return warnings;
}
