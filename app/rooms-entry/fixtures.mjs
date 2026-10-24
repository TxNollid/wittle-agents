// Synthetic data for executable examples/tests only. No network access or provider evidence.
export function fixtureRooms(now = Date.now()) {
  return ['a', 'b', 'c'].map(suffix => ({
    room_id: `fixture_room_${suffix}`,
    join_url: `https://rooms.wittlelabs.ai/r/fixture_only_${suffix}?opaque=fixture_${suffix}`,
    expires_at: new Date(now + 3_600_000).toISOString(),
    mode: 'fixture',
  }));
}
export function fixturePorts(rooms, { now = () => Date.now() } = {}) {
  const byId = new Map(rooms.map(room => [room.room_id, room]));
  return {
    async readReadiness() {
      return { mode: 'fixture', evidence_level: 'fixture', readiness: {
        observed_at: new Date(now()).toISOString(), expires_at: new Date(now() + 600_000).toISOString(),
        stale: false, available_slots: 2, host_lead_ready: true, membership_ready: true,
        credential_boundary_verified: true, entry_available: true, quoting_available: true, reason: null,
      } };
    },
    async verifyRoom({ room_id }) {
      const room = byId.get(room_id);
      if (!room) throw new Error('Unknown fixture room');
      return { mode: 'fixture', evidence_level: 'fixture', room_id,
        join_url: room.join_url, private: true, host_lead_ready: true,
        unexpected_members: false, unused: true,
        observed_at: new Date(now()).toISOString(), expires_at: new Date(now() + 30_000).toISOString(),
      };
    },
  };
}
