/**
 * What Cursor actually sent and wrote, for the tests.
 *
 * Every file beside this one was captured from a live session (see
 * `README.md`). Only machine-specific values were replaced afterwards, with
 * the placeholders below, and the transcripts and one answer were cut to what
 * matters. Field names, nesting and the fields nothing reads are as they
 * arrived.
 *
 * That is the point. Payloads written by hand agree with the hooks because the
 * same person wrote both. The Claude adapter's approval hook once searched for
 * wording no version of Claude Code had ever sent, and its hand-written test
 * payload contained that wording, so the suite stayed green while nothing was
 * recorded. A fixture cannot make that mistake, because nobody chose what is in
 * it.
 *
 * A fixture is a copy of the past, so it cannot notice Cursor changing. The
 * hooks warn at runtime when a field they read is missing, and that warning in
 * a live session is the signal to recapture.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Fills in the placeholders. The tests run against a temporary repository
 * with `HOME` pointed somewhere else, so substitution happens on the way out
 * rather than in the file, and what sits on disk stays a faithful copy.
 */
const substitute = (value, into) => {
  if (typeof value === 'string') {
    return value
      .replaceAll('{{HOME}}', into.home)
      .replaceAll('{{REPO}}', into.repo);
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, into));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, into)]));
  }
  return value;
};

/**
 * Overrides merge one level into nested objects, so a test can say
 * `{ tool_input: { command } }` without restating the rest of `tool_input`.
 * Deeper than that, the override wins whole.
 */
const merge = (base, overrides) => {
  const out = { ...base };
  const mergeable = (value) => value && typeof value === 'object' && !Array.isArray(value);
  for (const [key, value] of Object.entries(overrides)) {
    const existing = out[key];
    out[key] = mergeable(existing) && mergeable(value) ? { ...existing, ...value } : value;
  }
  return out;
};

/**
 * A hook payload.
 *
 * @param {string} name fixture file name, without `.json`
 * @param {object} overrides the values this test is actually about
 * @param {{ home: string, repo: string }} paths
 */
export function payload(name, overrides = {}, paths) {
  const captured = JSON.parse(readFileSync(join(HERE, `${name}.json`), 'utf8'));
  return merge(substitute(captured, paths), overrides);
}

/**
 * A transcript, as the text of the file Cursor writes, with the placeholders
 * filled in.
 *
 * Cursor writes a transcript as JSON lines. The fixture keeps the same entries
 * as a JSON array, one entry per line, because coverage measures every file
 * under `tools/` except JSON, CSS, SQL and Markdown (see
 * `vitest.config.test.ts`), and would try to read a `.jsonl` file as code.
 * The lines are written back here, in order.
 *
 * @param {string} name fixture file name, without `.json`
 * @param {{ home: string, repo: string }} paths
 */
export function transcript(name, paths) {
  const entries = JSON.parse(readFileSync(join(HERE, `${name}.json`), 'utf8'));
  return `${entries.map((entry) => JSON.stringify(substitute(entry, paths))).join('\n')}\n`;
}

/** Every hook payload, by the name `payload` takes. */
export const PAYLOADS = [
  'pre-tool-use-write',
  'pre-tool-use-delete',
  'pre-tool-use-shell',
  'before-submit-prompt',
  'before-submit-prompt-plan-mode',
  'before-submit-prompt-build',
  'before-submit-prompt-followup',
  'stop',
  'stop-after-followup',
];

/** The Claude Code hooks' payloads, as Cursor sent them to the hooks in `.claude/settings.json`. */
export const CLAUDE_PAYLOADS = ['claude-pre-tool-use', 'claude-post-tool-use', 'claude-user-prompt-submit', 'claude-stop'];

/** Every transcript, by the name `transcript` takes. */
export const TRANSCRIPTS = ['transcript-build'];

/** The plan Cursor saved for the Build in `transcript-build`, as the file's text. */
export const savedPlan = () => readFileSync(join(HERE, 'saved-plan.plan.md'), 'utf8');
