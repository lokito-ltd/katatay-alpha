/**
 * Plans in a Cursor conversation transcript.
 *
 * Cursor keeps each conversation as JSON lines under
 * `~/.cursor/projects/<project>/agent-transcripts/`, one `{ role, message }`
 * per line. A plan is proposed with the `CreatePlan` tool: an assistant line
 * whose `message.content` holds `{ type: 'tool_use', name: 'CreatePlan',
 * input: { name, overview, plan, todos } }`. No hook sees that tool call, so
 * the transcript is where a plan is found. Cursor documents no format for the
 * file, so a line that is not JSON is skipped rather than failing the read.
 *
 * Plain functions over the file's text, so tests run them in process.
 */

/** Each line's entry, in order, the ones that are not JSON objects left out. */
function* entries(transcript) {
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry !== null && typeof entry === 'object') yield entry;
  }
}

const contentOf = (entry) => (Array.isArray(entry?.message?.content) ? entry.message.content : []);

/** Whether an entry is a `CreatePlan` call, and its plan when it is: `{ name, plan }`. */
function createdPlans(entry) {
  if (entry.role !== 'assistant') return [];
  return contentOf(entry)
    .filter((part) => part?.type === 'tool_use' && part.name === 'CreatePlan')
    .map((part) => ({
      name: typeof part.input?.name === 'string' ? part.input.name : null,
      plan: typeof part.input?.plan === 'string' ? part.input.plan : null,
    }));
}

/**
 * The newest `CreatePlan` in the conversation, `{ name, plan }`, and how many
 * there are. A newer unusable plan is returned as it is, so it never lets an
 * older one through.
 *
 * @param {string} transcript the file's text
 * @returns {{ latest: { name: string|null, plan: string|null } | null, count: number }}
 */
export function latestPlan(transcript) {
  let latest = null;
  let count = 0;
  for (const entry of entries(transcript)) {
    for (const created of createdPlans(entry)) {
      latest = created;
      count += 1;
    }
  }
  return { latest, count };
}

/**
 * The plan text proposed in the current turn, or null when the turn proposed
 * none. The current turn is everything after the last user line: the
 * operator's prompt, or a follow-up the stop hook sent.
 *
 * @param {string} transcript the file's text
 */
export function planInTurn(transcript) {
  let plan = null;
  for (const entry of entries(transcript)) {
    if (entry.role === 'user') {
      plan = null;
      continue;
    }
    for (const created of createdPlans(entry)) plan = created.plan;
  }
  return plan;
}
