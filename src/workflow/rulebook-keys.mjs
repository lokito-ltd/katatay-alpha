/** Check field names independently of the section readers. Those decide which
 * values are required, and when; a typo is never a setting we can ignore. */
const fields = (...names) => Object.fromEntries(names.map(name => [name, null]));
const entries = schema => (value, at, visit) => {
  if (object(value)) for (const [key, entry] of Object.entries(value)) visit(entry, schema(key), at + '.' + key);
};
const list = schema => (value, at, visit) => {
  if (Array.isArray(value)) value.forEach((entry, i) => visit(entry, schema, at + '[' + i + ']'));
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const common = fields('command', 'runs', 'onFailure', 'timeLimitSeconds', 'suppressions', 'skipInCi');
const check = { ...common, ...fields('exitCodes', 'output') };
const coverage = { ...common, output: null, minimum: entries(() => fields('lines', 'branches')) };
const mutation = { ...common, ...fields('output', 'excludePaths') };
const testQuality = entries(name => name === 'mutation' ? mutation : name === 'coverage' ? coverage : check);
const extraHooks = { check: null, acknowledged: list(fields('event', 'matcher', 'command')) };
const rulebook = {
  version: null, targetBranch: null,
  tests: { paths: fields('all', 'acceptance', 'slow', 'support'), run: fields('command', 'reportPaths', 'tagComment') },
  code: { paths: null, compile: fields('command', 'pattern', 'exitCodes') },
  agent: { lockedPaths: null, adapters: entries(() => ({ checkCommand: null, extraHooks })) },
  plans: fields('dir', 'validateFormat'), followUpsFile: null, highRisk: list(fields('paths', 'why')),
  checks: { testQuality, codeQuality: entries(() => check), requireAnalysis: null },
  requirementsDir: null,
};

export function checkRulebookKeys(config, refuse) {
  function visit(value, schema, at) {
    if (typeof schema === 'function') return schema(value, at, visit);
    if (!schema || !object(value)) return;
    for (const key of Object.keys(value)) {
      const path = at ? at + '.' + key : key;
      if (!Object.hasOwn(schema, key)) throw refuse(`unknown "${path}". Allowed keys: ${Object.keys(schema).join(', ')}`);
      visit(value[key], schema[key], path);
    }
  }
  visit(config, rulebook, '');
}
