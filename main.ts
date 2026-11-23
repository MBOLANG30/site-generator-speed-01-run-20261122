import { setFlagsFromString } from 'node:v8';
import { readFileSync, writeFileSync } from 'node:fs';

// Turn V8's incremental marking off before solve.js is loaded, as the
// baseline does: it keeps the timed run free of background marking work.
setFlagsFromString('--no-incremental-marking');

const { run } = await import('./solve.js');

// The harness mounts the cases at /input and expects the answers at /output;
// under the local process driver those mounts arrive as environment
// variables instead. This program only ever writes answers.json into the
// output directory, never the directory itself.
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const CASES_FILE = INPUT_DIR + '/cases.json';
const ANSWERS_FILE = OUTPUT_DIR + '/answers.json';

const cases = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
const answers = cases.map((c) => run(c.input));
writeFileSync(ANSWERS_FILE, JSON.stringify(answers));
