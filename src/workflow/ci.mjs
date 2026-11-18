/**
 * Whether the referee runs as a CI job, decided in one place.
 *
 * Only `CI=true` is CI. `CI` unset, empty or `false` is local, and so is any
 * other value, such as `1` or `TRUE`. The common CI services set `CI=true` on
 * every job, and a script that stands in for a pipeline can set the same.
 *
 * The rule is exact because CI changes what the tools do in both directions.
 * `req:guard` stops failing on a reworded requirement and prints it for a
 * reviewer, the checks fetch the target first, and a check whose rulebook
 * entry says `skipInCi` does not run. A value someone typed by mistake, such
 * as `CI=false`, must never switch those on. The guard and the fetch used to
 * take any value at all, so `CI=false` counted as CI there. With a second,
 * stricter reading for `skipInCi`, one verify would have had two answers.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export const inCi = (env = process.env) => env.CI === 'true';
