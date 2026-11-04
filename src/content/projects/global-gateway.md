---
title: "External API Platform"
summary: "At John Deere Financial, I helped turn an early API-gateway effort into a safer path for dealer software by architecting the platform's first external-facing API with role-based authorization and audit logging. That foundation later matured into a gateway used for both internal and external APIs."
period: "2019 – 2021"
stack: ["java", "api-gateway", "oauth", "rbac"]
featured: false
order: 5
section: foundations
roleTag: "First external API"
---

## Scope

This was an early attempt to create at John Deere Financial what a product such as Azure API Management provides: a common platform for governing and exposing APIs to internal consumers and dealer software. My part focused on safely exposing a selected business capability *outside* the company—opening dealer access to sales-lead data without treating security and observability as afterthoughts.

## What I built

- The platform's **inaugural external API**, architected with **role-based authorization** and **audit logging** from day one.

## Outcome

The work established a reusable pattern for exposing business-critical data to external partners, with security and auditability designed in rather than bolted on. The early platform later matured into a gateway used to host APIs for both internal and external consumers.
