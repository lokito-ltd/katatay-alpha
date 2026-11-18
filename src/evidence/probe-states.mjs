/**
 * The breaks `init --probe --expect <state>` can be asked to see, in the
 * order the probe reaches them. Its own file, in plain JavaScript, because
 * both `init`'s command and the probe read it, and `init` cannot load the
 * probe's TypeScript.
 */
export const PROBE_STATES = ['compile-error-in-code', 'compile-error-in-test', 'failing-test', 'below-minimum', 'survivors'];
