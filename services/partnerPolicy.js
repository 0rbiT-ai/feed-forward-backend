const APPROVED = 'APPROVED';
const SUSPENDED = 'SUSPENDED';
const PENDING = 'PENDING';
const REJECTED = 'REJECTED';
const LATE_CANCELLATION_WINDOW_MS = 60 * 60 * 1000;
const LATE_CANCELLATION_PENALTY = 15;
const NO_SHOW_PENALTY = 10;
const STRIKE_LIMIT = 3;

const isActivePartner = (partner) => Boolean(
  partner &&
  partner.approvalStatus === APPROVED &&
  partner.isActive !== false &&
  partner.isVerified !== false
);

const canReserveListing = (listing, requestedPortions) => {
  const requested = Number(requestedPortions);
  const available = Number(listing?.availableServings);
  const safeUntil = listing?.safeUntil ? new Date(listing.safeUntil) : null;

  if (!Number.isInteger(requested) || requested <= 0) {
    return { allowed: false, reason: 'A positive number of portions is required.' };
  }
  if (!listing || !['ACTIVE', 'PARTIALLY_RESERVED'].includes(listing.status)) {
    return { allowed: false, reason: 'This listing is no longer available.' };
  }
  if (!safeUntil || Number.isNaN(safeUntil.getTime()) || safeUntil.getTime() <= Date.now()) {
    return { allowed: false, reason: 'This listing has passed its safe-until window.' };
  }
  if (!Number.isInteger(available) || available < requested) {
    return { allowed: false, reason: `Only ${available || 0} portions are available.` };
  }
  return { allowed: true, reason: null };
};

const isLateCancellation = (pickupDeadline, now = new Date()) => {
  const deadline = pickupDeadline instanceof Date ? pickupDeadline : new Date(pickupDeadline);
  const currentTime = now instanceof Date ? now : new Date(now);
  return Number.isFinite(deadline.getTime()) && deadline.getTime() - currentTime.getTime() < LATE_CANCELLATION_WINDOW_MS;
};

const getPartnerApprovalState = (partner) => {
  if (!partner) return 'MISSING';
  if (partner.approvalStatus === SUSPENDED || partner.isActive === false) return SUSPENDED;
  if (partner.approvalStatus === APPROVED && partner.isVerified !== false) return APPROVED;
  return partner.approvalStatus || PENDING;
};

const getTrustLevel = (karmaScore, strikeCount) => {
  if (strikeCount >= STRIKE_LIMIT) return 'SUSPENDED';
  if (karmaScore >= 500) return 'PLATINUM';
  if (karmaScore >= 250) return 'GOLD';
  if (karmaScore >= 80) return 'VERIFIED';
  return 'NEW';
};

const applyKarmaChange = ({ karmaScore, strikeCount, pointsDelta, action }) => {
  const nextKarma = Math.max(0, Number(karmaScore || 0) + Number(pointsDelta || 0));
  const nextStrikeCount = pointsDelta < 0 && nextKarma < 50 ? Number(strikeCount || 0) + 1 : Number(strikeCount || 0);
  return {
    karmaScore: nextKarma,
    strikeCount: nextStrikeCount,
    suspensionRequired: nextStrikeCount >= STRIKE_LIMIT,
    trustLevel: getTrustLevel(nextKarma, nextStrikeCount),
    action,
  };
};

module.exports = {
  APPROVED,
  SUSPENDED,
  PENDING,
  REJECTED,
  LATE_CANCELLATION_WINDOW_MS,
  LATE_CANCELLATION_PENALTY,
  NO_SHOW_PENALTY,
  STRIKE_LIMIT,
  isActivePartner,
  canReserveListing,
  isLateCancellation,
  getPartnerApprovalState,
  getTrustLevel,
  applyKarmaChange,
};
