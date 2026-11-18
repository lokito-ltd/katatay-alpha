/**
 * Globs, as the rulebook writes them: which files are tests, which are
 * high-risk, which mutation leaves alone.
 *
 * The path rules are matched by `globToRegExp` below rather than a library.
 * The hooks import these modules through `frozen.mjs`, and the hooks import
 * nothing from `node_modules`: they run as bare node processes against whatever
 * tree they are spawned in, before every tool call. They sit in a
 * file of their own so that `rulebook.mjs`, which checks every glob in the
 * rulebook, and `adapter.mjs`, which reads the language's, can both use them
 * without importing each other.
 */

/**
 * A glob as an anchored regular expression.
 *
 * `**` is any number of whole path segments, zero included, so `**\/x` matches
 * `x` at the root. `*` is anything within one segment, `?` one character,
 * `{a,b}` either. Dot files match like any other: `**\/*.ts` names
 * `.claude/x.ts` too, because a rule about which files are tests must not
 * depend on a folder's name.
 *
 * `**` must be a whole segment. `a**` would mean something different in every
 * glob library, so it is refused rather than given one of those meanings.
 *
 * @param {string} glob
 */
export function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob === '') throw new Error('a glob must be a non-empty string');
  let source = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const startsSegment = i === 0 || glob[i - 1] === '/';
      const next = glob[i + 2];
      if (!startsSegment || (next !== undefined && next !== '/')) {
        throw new Error(`"**" must be a whole path segment, in ${JSON.stringify(glob)}`);
      }
      if (next === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else if (c === '{') {
      depth += 1;
      source += '(?:';
    } else if (c === '}') {
      if (depth === 0) throw new Error(`an unmatched "}" in ${JSON.stringify(glob)}`);
      depth -= 1;
      source += ')';
    } else if (c === ',' && depth > 0) {
      source += '|';
    } else {
      source += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  if (depth !== 0) throw new Error(`an unmatched "{" in ${JSON.stringify(glob)}`);
  return new RegExp(`^${source}$`);
}

/** A predicate saying whether any of these globs matches a path.
 *  @param {string[]} globs */
export function matcher(globs) {
  const patterns = globs.map(globToRegExp);
  return (file) => patterns.some((pattern) => pattern.test(file));
}

/** Whether a value is a list of non-empty strings, optionally allowed to be
 *  empty. Says nothing yet about whether each compiles as a glob. */
export const isGlobList = (value, { empty }) =>
  Array.isArray(value) && (empty || value.length > 0) && value.every((glob) => typeof glob === 'string' && glob !== '');
