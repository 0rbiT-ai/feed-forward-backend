const crypto = require('crypto');
const OTP_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

const generateOtp = () => crypto.randomInt(1000, 9999).toString().padStart(4, '0');

const createOtpSession = (reservation, attempts = 0) => ({
  reservationId: reservation.id,
  pickupCode: reservation.pickupCode,
  otp: generateOtp(),
  attempts,
  expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
});

const validateOtpAttempt = (session, providedOtp) => {
  if (!session || session.expiresAt.getTime() <= Date.now()) return { valid: false, reason: 'OTP has expired.' };
  if (session.attempts >= MAX_ATTEMPTS) return { valid: false, reason: 'Too many verification attempts. Request a new code.' };
  if (session.otp !== String(providedOtp).trim()) {
    return { valid: false, reason: 'Invalid verification code.', attempts: session.attempts + 1 };
  }
  return { valid: true, reason: null, attempts: session.attempts };
};

module.exports = { OTP_TTL_SECONDS, MAX_ATTEMPTS, generateOtp, createOtpSession, validateOtpAttempt };
