# Harbor adapter spike (Part of #16)

Question: can [Harbor](https://www.harborframework.com) (v0.25.0, Apache-2.0) drive the visitor agent's existing HTTP
contract and grade it with the repo's own grader, and is it worth the Docker overhead?

**Recommendation: go, as the runner; no-go, as the history store.** It works end to end with about 170 lines of glue.
It adds repeats (`-k`), parallel trials, a viewer and per-trial timing and token records. It does not give immutable
history, and it costs about 7 s of Docker overhead per trial. Keep the benchmark record format independent of Harbor
and export Harbor's results into it. Smallest next step: run the first baseline through this adapter once the eval
token exists, and write the exporter then.

## What I built (all under `experiments/harbor/`, nothing in `worker/` or `src/`)

| File | Purpose |
|---|---|
| `adapter/site_agent.py` | A Harbor external agent (`BaseAgent`). Opens a session, asks the question, writes `/app/answer.json` into the task container and fills `AgentContext` (tokens, latency, rounds, phases) from the Worker's `Server-Timing` header. Refuses any non-loopback URL, like `evals/README.md` requires. |
| `verifier/grade-one.mjs` | Runs in the container. Calls the repo's `scripts/evals/grade.mjs` unchanged and writes `reward.txt`, `reward.json` and `grade.json` (every check, plus the grader version). |
| `make-tasks.mjs` | Builds Harbor task directories from `evals/question-set.json` (five by default, one per category). Copies the grader and the built corpus into each task's `tests/`. |
| `stub/server.mjs` | Stand-in for `/agent/session` and `/agent/ask`, so the plumbing runs with no model and no token. `STUB_WRONG=id,id` returns deliberately wrong answers to exercise the fail path. |

## Reproduce

```bash
uv tool install harbor==0.25.0          # isolated tool env, not in package.json
npm run build                           # writes generated/corpus.json
node experiments/harbor/make-tasks.mjs  # writes experiments/harbor/tasks/ (gitignored)

# A) stub, no model, no token
STUB_WRONG=numeric-trap-001 node experiments/harbor/stub/server.mjs &
cd experiments/harbor
PYTHONPATH=adapter harbor run -p tasks --agent site_agent:SiteAgent -e docker -k 3 -n 3 --job-name spike -o jobs
harbor view jobs -p 8099                # local viewer

# B) the real Worker locally, AI binding off (answers come back `unanswered`)
npm run preview:workers &               # from the repo root; then repeat the harbor command
```

## Results (what I ran)

| Run | Target | Trials | Result |
|---|---|---|---|
| spike-1 | stub, one question wrong on purpose | 15 (5 tasks x 3) | 9 pass, 6 fail. The 3 expected fails plus 3 from a stub artifact: its answer text contained "002", which the grader's no-invented-numbers check correctly flagged. |
| spike-2 | stub, artifact fixed | 15 | 12 pass, 3 fail: exactly `numeric-trap-001` x3. |
| spike-worker | the real Worker, `wrangler dev --local` (AI off) | 5 | The personal-information question was refused by the deterministic screen and passed. The other four returned `unanswered / model_error`, as expected with no model, and failed. `Server-Timing` was present on every answer. |

This proves the plumbing and the grader's fail path. It says nothing about the agent's quality: no real model ran.

## What Harbor gave

- **External agents run on the host.** `BaseAgent.run()` executes in the Harbor process, so it reaches `127.0.0.1` with no Docker networking. The container is only where the answer file lands and is graded. (Harbor has no documented "target an already-running HTTP service" mode; this adapter pattern is how to do it.)
- **The same grader.** `grade.mjs` runs unchanged in `node:24-slim`, so Harbor and `npm run evals` cannot disagree. `grade.json` records the grader version.
- **Repeats and parallelism.** `-k 3 -n 3` ran 15 trials in 37 to 39 s.
- **A per-trial record.** `result.json` holds the reward, phase timestamps (environment setup, agent, verifier), token counts, and whatever the adapter puts in `metadata`: here latency, HTTP status, answer status, rounds and Server-Timing phases. The job-level `result.json` has the mean and the lists of passing and failing trials.
- **A viewer.** `harbor view jobs` served a jobs list (HTTP 200; the API returned per-job trial counts, token totals and mean reward). I did not inspect its UI visually.

## What it costs

| Cost | Measured |
|---|---|
| Docker setup per trial | about 3 s (max 4.3 s), warm image cache |
| Verifier per trial | about 0.6 s |
| Whole trial | about 7.5 s; the stub answered in 0.5 s, so overhead dominated |
| Images | `node:24-slim` is about 690 MB on disk |
| Job directory | about 44 KB per trial |
| Extrapolation (not measured) | 38 questions x 3 repeats = 114 trials at `-n 3` adds roughly 5 minutes of overhead; with a real model taking 5 to 10 s the overhead is a minority, not the main cost |

## What did not work or is unproven

- **No immutable history.** Jobs are plain directories under `jobs/` (gitignored here). Harbor has no append-only store; comparing runs over time is the viewer's job list, or the hosted Harbor Hub, which I did not use. No result was uploaded anywhere.
- **`harbor job regrade` could not be used.** It re-scores recorded answers, but only for tasks in `environment_mode = "separate"` that read inputs from `/logs/artifacts`. I tried `artifacts = ["/app/answer.json"]` plus a `tests/Dockerfile` that bakes in `/tests`. The verifier then ran and graded, but the collected answer was never present in its container (it existed only on the host under `artifacts/app/answer.json`). I stopped at the time box. The repo's grader is a pure function, so re-scoring stored answers does not need Harbor.
- **Token coverage is partial.** Only input, output and tool-call counts come from `Server-Timing`; cache-read and reasoning tokens are in the Worker's `ask_timing` log, not carried here. Cost is not computed.
- **Concurrency is untested against a real model.** Earlier live runs showed five parallel questions slower than one at a time; that needs a deliberate check before choosing `-n`.
- **Harbor is pre-1.0** and changing (its own source warns that legacy agent flags go away in the next major). Pin the version.
- **Harbor 0.25.0 tries to fetch a model price list from `raw.githubusercontent.com` at startup.** Behind a corporate certificate that fails noisily and falls back to a bundled copy; nothing in the results depends on it.
- **Windows and cloud sandboxes** were out of scope.

## Why the history store should stay independent

A benchmark record needs the commit, corpus hash, question-set version, grader version, config (model, effort,
`maxTurns`, Clef mode) and per-question outcomes, and it must be append-only. Harbor's job directory has none of that
guaranteed and is large. The plan is: Harbor (or the existing `npm run evals`) produces results; a small exporter writes
the compact, hash-chained record; the record is what gets stored.
