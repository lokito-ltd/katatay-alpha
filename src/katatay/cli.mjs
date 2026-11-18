#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packaged } from '../distribution.mjs';
import { releaseVersion } from './release.mjs';
import { helpText } from './help.mjs';
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import { agentScript } from '../agents/programs.mjs';
import { argumentProblem } from './arguments.mjs';
import { routeName, ROUTES } from '../workflow/cli/workflow.mjs';
import { runReferee } from '../workflow/runtime.mjs';

const [verb, ...args] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '../..');

function dispatch() {
  if (verb === undefined) return invalid('No command supplied.');
  if (['version', 'path', 'help'].includes(verb) && args.length > 0) {
    return invalid(`The '${verb}' command takes no arguments. Run 'ktty ${verb}'.`);
  }
  if (verb === 'help') {
    console.log(helpText());
    return 0;
  }
  if (verb === 'version') {
    console.log(`Katatay ${releaseVersion(root, packaged)}\nSchema ${HARNESS_SCHEMA_VERSION}`);
    return 0;
  }
  if (verb === 'path') {
    // The installed package's root, so a project's scripts and configs can
    // name the adapter's files in it.
    console.log(root);
    return 0;
  }
  if (verb === 'agent') {
    const script = agentScript(args[0], args[1]);
    if (!script || args.length !== 2) return invalid('Usage: ktty agent <adapter> <action>.');
    return launch(fileURLToPath(new URL(`../../${script}`, import.meta.url)), []);
  }

  const argv = [verb, ...args];
  const name = routeName(argv);
  if (!name) {
    const attempted = ['req', 'state', 'on'].includes(verb) ? [verb, ...args.slice(0, 1)].join(' ') : verb;
    const printable = attempted.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
    return invalid(`Unknown command '${printable}'.`);
  }
  const remaining = argv.slice(name.split(' ').length);
  const problem = argumentProblem(name, remaining);
  if (problem) return invalid(problem);
  if (verb === 'init') {
    // The npm source launcher needs INIT_CWD. A binary invoked through PATH
    // always acts on its caller's actual directory, even inside an npm script.
    delete process.env.INIT_CWD;
    remaining.unshift('--agent', 'claude=ktty agent claude defaults', '--agent', 'codex=ktty agent codex defaults');
  }
  return launch(ROUTES[name], remaining);
}

function invalid(message) {
  console.error(`${message}\nRun 'ktty help' for usage.`);
  return 2;
}

function launch(file, argv) {
  const result = runReferee(file, argv, { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

process.exitCode = dispatch();
