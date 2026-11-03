# Performance

Measured results against the budgets the product spec proposes. These are real numbers from one machine, published with the script that produced them, not a guarantee. Run `npm run bench` to reproduce on your hardware (about one minute; `--scale=small` for a quick self check).

## Budgets

| Interaction | p95 budget |
| --- | --- |
| List, filter, and record API requests | under 250 ms |
| Search requests | under 400 ms |
| Ordinary write acknowledgement | under 300 ms |
| Background run creation acknowledgement | under 500 ms |
| Status reflected over SSE after a write | under 2 seconds |

## Method

- Profile: 100,000 people, 25,000 organizations, 1,000,000 activities, 5,000 opportunities, 100,000 field claims, seeded deterministically into a scratch database (about 410 MiB on disk).
- The real server runs as its own process; the measuring client is a separate process sending one request at a time over a keep alive connection.
- Background load during every measurement: a qualification run over all 100,000 people (one 200 person chunk per 300 ms worker tick) restarted whenever it finishes, plus the job worker's mail poll lane ticking.
- Each row: 20 warmup requests, then 200 timed samples (SSE: 3 warmups, 20 samples).

## Results (2026-11-03, with the FTS5 search index)

Machine: Apple M3 Max (arm64, 16 cores, 128 GiB), Node 22, macOS (Darwin 27). Cold start 473 ms (through tsx, so it includes TypeScript transpile). Server RSS after the run: about 205 MB.

| Measurement | p50 (ms) | p95 (ms) | p99 (ms) | p95 budget (ms) | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| List people | 0.6 | 1.1 | 2.5 | 250 | pass |
| List organizations | 11.2 | 245.1 | 252.0 | 250 | pass |
| List opportunities | 7.1 | 232.5 | 242.5 | 250 | pass |
| Record (person with claims) | 1.9 | 2.3 | 226.9 | 250 | pass |
| Search people | 5.5 | 210.7 | 216.8 | 400 | pass |
| Search all | 334.6 | 348.6 | 355.7 | 400 | pass |
| Write acknowledgement (note) | 0.6 | 0.9 | 1.6 | 300 | pass |
| Run creation | 0.8 | 1.3 | 4.2 | 500 | pass |
| SSE reflection (write to event) | 2.1 | 4.1 | 185.9 | 2000 | pass |

## What the benchmark found and changed

- The first full run (2026-11-03, before the search index) missed one budget: the people list came in at p95 292.7 ms against 250 ms, because its ordering (`lower(last_name), lower(first_name), id`) had no matching index and sorted the whole table. Migration 015 adds that expression index, which took the people list to about 1 ms and the people filter from 316 ms to single digits.
- Global search used `LIKE '%term%'` scans and held its 400 ms budget with little margin. Migration 017 adds FTS5 trigram indexes for people, organizations, and opportunities, kept in sync by triggers, with results identical to the scans by construction (a property test compares the two over hundreds of queries). In like for like runs this cut search all from p95 496 ms (a measured run of the pre index code that crossed the budget, see below) to about 350 ms, and a no match query from about 24 ms to well under 1 ms. A term that matches nearly every row is a few times slower than the old scan (tens to about 200 ms at this scale), because the candidate read and the ranking then both look at every match; narrow terms, which dominate real use, are the win. Queries longer than 256 characters or containing a NUL byte are answered empty without touching the database.
- Run to run variance on this machine is large and bimodal. The same code, same profile, and same background load measured twice can differ by roughly 1.7x across every stall bound row (macOS schedules the benched server's synchronous work differently between runs; cold start moves from about 410 to about 475 ms in step). In a slow run the pre index search crossed its budget at p95 496 ms; the indexed search passes in both modes. The table above is from a slow run, so it is the conservative one. Treat differences under about 2x between your runs as environment, not code.

## Honest limits

- The p95 of every slower row above is one phenomenon, not many: the background qualification run evaluates a 200 person chunk in one synchronous transaction per 300 ms tick, and a request that arrives during a chunk waits for it (about 150 to 250 ms depending on the run mode above). The p50 columns show the same endpoints answering in single digit milliseconds when they do not collide with a chunk. Smaller chunks or moving qualification off the request thread is the known next lever; the budgets hold under the current load, which is the test's point.
- Global search ranking still scans all matches of very broad terms (a common first name), so its p95 sits near 350 ms at this scale; narrow and no match queries are now fast. Queries under 3 characters keep the old scan entirely.
- The seeded profile writes no audit rows, so a long lived real database carries extra audit volume this benchmark does not model.
- Numbers scale with hardware. The spec's reference profile (4 vCPUs, 8 GB) will be slower than the machine above; run the bench on your own machine for your own truth.
