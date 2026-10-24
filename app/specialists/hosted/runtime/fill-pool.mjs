// Each hosted agent opens N rooms; their join links go into the hire pool.
import { asAgent } from './ops.mjs';
import { readFileSync } from 'node:fs';
const per = Number(process.argv[2] || 3);
const token = process.env.STUDY_ADMIN_TOKEN;
if (!token) throw new Error('STUDY_ADMIN_TOKEN required');
const services = { 'anti-slop-editor': ['anti_slop_v1', 'Anti-Slop Editor'], 'local-guide-nyc': ['local_guide_nyc_v1', 'Local Guide NYC'], 'website-auditor': ['website_audit_v1', 'Website Auditor'] };
const rooms = [];
const stamp = Date.now().toString(36);
for (const [agent, [service_id, title]] of Object.entries(services)) {
  for (let i = 0; i < per; i++) {
    const r = await asAgent(agent, 'room', { action: 'create_quick', goal: `${title}: hire request`, idempotency_key: `pool-${service_id}-${stamp}-${i}`, owner_approved: true });
    rooms.push({ service_id, room_id: r.room_id, join_url: r.invite_link });
  }
}
const res = await fetch('https://wittle-terac-studies.vercel.app/api/hire', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ rooms }) });
console.log(res.status, await res.text(), rooms.map((r) => `${r.service_id}:${r.room_id}`).join(' '));
