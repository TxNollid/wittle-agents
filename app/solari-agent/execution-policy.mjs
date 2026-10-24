// This module deliberately has no filesystem, process-launch, auth or network
// dependencies. A buyer request must stop here before entering the legacy CLI.
export function executionAudience(config = {}) {
  return config.AGENT_AUDIENCE || 'unconfigured';
}

export function buyerRuntimeUnavailable() {
  const error = new Error('Buyer execution is unavailable: the credential boundary has not been verified.');
  error.status = 503;
  error.code = 'RUNTIME_UNAVAILABLE';
  error.reason = 'credential_boundary_unverified';
  return error;
}

export function assertTrustedDevelopment(config = {}) {
  if (executionAudience(config) !== 'trusted-development') throw buyerRuntimeUnavailable();
}

export function assertTrustedRoom(config, roomId) {
  assertTrustedDevelopment(config);
  const allowed = String(config.TRUSTED_ROOM_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  // Admission to a new room does not authorize subscription-backed shell use.
  if (!roomId || !allowed.includes(roomId)) throw buyerRuntimeUnavailable();
}

// wa-v2.1-runtime.1 negative readiness, suitable for the server-only
// rooms-entry readReadiness port. The expiry is the freshness of this NEGATIVE
// observation, not a VM-lifetime attestation. There is no enabling flag.
export function readBuyerReadiness(now = Date.now()) {
  return {
    observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30_000).toISOString(),
    stale: false,
    available_slots: null,
    host_lead_ready: false,
    membership_ready: false,
    credential_boundary_verified: false,
    entry_available: false,
    quoting_available: false,
    reason: 'credential_boundary_unverified',
  };
}
