// POST /api/hire {service, request_id}        → { join_url, agent, title, price_usd } — one room per request_id (idempotent)
// GET  /api/hire?service=<id>                  → service info only (no allocation)
// GET  /api/hire?room=<room_id>[&scope=<text>] → order for the agent in that room; scope is recorded once before checkout
// GET  /api/hire?pool=1      (admin)           → free/total rooms per service
// PUT  /api/hire             (admin)           → { rooms: [{ service_id, room_id, join_url }] } adds agent-opened rooms
import { WhopClient, WhopEnvironment } from '@whop/sdk';
import { json, isAdmin, readJson } from '../lib/db.mjs';
import { SERVICES, addRooms, claimRoom, orderStatus, poolCounts, isRoomId } from '../lib/hire.mjs';

function whop() {
  const sandbox = process.env.WHOP_SANDBOX === 'true';
  const client = new WhopClient({ token: process.env.WHOP_COMPANY_API_KEY, apiVersionDate: '2026-10-24',
    environment: sandbox ? WhopEnvironment.Sandbox : WhopEnvironment.Production, timeoutInSeconds: 8, maxRetries: 1 });
  client.companyId = process.env.WHOP_COMPANY_ID;
  client.environment = sandbox ? 'sandbox' : 'live';
  return client;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === 'PUT') {
        if (!isAdmin(request)) return json(401, { error: 'unauthorized' });
        return json(200, { added: await addRooms((await readJson(request)).rooms || []) });
      }
      if (request.method === 'POST') {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin && origin !== 'https://wittleagents.com') return json(403, { error: 'forbidden' });
        const { service, request_id } = await readJson(request, 1024);
        const claimed = await claimRoom(service, request_id);
        if (!claimed) return json(503, { error: 'no rooms free right now, try again shortly' });
        const s = SERVICES[service];
        return json(200, { join_url: claimed.join_url, agent: s.agent, title: s.title, price_usd: s.price_usd });
      }
      if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
      if (url.searchParams.get('pool')) {
        if (!isAdmin(request)) return json(401, { error: 'unauthorized' });
        return json(200, { pool: await poolCounts() });
      }
      const room = url.searchParams.get('room');
      if (room) {
        if (!isRoomId(room)) return json(400, { error: 'bad room' });
        if (!process.env.WHOP_COMPANY_API_KEY || !process.env.WHOP_COMPANY_ID) return json(503, { error: 'payments unavailable' });
        const status = await orderStatus(room, whop(), { appUrl: url.origin, scope: url.searchParams.get('scope') });
        return status ? json(200, status) : json(404, { error: 'not a hire room' });
      }
      const service = url.searchParams.get('service');
      if (!SERVICES[service]) return json(400, { error: 'unknown service', services: Object.keys(SERVICES) });
      return json(200, { service, ...SERVICES[service], hire: 'POST /api/hire {service, request_id}' });
    } catch (error) {
      if (error.statusCode === 403) return json(503, { error: 'payments not configured for this service yet' });
      const status = error.status || (error instanceof SyntaxError || /bad|unknown/.test(error.message) ? 400 : 503);
      return json(status, { error: status === 503 ? 'temporarily unavailable' : error.message });
    }
  },
};
