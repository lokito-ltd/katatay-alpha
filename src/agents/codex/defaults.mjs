#!/usr/bin/env node
/**
 * The agent defaults: what `init` should propose for Codex, as JSON.
 *
 * `init` runs where no rulebook exists yet, so it cannot find this command
 * there. It is told which adapter to use and starts this command itself (see
 * `src/agents/README.md`).
 *
 * In:  `{ version }` on stdin. The command runs in the project root, so an
 *      adapter that needs the project reads its working directory.
 * Out: the proposal from `proposal.mjs`, with exit 0.
 *
 * A request that does not match is refused with exit 2 and a sentence on
 * stderr, as `check.mjs` refuses its own: it is a bug in the caller.
 */
import { proposal } from './proposal.mjs';
import { HARNESS_SCHEMA_VERSION as VERSION } from '../../schema-version.mjs';

const refuse = (why) => {
  process.stderr.write(`defaults: refused, ${why}.\n`);
  process.exit(2);
};

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let request;
try {
  request = JSON.parse(raw);
} catch (error) {
  refuse(`the request is not JSON (${error.message})`);
}
if (request === null || typeof request !== 'object' || Array.isArray(request)) refuse('the request is not a JSON object');
if (request.version !== VERSION) refuse(`\`version\` must be ${VERSION}, and is ${JSON.stringify(request.version) ?? 'missing'}`);

process.stdout.write(JSON.stringify(proposal()), () => process.exit(0));
