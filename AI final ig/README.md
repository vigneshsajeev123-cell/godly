# Academic Scheduling

A lightweight browser-based workspace for planning weekly university timetables. Configure teaching days, daily slots, period length, and rooms; edit course workloads; then generate and review schedules by cohort, faculty member, or room. Dark mode is the default, with a restrained liquid-glass finish and a sun and moon control to switch themes. Select a class card with a mouse or keyboard to open its details.

## Run locally

1. Install Node.js 20.19+ or 22.12+.
2. Run `npm install`.
3. Run `npm run dev` and open the local URL printed by Vite.

The timetable interface is a self-contained HTML and JavaScript application. Tailwind utility styles are loaded from the Tailwind CDN, so an internet connection is needed while developing or viewing the page.

---

## Architecture (reprogrammed version)

| File | Role |
|---|---|
| `scheduler.js` | **All logic, no DOM**: CSV parsing, config/context, declarative rules, pre-flight, CSP solver, fixed-order DFS and FIFO BFS baselines, optimizer, auditor and metrics. Runs in the browser, a Worker, and Node. |
| `worker.js` / `solverClient.js` | Dispatch the selected solver in a Web Worker (falls back to a deferred main-thread call if Workers are unavailable). |
| `index.html` | UI only. The page re-audits every returned timetable on the main thread before showing success. |
| `tests/` | `npm test` (= `node tests/run.js`; also `node --test tests/`). No network. |

Pipeline: `validate config → validate hours vs grid → pre-flight → unary reduction + symmetry breaking → AC-3 → backtracking (MRV+degree, LCV, forward checking, trail) → audit → simulated-annealing optimizer → audit → report`.

### Algorithm comparison
- **CSP** remains the existing solver and optimizer. Its expanded-node count is recursive search calls; generated states are N/A; backtracks count undone failed assignments. Its displayed runtime includes validation, pre-flight, CSP search, audit and optimizer.
- **DFS** assigns sessions in workload input order and tries time/room candidates in grid order. It checks shared hard rules at each partial assignment, then returns the first complete valid schedule. Expanded nodes are recursive calls; generated states count candidate successor assignments considered; backtracks count rejected or undone branches. Soft penalty uses the same weighted rule report.
- **BFS** uses a FIFO queue of partial timetables and expands them level by level in the same fixed variable/value order. Expanded states are dequeued states; generated states count candidate successor assignments considered. Backtracks are N/A. Defaults: 40,000 expanded states, 4,000 ms, and 20,000 queued states; each is bounded, and a limit is reported as inconclusive. It returns the first complete valid schedule, so it does not claim a globally minimum soft penalty.
- Runtime covers validation, pre-flight, search and final audit/scoring for all algorithms (plus the existing optimizer for CSP). The comparison winner is selected only from complete valid results: lower soft penalty, then runtime, then expanded nodes. Exact ties are shown as ties.
- Each algorithm's most recent result is stored independently. The timetable selector only displays a stored complete valid result; failed or partial results show their status instead. The ranking compares results produced from the same workload/configuration/options snapshot; results from an older input snapshot remain visible but are excluded from the winner.

### Result statuses
`solved`, `proven_unsolvable` (pre-flight proof **or** search space exhausted), `aborted_node_limit`, `aborted_time_limit` (inconclusive — never labelled unsatisfiable), `invalid_config`, `invalid_input`, `audit_failed`.

### Rules (one declarative set, `buildRules`)
Hard: `H1` faculty clash, `H2` room clash, `H3` batch clash, `H4` room type, `H5` exact weekly hours, `H6` inside grid / not in declared unavailability (H6 is an addition; it only matters if you declare unavailability).
Soft (weighted, each configurable in the UI): `S1` avoid first hour, `S2` avoid consecutive labs, `S3` faculty gaps, `S4` preferred slots. Cost = Σ weight × violations.

### Interpretations I chose
- **Consecutive labs**: the *same batch* has lab sessions in two *adjacent slots on the same day* (any lab subjects). One violation per adjacent pair. Optional extra: one violation per lab beyond *N* labs/day (0 = off). Note a 2-hour lab block is two unit sessions, so this rule pushes labs apart.
- **Preferred slots**: per batch / faculty / subject, listed as `kind:name=1,2,3` (1-based; ranges like `1-3`). One violation per (session, matching preference) outside its slots.
- **Faculty gaps**: per faculty per day, `(last − first + 1) − classes`; the total is reported as gap-hours.
- **First hour**: slot 1 (index 0) for the listed batches or `all`; empty list = rule inactive.
- **Unavailability** (hard): `faculty:Prof X=Mon:*;Tue:1,2`.
- **Max weekly hours per subject** = `days × slots` of the current grid (sessions of one subject need distinct slots).
- **Identity**: faculty, batch, subject and room names are trimmed, space-collapsed, case-insensitive; the first spelling seen is the display name.
- **CSV**: nothing is silently changed. Invalid hours / Is_Lab / empty fields / short rows / duplicate (batch, subject) rows are reported with their line number and the file is **not loaded** until fixed. Multi-line quoted fields are not supported.
- **"Constraints satisfied" %** is rule-level: how many active rules have zero violations (violation units are also reported).
- **Adjustments** = net sessions whose (day, slot, room) differ between the CSP timetable and the final one; raw accepted moves/swaps are reported separately. A minimal-change pass sends sessions back to their original spot when that costs nothing.
- **Reproducibility**: the optimizer is seeded; results are identical when the iteration budget (not the time budget) ends the run.
- **Metrics**: `nodes` = recursive search calls; `backtracks` = tentative assignments undone without success (each failed branch counted once).
- **Filler sessions (B2)**: this snapshot has no `FILL_ALL_SLOTS`/`fillRemainingSlots` code, so nothing was added; the hours rule ignores any item flagged `isFiller` as a safeguard.

### How to run
- **Double-click `standalone.html`** — fully self-contained, works from disk (`file://`). Browsers block ES-module imports on `file://`, so `index.html` opened by double-click will show dead buttons.
- **`npm run dev`** (serves `index.html` over http, where modules and the worker load normally).
- After editing `scheduler.js` or `index.html`, regenerate the standalone file with `npm run build:standalone`.
