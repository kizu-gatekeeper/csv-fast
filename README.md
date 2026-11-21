# csv-fast

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/kizu-gatekeeper/csv-fast/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/kizu-gatekeeper/csv-fast/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0: `solve.js` answers exactly
as csv-reader does for every `{text, header}` input — the same `{columns,
rows, errors}`, including its broken-row policy (BOM dropped, LF/CRLF record
ends, empty lines are no record, stray CRs, quoted fields with doubled
quotes and CR/LF inside, quote junk after a closing quote, and quotes that
never close) — while reading whole fields at a time instead of one character
at a time.

## How it is faster

The reference reads one character at a time and builds every field a
character at a time. This reader slices whole fields out of the text with
`indexOf`:

- a clean line (no quote, no stray CR) is split on commas in one go;
- an unquoted field is the slice up to the next comma or line break, with
  stray CRs (rare) fixed up after the fact;
- a quoted field is the slice up to the next quote that is not doubled,
  with `""` collapsed to one quote and CR / CRLF inside it read as LF.

No dependencies, no WebAssembly, no native code — plain JavaScript, run
under Node 22 with V8's incremental marking off, as the house driver does.

## Layout

- `solve.js` — the reader: `run(input)` returns csv-reader's answer.
- `main.ts` — the program the harness runs: reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`.
- `package.json` — `{ "type": "module" }`, so the ES module loads.
