# Bounded execution lab

A public, independent demonstration of credential mediation, proposed patches,
and validation outside a worker's writable environment. Uses synthetic data;
does not connect to John Deere, GitHub, Codex, or Claude. The worker is deterministic,
not an LLM. This is an execution-contract experiment, not an agent-quality benchmark.

## Reproduce

Requirements: Python 3.10+, Docker CLI and a running Docker engine (Linux containers).
Pull the official image before running: the internal network has no Internet route.

```sh
docker pull python:3.12-alpine
python3 run.py --scenario valid --output /tmp/bounded-valid
python3 run.py --scenario invalid --output /tmp/bounded-invalid
python3 run.py --scenario scope --output /tmp/bounded-scope
python3 run.py --scenario symlink --output /tmp/bounded-symlink
python3 run.py --scenario timeout --deadline 3 --output /tmp/bounded-timeout
```

Output directories must not already exist. Accepted proposals exit 0. Rejected,
timed-out, or errored runs exit 1; inspect `receipt.json` to distinguish them.
Use `python3 test_lab.py` to run the acceptance matrix automatically.
Image tags can change; receipts record the actual local image ID. For a fixed
rerun, pass that ID or a repository digest with `--image`.

## Architecture

```text
host: frozen fixture + scope checks + receipt + patch
  internal Docker network (no published ports)
    worker -> gateway:9080 -> loopback upstream:9081
              injects synthetic token; allows one GET route
  validator: network=none; workspace + original tests read-only
```

The token lives only in the gateway environment. The worker receives the task
through a fixed route; it cannot supply an upstream URL or forwarded headers.
The upstream binds to gateway loopback, not to its network interface. Unknown
routes and POST requests are rejected. Containers run as a non-root user with a
read-only root filesystem, dropped capabilities, resource limits, and no Docker
socket. Only the temporary worker workspace is writable.

The host owns the original fixture, allowed path (`pricing.py`), and tests.
Once the worker exits, the host rejects extra files and symlinks, derives a patch
from the original bytes, records hashes, and starts the separate validator with
no network. Nothing is applied to an existing repository or published.

## Evidence and expected results

| Scenario | Expected status | Reason |
| --- | --- | --- |
| valid | accepted | Empty carts fixed; nonempty and zero-price cases preserved |
| invalid | rejected_tests | Returning zero for every cart fails a nonempty-cart check |
| scope | rejected_scope | Worker created an unapproved path |
| symlink | rejected_scope | Approved filename points outside the workspace |
| timeout | timed_out | Worker exceeded its deadline and was killed |

Receipts include fixture, candidate, and patch hashes where applicable, image ID,
elapsed time, bounded status, and cleanup outcome. Logs show credential mediation
and denied requests without recording the token. `observed/` contains one measured
local run of the matrix; it is evidence for those fixture runs, not a performance claim.

## Limits

- This gateway models an HTTP credential boundary, not Git smart HTTP, OIDC,
  per-user authorization, or a production credential broker.
- Every worker on this run's network can use the one permitted fixture route.
  There is no tenant authentication or concurrent-user isolation claim.
- Docker containers share a kernel. These controls do not establish resistance
  to hostile code or container escapes. Use only this trusted fixture, not
  arbitrary repositories or model-generated code.
- The fixture tests cover three cart behaviors. They do not establish universal
  correctness, malicious-test resistance, or production readiness.
- The host's Docker daemon and image are trusted. A daemon failure can prevent
  cleanup; the receipt reports detected cleanup errors. Forced host termination
  can leave resources with the `bounded-runner-` prefix behind.
- No retry/resume, private connectivity, real agent, throughput, or productivity
  result is demonstrated. A timeout is terminated, not automatically retried.

## Files to inspect

[Docker Engine security](https://docs.docker.com/engine/security/) documents the
namespace, resource, daemon, and kernel-configuration boundaries; it does not
certify this experiment's containment.

`run.py` owns execution and evidence; `gateway.py` mediates the token;
`worker.py` generates the five fixture behaviors; `validate.py` holds the original
acceptance checks; `test_lab.py` checks the matrix and returned artifacts.
