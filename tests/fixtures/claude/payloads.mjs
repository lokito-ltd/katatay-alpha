/**
 * Hook payloads as Claude Code actually sends them.
 *
 * Every file beside this one was captured from a live session by a temporary
 * hook that did nothing but write its stdin to disk. Only machine-specific
 * values were replaced afterwards, and only with the placeholders below. Field
 * names, nesting and the fields nothing reads are all exactly as they arrived.
 *
 * That is the point, and it is worth stating plainly because the tempting
 * shortcut looks identical from a distance. Payloads written by hand agree with
 * the hooks because the same person wrote both. The approval hook once searched
 * the tool response for wording that no version of Claude Code has ever sent;
 * its hand-written test payload contained that wording, so the suite stayed
 * green while plan mode recorded nothing at all, for the whole life of the
 * project up to 587b38e. A fixture cannot make that mistake, because nobody
 * chose what is in it.
 *
 * A fixture is a copy of the past, so it cannot notice Claude Code changing.
 * Nothing here tries to. The hooks warn at runtime when a field they read is
 * missing, and that warning in a live session is the signal to recapture.
 * `README.md` says how.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The placeholders. A captured payload is full of one machine's paths and one
 * session's ids, and the tests run against a temporary repository with `HOME`
 * pointed somewhere else. Substitution happens on the way out rather than in
 * the file, so what sits on disk stays a faithful copy.
 */
const substitute = (value, into) => {
  if (typeof value === 'string') {
    return value
      .replaceAll('{{HOME}}', into.home)
      .replaceAll('{{REPO}}', into.repo)
      .replaceAll('{{SCRATCHPAD}}', into.scratchpad);
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, into));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, into)]));
  }
  return value;
};

/**
 * Overrides merge one level into nested objects, so a test can say
 * `{ tool_input: { file_path } }` without restating the rest of `tool_input`.
 * Deeper than that, the override wins whole. No payload here nests further, and
 * a merge rule nobody can predict is worse than one that is occasionally blunt.
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
 * @param {string} name fixture file name, without the extension
 * @param {object} overrides the values this test is actually about
 * @param {{ home: string, repo: string, scratchpad?: string }} paths
 */
export function payload(name, overrides = {}, paths) {
  const captured = JSON.parse(readFileSync(join(HERE, `${name}.json`), 'utf8'));
  const into = {
    home: paths.home,
    repo: paths.repo,
    scratchpad: paths.scratchpad ?? join(paths.repo, '.scratchpad'),
  };
  return merge(substitute(captured, into), overrides);
}

/** Every fixture, by the name `payload` takes. */
export const FIXTURES = [
  'user-prompt-submit',
  'pre-tool-use-write',
  'pre-tool-use-bash',
  'post-tool-use-exit-plan-mode',
  'post-tool-use-exit-plan-mode-edited',
  'stop',
];
