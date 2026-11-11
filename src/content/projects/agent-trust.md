---
title: "Agent Trust – Scanning, Policy, and Reusable Review"
summary: "Built a versioned trust layer around a skill scanner, separating scan observations from policy decisions and emitting SARIF for CI. Packaged a local pre-PR review gauntlet, branch-review skills, and feedback hooks that other repositories can reuse."
period: "2026 – present"
stack: ["python", "skill-scanning", "sarif", "github-actions", "review-skills"]
featured: false
order: 0.3
section: recent
facts:
  context: "Skill scanner output and the team’s review practice needed to reach CI and other repositories as reusable evidence."
  contribution: "Built the versioned trust layer around the scanner and packaged the team’s review practice into a pre-PR gauntlet, branch-review skills, and feedback hooks."
  result: "The same evidence is emitted as terminal output, JSON, Markdown, or SARIF. A failed scan is an error state rather than a clean result."
  boundary: "Scanning and review expose evidence for a decision; they do not certify an artifact as safe. Semantic scans remain advisory."
---

## What shipped

I built an Agent Trust Layer that wraps a skill scanner in a versioned trust envelope. Scanner observations stay separate from policy decisions, and the same evidence can be emitted as terminal output, JSON, Markdown, or SARIF for CI.

The implementation includes configurable policy thresholds, explicit accepted-risk records, and scanner-error envelopes. A failed scan is an error state rather than a clean result. Semantic scans remain advisory until calibration supports using them as a gate.

## My contribution to reusable review

I packaged the team’s review practice into a local pre-PR gauntlet, reusable branch-review skills, and feedback hooks. A repeated miss should change the next run: a clearer instruction, a regression check, or a reusable reviewer that another engineer can inherit.

I also published [Evidence-Gated Delivery](https://github.com/mitchellknoth/evidence-gated-delivery) as an open-source workflow experiment. It is historical work, not the team’s current execution workflow. The continuing practice is described in the [Agent Harness field guide](/writing/the-model-is-table-stakes/).

## The proof ceiling

Scanning and review expose evidence for a decision. They do not certify an artifact as safe, and a green report does not replace target-system authorization or human judgment.
