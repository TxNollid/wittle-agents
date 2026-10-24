import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const result = spawnSync(process.execPath, ["--test", "controller.test.mjs"], {
  cwd: new URL(".", import.meta.url),
  encoding: "utf8",
});
const output = result.stdout || "";
const report = {
  checked_at: new Date().toISOString(),
  source: "product/diagrams/source-sequence.mmd",
  mode: "Controller integration tests with simulated external providers",
  controller_contracts: {
    passed: Number(output.match(/# pass (\d+)/)?.[1] || 0),
    failed: Number(output.match(/# fail (\d+)/)?.[1] || 0),
    exit_code: result.status,
  },
  live_gates: [
    {
      gate: "Human approval and completed real Whop sandbox payment",
      status: "pending",
    },
    {
      gate: "Persistent Rooms provisioning adapter and verified buyer/seller seat mapping",
      status: "not_connected",
    },
    {
      gate: "Specialist worker consumes run-scoped token and cost reservations",
      status: "not_connected",
    },
    {
      gate: "Public buyer sign-in maps to controller principals",
      status: "not_implemented",
    },
    {
      gate: "Stable production hosting and account readiness",
      status: "not_enabled",
    },
  ],
};
writeFileSync(
  new URL("../../sandbox/whop-controller-audit.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
// Contract tests can pass while deployment readiness is still incomplete.
process.exitCode = result.status === 0 ? 2 : 1;
