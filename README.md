# Wittle Agents

Hackathon submission — Terac Zero-Human Company Hackathon NYC, October 24, 2026.

**Hire agent–human pairs to do tasks in your project.** Concierge recommends a specialist; the buyer and specialist agree on requirements for free; verified Whop payment authorizes the work; the specialist uses applicable tools and returns results through Wittle Rooms.

Website: https://wittleagents.com

## Initial specialists

- Website Auditor: evidence-backed website findings.
- Anti-Slop Editor: rewrite drafts while preserving facts.
- Local Guide NYC: sourced, timed local itineraries.

Terac supplies human task/review workflows. Exa/web tools support research; Solari and GCP support hosted execution. Provider credentials and accounts are required for real integrations.

## Repository map

| Directory | Purpose |
| --- | --- |
| `app/web` | Next.js app and static landing website |
| `app/specialists` | Specialist definitions, prompts, validators, hosted wrappers and study/hire service |
| `app/solari-agent` | Solari/Rooms runtime and restricted inference gateway |
| `app/rooms-entry` | Private room allocation, source and membership verification |
| `app/whop-payments` | Checkout, payment validation and lifecycle controller |
| `app/integration` | Host scoping and application composition |
| `app/auditor` | Guarded audit engine and delivery |
| `app/fulfillment` | Payment-to-work dispatch |
| `app/contracts`, `app/stats`, `test/v2` | Shared contracts, statistics and independent regression tests |

## Local checks

Use Node.js 22.13 or newer (SQLite support required). Packages have independent manifests; there is no root workspace install.

```sh
npm ci --prefix app/whop-payments
npm test --prefix app/whop-payments
npm test --prefix app/rooms-entry
npm test --prefix app/integration
npm test --prefix app/specialists
```

For the frontend, install its dependencies and use its package scripts. `.env.example` files describe configuration where supplied. Do not use real credentials with fixture demos or expose internal controller endpoints publicly. Hosted relay scripts require separately installed Rooms and Claude tooling.

## Submission status and limits

This is a source snapshot of an active hackathon build, not a claim that every described production flow is complete. Local/fixture tests do not establish provider acceptance. Concierge wake/reply and saved free scope have evidence in the private build; the complete specialist handoff, payment-to-delivery/revision flow, and human-review execution require separate end-to-end acceptance. The website is early access. Sandbox payments are distinct from live payments. No measured Terac improvement or external revenue is claimed here.

## Public snapshot

Application source, tests, prompts and public web assets are included. Credentials, databases, private room links/evidence, local agent state, internal planning transcripts, deployment state and generated artifacts are excluded. Owner-specific helper paths were made configurable in this snapshot. Runtime changes made after this snapshot are not automatically published.
