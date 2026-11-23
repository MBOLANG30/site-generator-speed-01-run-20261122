// Entry point for the site-generator-speed-01 harness.
//
// Reads every case from /input/cases.json, answers each with run() from
// solve.js, and writes the answers in order to /output/answers.json.
// Only answers.json is written, into the mounted /output directory; nothing
// else is created, moved or removed.
import { setFlagsFromString } from 'node:v8';
import { readFileSync, writeFileSync } from 'node:fs';

setFlagsFromString('--no-incremental-marking');

const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(`${inputDir}/cases.json`, 'utf8'));
const answers = [];
for (let k = 0; k < cases.length; k++) answers.push(run(cases[k].input));
writeFileSync(`${outputDir}/answers.json`, JSON.stringify(answers), 'utf8');
