import { loadConfig } from "./server.mjs";
import { randomUUID } from "node:crypto";
const config = loadConfig();
const [quoteId, quoteHash] = process.argv.slice(2);
if (!quoteId || !quoteHash || !process.env.PAYMENTS_BUYER_TOKEN)
  throw new Error(
    "Usage: PAYMENTS_BUYER_TOKEN=<private buyer token> npm run checkout -- QUOTE_ID QUOTE_HASH. Both parties must first approve.",
  );
const response = await fetch(
  "http://127.0.0.1:" + (config.PAYMENTS_PORT || 3210) + "/api/checkout",
  {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.PAYMENTS_BUYER_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      quote_id: quoteId,
      quote_hash: quoteHash,
      request_id: randomUUID(),
    }),
  },
);
const result = await response.json();
if (!response.ok) throw new Error(result.error);
console.log(
  JSON.stringify(
    {
      order_id: result.id,
      state: result.workflow_status,
      purchase_url: result.purchase_url,
    },
    null,
    2,
  ),
);
