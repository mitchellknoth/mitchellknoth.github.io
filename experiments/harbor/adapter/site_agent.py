"""A Harbor external agent that asks the site's visitor agent one question over its public HTTP contract.

The agent runs in the Harbor process on the host, not in the task container, so it reaches the service at
loopback with no Docker networking. The container is only where the answer file is written and graded.
Like scripts/evals (evals/README.md, "Keeping evals off the visitor budget") it refuses any base URL that is
not loopback: a deployed Worker shares its Guard with real visitors.

Contract used (worker/index.ts): POST /agent/session (201 + session cookie), then POST /agent/ask {question}.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import override
from urllib.parse import urlparse

import httpx
from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

LOOPBACK = {"localhost", "127.0.0.1", "::1", "[::1]"}
ANSWER_PATH = "/app/answer.json"


def parse_server_timing(header: str | None) -> dict:
    """`round1;dur=2400;desc="in=3 out=92 reasoning=0 tools=0"` -> phase ms and per-round tokens."""
    phases: dict[str, float] = {}
    rounds: list[dict] = []
    for part in re.split(r",\s*(?=[a-z_0-9]+(?:;|,|$))", header or ""):
        name, *params = [p.strip() for p in part.split(";")]
        if not name:
            continue
        dur = next((float(p[4:]) for p in params if p.startswith("dur=")), None)
        desc = next((p[5:].strip('"') for p in params if p.startswith("desc=")), "")
        if dur is not None:
            phases[name] = dur
        if re.fullmatch(r"round\d+", name):
            fields = dict(kv.split("=", 1) for kv in desc.split() if "=" in kv)
            rounds.append({"ms": dur, **{k: int(v) for k, v in fields.items() if v.isdigit()}})
    return {"phases": phases, "rounds": rounds}


class SiteAgent(BaseAgent):
    @staticmethod
    @override
    def name() -> str:
        return "site-agent"

    @override
    def version(self) -> str:
        return "0.1.0"

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    @override
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        base = os.environ.get("SITE_AGENT_URL", "http://127.0.0.1:8787")
        host = urlparse(base).hostname or ""
        if host not in LOOPBACK:
            raise ValueError(f"SITE_AGENT_URL must be loopback, got {host!r}: evals must not use the visitors' budget")
        origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
        question = instruction.strip()

        record: dict = {"httpStatus": None, "body": None, "error": None}
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=float(os.environ.get("SITE_AGENT_TIMEOUT_S", "120"))) as client:
                session = await client.post(f"{base}/agent/session", headers={"origin": origin})
                cookie = (session.headers.get("set-cookie") or "").split(";")[0]
                if session.status_code != 201 or not cookie:
                    record.update(httpStatus=session.status_code, error=f"session: HTTP {session.status_code}")
                else:
                    ask = await client.post(
                        f"{base}/agent/ask",
                        headers={"origin": origin, "cookie": cookie},
                        json={"question": question},
                    )
                    record["httpStatus"] = ask.status_code
                    try:
                        record["body"] = ask.json()
                    except ValueError:
                        record["error"] = "response was not JSON"
                    record["serverTiming"] = ask.headers.get("server-timing")
        except httpx.HTTPError as error:
            record["error"] = f"{type(error).__name__}: {error}"
        record["latencyMs"] = round((time.perf_counter() - started) * 1000)

        timing = parse_server_timing(record.get("serverTiming"))
        local = Path(self.logs_dir) / "answer.json"
        local.write_text(json.dumps(record, indent=1))
        await environment.exec("mkdir -p /app")
        await environment.upload_file(local, ANSWER_PATH)

        # Per-round tokens from the Worker's Server-Timing header (TIMING_HEADER=true), when it is present.
        if timing["rounds"]:
            context.n_input_tokens = sum(r.get("in", 0) for r in timing["rounds"])
            context.n_output_tokens = sum(r.get("out", 0) for r in timing["rounds"])
        context.metadata = {
            "latency_ms": record["latencyMs"],
            "http_status": record["httpStatus"],
            "status": (record["body"] or {}).get("status"),
            "rounds": len(timing["rounds"]),
            "phases": timing["phases"],
        }
