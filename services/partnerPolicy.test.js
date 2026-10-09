const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isActivePartner,
  canReserveListing,
  isLateCancellation,
  getPartnerApprovalState,
  getTrustLevel,
  applyKarmaChange,
} = require('./partnerPolicy');

test('only approved, active, verified partners can reserve', () => {
  assert.equal(isActivePartner({ approvalStatus: 'APPROVED', isActive: true, isVerified: true }), true);
  assert.equal(isActivePartner({ approvalStatus: 'PENDING', isActive: true, isVerified: true }), false);
  assert.equal(isActivePartner({ approvalStatus: 'APPROVED', isActive: false, isVerified: true }), false);
  assert.equal(isActivePartner({ approvalStatus: 'APPROVED', isActive: true, isVerified: false }), false);
  assert.equal(getPartnerApprovalState({ approvalStatus: 'PENDING' }), 'PENDING');
  assert.equal(getPartnerApprovalState(null), 'MISSING');
});

test('reservation eligibility requires a positive available quantity', () => {
  assert.deepEqual(canReserveListing({ status: 'ACTIVE', availableServings: 10, safeUntil: new Date(Date.now() + 3600000) }, 5), {
    allowed: true,
    reason: null,
  });
  assert.equal(canReserveListing({ status: 'ACTIVE', availableServings: 4, safeUntil: new Date(Date.now() + 3600000) }, 5).allowed, false);
  assert.equal(canReserveListing({ status: 'FULLY_RESERVED', availableServings: 0, safeUntil: new Date(Date.now() + 3600000) }, 1).allowed, false);
  assert.equal(canReserveListing({ status: 'ACTIVE', availableServings: 10, safeUntil: new Date(Date.now() - 1) }, 1).allowed, false);
});

test('late cancellation is defined relative to the pickup deadline', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');
  assert.equal(isLateCancellation(new Date('2026-10-08T13:30:00.000Z'), now), false);
  assert.equal(isLateCancellation(new Date('2026-10-08T12:30:00.000Z'), now), true);
  assert.equal(isLateCancellation(new Date('2026-10-08T10:59:59.000Z'), now), true);
});

test('karma changes enforce strike and trust thresholds', () => {
  assert.deepEqual(applyKarmaChange({ karmaScore: 100, strikeCount: 2, pointsDelta: -15, action: 'LATE_CANCELLATION' }), {
    karmaScore: 85,
    strikeCount: 2,
    suspensionRequired: false,
    trustLevel: 'VERIFIED',
    action: 'LATE_CANCELLATION',
  });
  assert.equal(getTrustLevel(500, 0), 'PLATINUM');
  assert.equal(getTrustLevel(100, 3), 'SUSPENDED');
});
