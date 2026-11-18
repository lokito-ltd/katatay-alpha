/**
 * Boundaries, checked by dependency-cruiser (`npm run boundaries`).
 *
 * These rules fail when the workflow's referee reaches a language tool or an
 * agent adapter, and when an agent adapter's hooks reach the referee.
 *
 * `dependency-cruiser.test.ts` proves that each rule still fires. That test is
 * the guard against the silent failure described under `options.parser`, so
 * an edit here goes with an edit there. The `highRisk` list of
 * `.katatay/rulebook.json` names both files (see `highRiskAreas` in
 * `src/workflow/rulebook.mjs`), because loosening a rule is the easiest way to
 * make this check pass.
 */

module.exports = {
  forbidden: [
    {
      name: 'referee-is-language-free',
      comment:
        'The referee under src/ (workflow, evidence, requirements) runs the same for every language. It asks the ' +
        'language through the commands named in .katatay/rulebook.json, never by importing the compiler, the test ' +
        'runner or the TypeScript adapter. See src/adapters/README.md. Checked through other files too, so a ' +
        'helper cannot bring them in. Tests and test support are not the referee.',
      severity: 'error',
      from: {
        path: '^src/(workflow|evidence|requirements)/',
        pathNot: [
          '\\.test\\.[cm]?[jt]sx?$',
        ],
      },
      to: {
        path: [
          '^(node_modules/)?(typescript|typescript-api|vitest|@vitest/[^/]+|@stryker-mutator/[^/]+)(/|$)',
          '^src/adapters/',
        ],
        reachable: true,
      },
    },
    {
      name: 'referee-is-agent-free',
      comment:
        'The referee under src/ (workflow, evidence, requirements) runs the same for every agent. It asks the ' +
        'agent adapter through the commands named in .katatay/rulebook.json (agent.adapters.<name>.checkCommand), never by importing ' +
        'anything under src/agents/. See src/agents/README.md. Checked through other files too, so a helper ' +
        'cannot bring it in. Tests and test support are not the referee: the machine suite drives the Claude hooks.',
      severity: 'error',
      from: {
        path: '^src/(workflow|evidence|requirements)/',
        pathNot: [
          '\\.test\\.[cm]?[jt]sx?$',
        ],
      },
      to: { path: '^src/agents/', reachable: true },
    },
    {
      name: 'hooks-talk-through-commands',
      comment:
        'The agent adapters\' hooks, for Claude Code and for Codex, hold no workflow rules. Each translates what its ' +
        'agent sends into the input of a referee command (`workflow.mjs on <moment>`), starts it through ' +
        'hooks/referee.mjs, and translates the answer back. A hook that imported the referee would put the rules back ' +
        'in the adapter, where every other agent would have to copy them. Checked through other files too, so a ' +
        'helper cannot bring the referee in. See src/agents/README.md.',
      severity: 'error',
      from: {
        path: '^src/agents/(claude|codex)/hooks/',
        pathNot: ['\\.test\\.[cm]?[jt]sx?$'],
      },
      to: {
        path: '^src/(workflow|evidence|requirements)/',
        reachable: true,
      },
    },
  ],
  options: {
    // dependency-cruiser reads TypeScript with the TypeScript compiler's
    // JavaScript API, and supports TypeScript below 7 only. This repository
    // runs TypeScript 7, which has no such API. swc (`@swc/core`) parses the
    // same files.
    //
    // Without a working parser dependency-cruiser does not fail. It skips
    // every .ts file, reports "0 modules cruised", prints a warning and exits
    // 0, so the check would pass whatever the code imports. That is why
    // `dependency-cruiser.test.ts` exists.
    parser: 'swc',
    tsConfig: { fileName: 'tsconfig.json' },
    // A package's own imports are its business, and following them would cost
    // a minute per run. The package itself is still seen, which is all the
    // rules that name a package need.
    doNotFollow: { path: '^node_modules/' },
    // Generated output, data and the workflow logbook: none of it is source.
    // `.stryker-tmp` holds mutation testing's sandboxes, each a copy of the
    // repository with its `node_modules`, whose type files the parser cannot
    // read. One is on disk while a run is going, and after a run that was
    // stopped, and either made `npm run boundaries` fail.
    //
    // `node_modules` is left out on purpose. An excluded file is not in the
    // graph at all, so the referee importing `vitest` would have nothing to be
    // refused for. `doNotFollow` above keeps each package in the graph
    // without reading what is inside it.
    exclude: { path: '^(coverage|dist|\\.git|\\.katatay|\\.stryker-tmp)/' },
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'] },
  },
};
