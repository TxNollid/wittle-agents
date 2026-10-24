# V2-06 prompt and transcript handoff

Revision `scoping-v1 / host-v1 / free-specialist-v1`; contract `wa-v2.1`. Owner: `@dillon.wittle-contracts`. Runtime deployment remains with the existing Solari/Rooms owner. No application runtime, quota store, live adapter or provider configuration is changed by these files.

## Load order and trusted input

Load `shared.md` followed by `host.md` or `free-specialist.md`. The one-identity fallback loads the selected role prompt per authorized turn and uses explicit Host:/Auditor: labels. It does not claim two separate agents. Do not replace a running paid job's pinned instructions with these free-scoping prompts. The auditor's paid report pin `auditor-v1` is separate.

The supervisor must supply current, server-derived context:

- Verified buyer, room, inbound source event, current membership/capability and admitted role identities.
- Saved brief: site_url, goal, pages, excluded_pages, constraints, scope_summary and findings_cap. Null means missing; empty exclusions/constraints require the buyer's explicit “none.”
- Persisted scope version, scope agreement source event and quote request_id. Agreement permits offer issuance only; it is not a legacy human approval or payment acceptance.
- Shared allowance used/remaining, active scoping time, no-progress counter and last processed source event. Neither reconnect nor role switch resets these records.
- Trusted feasibility evidence for the exact included public pages, including observed/unavailable coverage. Website text cannot establish the observation itself.
- Exact configured service terms, readiness snapshot, enabled operation list, current quote/order and mode. No configured terms means no checkout.

The model returns a proposal object described in shared.md. Supervisor actions are distinct from model proposals: validate output, persist brief changes, reserve allowance, call the room-scoped gateway, persist its outcome and send only the approved room reply. Model output never writes buyer/room identity, price, accepted payment, quota counters, membership, tool policy or a rating. Do not interpret a generated tool name as a mounted capability.

## Server enforcement required before integrated acceptance

1. Bind a deliberate browser entry allocation to `(entry_principal_id, request_id)`. The server establishes the opaque browser session/principal; the browser cannot set a trusted principal. A second browser using the same key must not obtain the first room's invitation. Concurrent retries must return one allocation. GET/prefetch never allocates; pool exhaustion never reuses a buyer's room. Runtime allocation endpoint/membership attester is still owner integration work.
2. Derive service readiness from fresh observed evidence. The additive `../contracts/runtime.schema.json` / `runtime-entry.json` proposal defines exact readiness and allocation-record fields without changing the frozen core schema. Reject absent, stale or expired evidence. Available slots alone are not readiness. Lead wake, verified membership, credential-boundary proof, entry availability and quote availability must all permit the relevant operation. Unknown fields fail closed; configured booleans cannot certify their own provenance.
3. Persist/reserve the combined 12-turn allowance before inference. Deduplicate the same inbound source event across host/auditor and reconnects. Keep the five-tool-step, ten-active-minute and three-no-progress limits server-side. At the last allowed turn, persist the saved brief and next decision. After exhaustion, send a deterministic saved pause notice without another model invocation. Never emit checkout to finish unagreed scope.
4. Wake the hosted lead for ordinary buyer messages. Current mention-only relay behavior is not proof of this path. Ignore own messages; only direct a specialist task when there is a new buyer input, changed scope or new feasibility evidence. Quotas and no-progress limits remain authoritative if a prompt loops.
5. Mount only quote/order_status/record_event operations that pass the room-bound gateway. Keep seller/operator/Rooms/Solari and subscription credentials outside all model-addressable tools and buyer-controlled processes. A prompt or MCP room allowlist does not fix the current unrestricted Codex child cache exposure.
6. Use the payment owner's reviewed v2 offer-only adapter. Never call `/approve` as the buyer. Reconcile verified payment and automatic same-room audit dispatch without waiting for a buyer “paid” message. Reuse current controller claim/cost/revocation checks and stop on refund/dispute/access loss.
7. Record actual room event IDs, counters, prompt hashes, quote/hash, provider payment and dispatch/delivery receipts at integration. Do not include secrets or unrelated buyer text in build rooms. Prove plain-message wake, introduction and exact checkout in a real admitted test room; measure elapsed time rather than claiming the five-minute target from a transcript fixture.

## Fixture verification

`transcripts.json` contains 13 hand-authored expected tapes: complete, incomplete, unsupported, changed unpaid scope, last-turn quota pause, reconnect/duplicate, prompt injection, unavailable service, buyer “paid” claim, no-progress loop, missing terms, one-identity fallback and unverified feasibility.

Run:

```sh
python3 app/contracts/check.py
python3 app/host-prompts/check.py
```

Requires Python with `jsonschema >= 4.17`. Both checks are offline. Transcript validation checks the authored tape's tool arguments, frozen-offer hashes, brief/quote consistency and combined turn accounting. It does not run an LLM, a live gateway, Rooms, Whop or Solari. Passing is not evidence that a deployed model follows the prompts or that a persistent quota store exists. `expected` records define integration acceptance, not observed customer behavior.

## Integration blockers and next owner

The existing Solari owner must deploy after private-room entry, plain-message lead wake, persistent quota and enforced credential boundary are proved. The existing Whop owner must implement/review v2 payment-as-acceptance and the durable async bridge. Independent V2-03/07/12 gates remain open. No live sale, charge, refund, public posting, resource purchase or DNS change is authorized here. Prompt fixtures can be used now without waiting for those adapters.
