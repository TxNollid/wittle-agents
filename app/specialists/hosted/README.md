# Hosted specialists on @hostedagents

Three public Wittle Rooms agents on the `@hostedagents` account (user `user_01M5QVPNW92H8MXV4MXFV6HKRB`), run by a rooms-relay fleet on Dillon's laptop with headless Claude.

| Agent | ID | Tools |
| --- | --- | --- |
| `@hostedagents.website-auditor` | `agt_Y4aZDcQgPEYtj4A9OOMuiA` | WebFetch |
| `@hostedagents.anti-slop-editor` | `agt_C9kVbknuDL6OXz_cOk7Fmg` | none |
| `@hostedagents.local-guide-nyc` | `agt_ZhRtbhHsTpc_WOIVlxglvw` | WebSearch, WebFetch |

All three are `public`: anyone can see them on https://rooms.wittlelabs.ai/@hostedagents. Bash, file read/write, Glob, Grep and Task are denied in each agent's `.claude/settings.json`.

## How a stranger reaches an agent

Rooms invites and consults need a connected contact, so strangers come in by link: the agent opens a room (`room create_quick`, no invite) and the returned `invite_link` is given to the buyer, who joins without any contact request. Verified 24 Oct with `@dillon` as a non-contact: join → message → agent reply in ~15 s.

## Files

- `SHARED.md`, `<agent>/CLAUDE.md`, `<agent>/.claude/settings.json`: instructions and tool permissions (source).
- `build.mjs`: inlines them into `~/.wittle-rooms/hostedagents/agents/<agent>/`, outside the project tree so the owner's CLAUDE.md files never reach buyer-facing agents.
- `runtime/claude-wrapper.sh`: relay → Claude shim (prompt via stdin because `--mcp-config` is variadic in Claude CLI 2.1.x; agent CLAUDE.md passed with `--append-system-prompt` because headless runs didn't load it).
- `runtime/login.mjs`: forced fresh OAuth sign-in for the fleet home (prints the link; open it in a private window).
- `runtime/ops.mjs`: owner operations as an agent (`public`, `call <agent> <tool> <json>`).

## Run

```sh
node app/specialists/hosted/build.mjs
ROOMS_RELAY_HOME=~/.wittle-rooms/hostedagents/relay \
WITTLE_CLAUDE_BIN=~/.wittle-rooms/hostedagents/claude-wrapper.sh \
  node ~/.wittle-rooms/cli/lib/node_modules/@wittlelabs/rooms-relay/bin.mjs start
```

After changing instructions, stop the relay and remove `sessionId` from `relay/agents.json`, or resumed sessions keep old behavior. Agents answer only while the relay runs and the laptop is awake.

## Hiring and payment

- `GET https://wittle-terac-studies.vercel.app/api/hire?service=<id>` hands one buyer a fresh agent-opened room (`&go=1` redirects). Pool filled by `runtime/fill-pool.mjs [per-agent]`.
- In the room the agent fetches `/api/hire?room=<room_id>` for price, Whop checkout link and `paid`, confirmed from Whop payments by `order_id` metadata. Paid work starts only on `paid: true`.
- Source: `../studies-site/api/hire.mjs`, `../studies-site/lib/hire.mjs`.
- Whop: the company key can't create or read plans (403 on `plan:create`, `plan:basic:read`). Set one-time plan IDs as Vercel env `WHOP_PLAN_ANTI_SLOP_V1`, `WHOP_PLAN_LOCAL_GUIDE_NYC_V1`, `WHOP_PLAN_WEBSITE_AUDIT_V1`, or add the scope so inline prices work. Currently sandbox (`WHOP_SANDBOX=true`).

## Not done

- The Concierge doesn't call `/api/hire` yet (asked terac-codex).
- After instruction changes, any other relay host (GCP) must rebuild from `build.mjs` and use `runtime/claude-wrapper.sh`.
