/** Only structured completed Plan items identify a plan. Stop additionally
 * requires the turn ID; approval searches the current chat across turns. */
export function* completedPlans(transcript) {
  for (const line of transcript.split('\n')) {
    if (!line.includes('"Plan"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry?.payload;
    if (entry?.type === 'event_msg' && payload?.type === 'item_completed' && payload.item?.type === 'Plan') yield payload;
  }
}

export function planInTurn(transcript, turnId) {
  if (typeof turnId !== 'string' || !turnId) return null;
  let plan = null;
  for (const payload of completedPlans(transcript)) {
    if ((payload.turn_id ?? payload.internal_chat_message_metadata_passthrough?.turn_id) === turnId) {
      plan = typeof payload.item.text === 'string' ? payload.item.text : null;
    }
  }
  return plan;
}
