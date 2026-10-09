const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateOtp,
  createOtpSession,
  validateOtpAttempt,
  MAX_ATTEMPTS,
} = require('./otpService');
const {
  APPROVED,
  SUSPENDED,
  PENDING,
  STRIKE_LIMIT,
  isActivePartner,
  canReserveListing,
  isLateCancellation,
  getTrustLevel,
  applyKarmaChange,
} = require('./partnerPolicy');

test('otpService: generates valid 4-digit numeric code', () => {
  const code = generateOtp();
  assert.equal(code.length, 4);
  assert.match(code, /^[0-9]{4}$/);
});

test('otpService: creates session and validates correct OTP', () => {
  const reservation = { id: 101, pickupCode: '4321' };
  const session = createOtpSession(reservation);
  assert.equal(session.reservationId, 101);
  assert.equal(session.attempts, 0);

  // Validate correct OTP
  const result = validateOtpAttempt(session, session.otp);
  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
});

test('otpService: handles incorrect OTP and tracks attempts', () => {
  const reservation = { id: 102, pickupCode: '8888' };
  const session = createOtpSession(reservation);

  const failedResult = validateOtpAttempt(session, '0000');
  assert.equal(failedResult.valid, false);
  assert.equal(failedResult.reason, 'Invalid verification code.');
  assert.equal(failedResult.attempts, 1);
});

test('otpService: enforces maximum attempt rate limit', () => {
  const reservation = { id: 103, pickupCode: '1111' };
  const session = createOtpSession(reservation, MAX_ATTEMPTS);

  const rateLimitResult = validateOtpAttempt(session, session.otp);
  assert.equal(rateLimitResult.valid, false);
  assert.match(rateLimitResult.reason, /Too many verification attempts/);
});

test('otpService: enforces expiration time', () => {
  const reservation = { id: 104, pickupCode: '9999' };
  const session = createOtpSession(reservation);
  session.expiresAt = new Date(Date.now() - 1000); // 1 sec in past

  const expiredResult = validateOtpAttempt(session, session.otp);
  assert.equal(expiredResult.valid, false);
  assert.equal(expiredResult.reason, 'OTP has expired.');
});

test('partnerPolicy: 3 strikes triggers automatic account suspension', () => {
  const state = applyKarmaChange({
    karmaScore: 40,
    strikeCount: 2,
    pointsDelta: -10,
    action: 'NO_SHOW',
  });

  assert.equal(state.strikeCount, 3);
  assert.equal(state.suspensionRequired, true);
  assert.equal(state.trustLevel, 'SUSPENDED');
});

test('partnerPolicy: successful on-time pickup increments karma without strikes', () => {
  const state = applyKarmaChange({
    karmaScore: 90,
    strikeCount: 0,
    pointsDelta: 10,
    action: 'ON_TIME_COLLECTION',
  });

  assert.equal(state.karmaScore, 100);
  assert.equal(state.strikeCount, 0);
  assert.equal(state.suspensionRequired, false);
  assert.equal(state.trustLevel, 'VERIFIED');
});

test('partnerPolicy: listing reservation bounds check rejects expired safeUntil', () => {
  const pastListing = {
    status: 'ACTIVE',
    availableServings: 20,
    safeUntil: new Date(Date.now() - 60000), // 1 min ago
  };
  const result = canReserveListing(pastListing, 5);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /passed its safe-until window/);
});
