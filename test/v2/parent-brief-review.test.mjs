import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createParentBriefAgent } from "../../app/solari-agent/parent-brief-agent.mjs";
const source = new URL("../../app/solari-agent/parent-brief-agent.mjs", import.meta.url);
const hash = () => createHash("sha256").update(readFileSync(source)).digest("hex");
const before = hash();
const binding = { buyer_id: "qa_synthetic_buyer", room_id: "qa_synthetic_room", brief: "QA_SYNTHETIC_BRIEF" };

test("aborted deadline cannot release a late inference answer", async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const agent = createParentBriefAgent(binding, async ({ signal }) => {
    controller.abort(new DOMException("Synthetic expired deadline", "TimeoutError"));
    assert.equal(signal.aborted, true);
    return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "late synthetic answer" }] };
  });
  const result = await Promise.allSettled([agent.run("Return the bounded brief")]);
  console.log("QA_PARENT_DEADLINE " + JSON.stringify({ signal_aborted: controller.signal.aborted, outcome: result[0].status }));
  assert.equal(result[0].status, "rejected", "late successful completion must not bypass the aborted deadline");
});

test("non-string model text is rejected instead of coerced into buyer output", async () => {
  const agent = createParentBriefAgent(binding, async () => ({ role: "assistant", stopReason: "stop",
    content: [{ type: "text", text: { instruction: "invalid typed provider output" } }] }));
  const result = await Promise.allSettled([agent.run("Return the bounded brief")]);
  console.log("QA_PARENT_TEXT_SHAPE " + JSON.stringify({ outcome: result[0].status, output: result[0].value?.output }));
  assert.equal(result[0].status, "rejected", "invalid model text must not become [object Object]");
});

after(() => { assert.equal(hash(), before, "Candidate changed during review"); console.log("QA_PARENT_SOURCE_SHA256 " + before); });
