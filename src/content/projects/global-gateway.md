---
title: "External API Platform"
summary: "At John Deere Financial, I architected the first external-facing API on an early API-gateway platform, giving dealer software access to sales-lead data with role-based authorization and audit logging. The platform later matured into a gateway for both internal and external APIs."
period: "2019 – 2021"
stack: ["java", "api-gateway", "oauth", "rbac"]
featured: false
order: 5
section: foundations
roleTag: "First external API"
---

## Scope

At John Deere Financial, this was an early attempt to build what a product such as Azure API Management provides: a common platform for governing and exposing APIs to internal consumers and dealer software. My part focused on safely exposing a selected business capability *outside* the company by opening dealer access to sales-lead data.

## What I built

I architected the platform's first external API, with role-based authorization and audit logging in its first release.

## Outcome

The work established a reusable pattern for exposing business data to external partners. The early platform later matured into a gateway used to host APIs for both internal and external consumers.
