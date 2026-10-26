---
name: Bug report
about: Report a reproducible problem in railgate's test-money workflow
title: "[Bug] "
labels: bug
---

## What happened?

Describe the problem and the behavior you expected.

## Steps to reproduce

Provide the smallest reproducible example using synthetic data. Include the command/HTTP route/MCP tool and whether this was offline, sandbox, simulated bank or Base Sepolia.

## Environment

- Commit/version:
- Node and pnpm versions:
- OS:
- Local Node service or Cloudflare Worker:

## Relevant output

Include sanitized errors and expected/actual statuses. Do not include `.env`, tokens, private keys, ntfy topics, approval links, signed transactions or database exports.

## Payment/retry context

If relevant, explain whether the outcome is known or uncertain and whether the same idempotency key was reused. Do not create additional payments or reset state merely to reproduce the issue.
