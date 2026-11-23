# site-generator-speed-01-run-20261122

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/MBOLANG30/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/MBOLANG30/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for [make.fun](https://make.fun/)'s own makefun-site 1.0.0,
entered in the [site-generator-speed-01-run-20261122 bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122):
it builds the same static site, byte for byte, in less CPU time.

## What it is

`solve.js` exports `run(input)`, where `input` is one site —
`{ site, templates, files }` — and returns the output tree makefun-site
1.0.0 returns for it: every page's `index.html`, the index and tag pages,
`build-report.txt`, and each static file. `main.ts` reads the cases from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

It is written from scratch from the makefun-site README and reference
behaviour: the same front matter, Markdown subset, template dialect, slug
rule and report. Nothing is copied from the reference implementation.

## How it is fast

- Markdown is rendered in one pass straight off the body text: each line is
  classified once by a one-line lookahead, and inline markup is rendered by
  a single scanner over index ranges, so nested spans never copy their text.
- Each template is compiled once per case into a rendering function, instead
  of being interpreted node by node; paths resolve inline and loop variables
  live in one bindings object.
- Slugs are cached per case, pure-ASCII strings skip Unicode normalisation,
  HTML escaping returns untouched strings untouched, and word counting is one
  table lookup per character.

## Run it

```sh
node main.ts
```

Node 22, no dependencies, no network, no build step.
