#!/usr/bin/env node
/**
 * `workflow verify --rerun`: verify now and record the result. See
 * `../rerun.mjs` for when it refuses and why.
 *
 * Prints every message, the ones for the operator first marked as such, and
 * exits 0 when a pass was recorded, 1 when a failure was, and 2 when it
 * refused and recorded nothing.
 */
import { rerunVerify } from '../rerun.mjs';

const { status, messages } = rerunVerify();
const text = messages.map((m) => (m.for === 'operator' ? `For the operator, in full:\n\n${m.text}` : m.text)).join('\n\n');
(status === 0 ? process.stdout : process.stderr).write(`${text}\n`);
process.exitCode = status;
