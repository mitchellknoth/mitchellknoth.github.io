---
title: "Account & VPC Deletion Automation"
summary: "Owned AWS account automation and replaced manual account and VPC deletion with an event-driven Step Functions and Lambda workflow. Built DNS verification and cleanup to address subdomain-hijacking risk, and introduced Dev Containers for reproducible onboarding."
period: "2023 – 2025"
stack: ["step-functions", "lambda", "event-driven", "python", "route53", "dev-containers"]
featured: false
order: 3
section: foundations
---

## Scope

I owned AWS account automation and recurring infrastructure operations. Account and VPC deletion were manual tasks with consequential blast radius; the goal was a consistent process with fewer opportunities for error.

## What I built

- An event-driven workflow on AWS Step Functions and Lambda to coordinate account and VPC deletion.
- Automated DNS verification and cleanup, developed with networking and security partners, to address subdomain-hijacking risk.
- Dev Containers that gave engineers a consistent, reproducible starting environment.

## Outcome

Repeated infrastructure tasks became automated workflows, and onboarding depended less on individual setup. These contributions belong to the earlier cloud-foundations chapter.
