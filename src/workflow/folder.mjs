/**
 * The referee's folder in a project: the rulebook, the logbook under `state/`,
 * and the local snapshots under `local/`. Every referee path into it starts
 * from this name, so the folder can be renamed in one place.
 *
 * The agent adapters' hooks may not import the referee
 * (`hooks-talk-through-commands` in `.dependency-cruiser.cjs`), so the few
 * adapter files that name the rulebook spell the folder out themselves.
 */
export const STATE_FOLDER = '.katatay';

/** The folder's name escaped for a regular expression. */
export const STATE_FOLDER_PATTERN = STATE_FOLDER.replace(/\./g, '\\.');
