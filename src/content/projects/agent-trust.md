---
title: "Agent Trust – Scanning, Policy, and Reusable Review"
summary: "Built a versioned trust layer around a skill scanner, separating scan observations from policy decisions and emitting SARIF for CI. Packaged local pre-PR reviews, branch-review skills, and feedback hooks so trust practices can travel across repositories."
period: "2026 – present"
stack: ["python", "skill-scanning", "sarif", "github-actions", "review-skills"]
featured: false
order: 0.3
section: recent
---

## What shipped

I built an Agent Trust Layer that wraps a skill scanner in a versioned trust envelope. Scanner observations stay separate from policy decisions, and the same evidence can be emitted as terminal output, JSON, Markdown, or SARIF for CI.

The implementation includes configurable policy thresholds, explicit accepted-risk records, and scanner-error envelopes. A failed scan is an error state rather than a clean result. Semantic scans remain advisory until calibration supports using them as a gate.

## My contribution to reusable review

I packaged the team’s review practice into a local pre-PR gauntlet, reusable branch-review skills, and feedback hooks. The objective is to make repeated misses change the next run: a clearer instruction, a regression check, or a reusable reviewer that another engineer can inherit.

I also published [Evidence-Gated Delivery](https://github.com/mknoth197/evidence-gated-delivery) as an open-source workflow experiment. It is historical work, not the team’s current execution workflow. The continuing practice is described in the [Agent Harness field guide](/writing/the-model-is-table-stakes/).

## The proof ceiling

Scanning and review expose evidence for a decision. They do not certify an artifact as safe, and a green report does not replace target-system authorization or human judgment.
