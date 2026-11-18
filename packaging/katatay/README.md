# Katatay

> **Alpha.** This is an alpha release, built to test the concept. Expect rough edges and breaking changes between releases. Read [Known limits](https://github.com/lokito-ltd/katatay-alpha#known-limits) before you rely on it.

Katatay checks changes against a project's requirements, tests and rulebook. It runs on Node.js 22.12 or later and uses Git.

From the source checkout, run `npm ci` and `npm run pack:katatay`. Install the resulting archive in your user-owned global npm prefix, with its bin directory on PATH for your shell and both agents:

```sh
archive="$PWD/dist/katatay-0.1.0.tgz"
npm install -g --foreground-scripts --allow-scripts="file:$archive" "$archive"
ktty version
```

The version command prints the Katatay release and the rulebook schema. `ktty path` prints the absolute folder the package is installed in, so a project can name the TypeScript adapter's files, such as `"$(ktty path)/src/adapters/typescript/vitest-junit-reporter.js"`. The global install script puts the setup skill in the Claude Code and Codex user skill directories. It respects CLAUDE_CONFIG_DIR and CODEX_HOME. If a different ktty-init skill already exists, the installer reports its location and preserves the file.

Open a new Claude Code or Codex session in the Git project and ask it to use the **ktty-init** skill to set up Katatay. It interviews you about your tools, proves the checks with passing and failing examples, then runs `ktty init` and shows the operator steps, including hook trust. For manual setup, run `ktty init` in a terminal or use `ktty init --questions` to see the available settings.

After setup, run `ktty verify` in the project. To use the project in a new checkout or on another machine, install the same tarball there and make ktty available on PATH to the agents.

The installed [rulebook schema](src/schemas/rulebook.schema.json),
[approval event schema](src/schemas/plan-approved.schema.json),
[triage event schema](src/schemas/triaged.schema.json),
[triage refusal event schema](src/schemas/triage-refused.schema.json),
[verification event schema](src/schemas/verified.schema.json),
[failed verification event schema](src/schemas/verify-failed.schema.json),
[checks analysis event schema](src/schemas/checks-analysis.schema.json),
[baseline move schema](src/schemas/baseline-moved.schema.json),
[record hold schema](src/schemas/record-held.schema.json),
[declaration schema](src/schemas/declared.schema.json),
[recorded event schema](src/schemas/recorded.schema.json),
[reset event schema](src/schemas/reset.schema.json),
[saved change report schema](src/schemas/change-report.schema.json),
[check result schema](src/schemas/check-result.schema.json),
[requirement frontmatter schema](src/schemas/requirement.schema.json),
[change file frontmatter schema](src/schemas/change-file.schema.json) and
[agent message schemas](src/schemas/hooks.schema.json) are under the
folder printed by `ktty path`. Select the named request or answer for the
hook you call. References resolve locally, including the agent contract.
