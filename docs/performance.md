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

- Profile: 100,000 people, 25,000 organizations, 1,000,000 activities, 5,000 opportunities, 100,000 field claims, seeded deterministically into a scratch database (408.7 MiB on disk).
- The real server runs as its own process; the measuring client is a separate process sending one request at a time over a keep alive connection.
- Background load during every measurement: a qualification run over all 100,000 people (one 200 person chunk per 300 ms worker tick) restarted whenever it finishes, plus the job worker's mail poll lane ticking.
- Each row: 20 warmup requests, then 200 timed samples (SSE: 3 warmups, 20 samples).

## Results (2026-11-03)

Machine: Apple M3 Max (arm64, 16 cores, 128 GiB), Node 22, macOS (Darwin 27). Cold start 407 ms (through tsx, so it includes TypeScript transpile). Server RSS after the run: 204 MB.

| Measurement | p50 (ms) | p95 (ms) | p99 (ms) | p95 budget (ms) | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| List people | 0.5 | 0.6 | 0.9 | 250 | pass |
| List organizations | 7.9 | 157.4 | 178.1 | 250 | pass |
| List opportunities | 4.9 | 7.1 | 163.5 | 250 | pass |
| Record (person with claims) | 0.9 | 1.2 | 3.4 | 250 | pass |
| Search people | 3.5 | 5.4 | 156.7 | 400 | pass |
| Search all | 342.4 | 378.5 | 408.6 | 400 | pass |
| Write acknowledgement (note) | 0.4 | 0.7 | 1.2 | 300 | pass |
| Run creation | 0.6 | 0.9 | 2.9 | 500 | pass |
| SSE reflection (write to event) | 1.1 | 3.3 | 94.6 | 2000 | pass |

## What the benchmark found and changed

The first full run missed one budget: the people list came in at p95 292.7 ms against 250 ms, because its ordering (`lower(last_name), lower(first_name), id`) had no matching index and sorted the whole table. Migration 015 adds that expression index, which took the people list to p95 0.6 ms and the people filter from 316 ms to about 5 ms. The numbers above are from after the fix.

## Honest limits

- Global search (`/api/search`) holds its p95 budget with little margin at this scale, and its p99 crosses 400 ms. It uses `LIKE '%term%'` scans by design (no search cluster, no FTS table yet). If search feels slow at your scale, an FTS5 index is the known next lever; it has not been needed within budget so far.
- Occasional p99 spikes around 150 ms on otherwise fast endpoints line up with the background worker's qualification chunks sharing the process; the p95 budgets hold under that load, which is the test's point.
- The seeded profile writes no audit rows, so a long lived real database carries extra audit volume this benchmark does not model.
- Numbers scale with hardware. The spec's reference profile (4 vCPUs, 8 GB) will be slower than the machine above; run the bench on your own machine for your own truth.
