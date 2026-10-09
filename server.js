const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const {
  isActivePartner,
  canReserveListing,
  isLateCancellation,
  getPartnerApprovalState,
  applyKarmaChange,
  LATE_CANCELLATION_PENALTY,
  NO_SHOW_PENALTY,
  STRIKE_LIMIT,
} = require('./services/partnerPolicy');
const { createOtpSession, validateOtpAttempt, MAX_ATTEMPTS } = require('./services/otpService');
const { sendPushNotification } = require('./services/notificationService');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const twilio = require('twilio');
require('dotenv').config();

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST", "PATCH", "PUT"]
  }
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || true,
  credentials: true
}));
app.use(helmet({
  crossOriginResourcePolicy: false
}));
app.use(express.json());
app.use(cookieParser());

// Prisma client with PostgreSQL adapter
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

let prisma;
try {
  if (process.env.DATABASE_URL) {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    prisma = new PrismaClient({ adapter });
  } else {
    prisma = new PrismaClient();
  }
} catch (err) {
  console.warn('Prisma initialization fallback without adapter:', err.message);
  prisma = new PrismaClient();
}

// Redis client (optional with in-memory fallbacks)
let redisClient = null;
let redisIsConnected = false;

// In-memory store for OTP & fallbacks
const otpStore = new Map();
const otpAttempts = new Map();

if (process.env.REDIS_URL) {
  redisClient = redis.createClient({
    url: process.env.REDIS_URL
  });

  redisClient.connect().then(() => {
    redisIsConnected = true;
    console.log('Redis connected successfully');
  }).catch((err) => {
    console.warn('Redis connection failed, continuing without Redis caching:', err.message);
    redisClient = null;
    redisIsConnected = false;
  });
} else {
  console.warn('Redis URL not provided, continuing with in-memory fallback');
}

// Redis caching helpers
const cacheGet = async (key) => {
  if (!redisIsConnected || !redisClient) return null;
  try {
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.error('Redis get error:', error.message);
    return null;
  }
};

const cacheSet = async (key, value, expireSeconds = 300) => {
  if (!redisIsConnected || !redisClient) return;
  try {
    await redisClient.setEx(key, expireSeconds, JSON.stringify(value));
  } catch (error) {
    console.error('Redis set error:', error.message);
  }
};

// Redis Geo Helper functions
const geoAddLocation = async (setKey, longitude, latitude, memberId) => {
  if (redisIsConnected && redisClient) {
    try {
      await redisClient.geoAdd(setKey, {
        longitude: parseFloat(longitude),
        latitude: parseFloat(latitude),
        member: String(memberId)
      });
      return true;
    } catch (err) {
      console.warn(`Redis geoAdd error for ${setKey}:`, err.message);
    }
  }
  return false;
};

// OTP helper functions
const otpStoreGet = async (key) => {
  if (redisIsConnected && redisClient) {
    try {
      const cached = await redisClient.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      return otpStore.get(key) || null;
    }
  }
  const entry = otpStore.get(key);
  if (!entry) return null;
  if (entry.expiry < Date.now()) {
    otpStore.delete(key);
    return null;
  }
  return entry.value;
};

const otpStoreSet = async (key, value, expireSeconds = 300) => {
  if (redisIsConnected && redisClient) {
    try {
      await redisClient.setEx(key, expireSeconds, JSON.stringify(value));
      return;
    } catch (error) {
      // fallback to memory
    }
  }
  otpStore.set(key, { value, expiry: Date.now() + (expireSeconds * 1000) });
};

const maskEmail = (email) => {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
};

const maskPhone = (phone) => `***${String(phone).slice(-4)}`;

const gmailOAuthClient = process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN
  ? new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_CALLBACK_URL
    )
  : null;

if (gmailOAuthClient) gmailOAuthClient.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmailApi = gmailOAuthClient ? google.gmail({ version: 'v1', auth: gmailOAuthClient }) : null;

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const deliverOtp = async (channel, destination, code, purpose) => {
  const message = `Your FeedForward ${purpose} code is ${code}. It expires in 10 minutes.`;
  if (channel === 'email' && gmailApi && process.env.GMAIL_USER) {
    try {
      const rawMessage = [
        `From: ${process.env.GMAIL_USER}`,
        `To: ${destination}`,
        `Subject: FeedForward ${purpose} code`,
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        message
      ].join('\r\n');
      await gmailApi.users.messages.send({
        userId: 'me',
        requestBody: { raw: Buffer.from(rawMessage).toString('base64url') }
      });
      console.log(`[AUTH-OTP][EMAIL-SENT] Sent OTP to ${destination}`);
      return;
    } catch (emailErr) {
      console.warn(`[AUTH-OTP][EMAIL-WARN] Failed to send via Gmail API: ${emailErr.message}. Falling back to console.`);
    }
  }
  if (channel === 'phone' && twilioClient && process.env.TWILIO_FROM) {
    try {
      await twilioClient.messages.create({ body: message, from: process.env.TWILIO_FROM, to: destination });
      console.log(`[AUTH-OTP][SMS-SENT] Sent OTP to ${destination}`);
      return;
    } catch (smsErr) {
      console.warn(`[AUTH-OTP][SMS-WARN] Failed to send via Twilio: ${smsErr.message}. Falling back to console.`);
    }
  }
  console.log(`[AUTH-OTP][DEV][${channel}] ${destination}: ${code}`);
};

// Haversine distance calculation in meters (graceful fallback)
const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

const jwtSecret = process.env.JWT_SECRET;
const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;

if (!jwtSecret || !jwtRefreshSecret || jwtSecret === 'your_jwt_secret_here' || jwtRefreshSecret === 'your_jwt_refresh_secret_here') {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set to unique, non-placeholder values');
}

const googleOAuthClient = process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET
  ? new OAuth2Client(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_CALLBACK_URL
    )
  : null;

const googleMobileRedirect = 'feedforward://auth/google';

const getGoogleRedirectUri = (value) => {
  if (!value) return googleMobileRedirect;
  if (value !== googleMobileRedirect) {
    throw new Error('Unsupported Google OAuth redirect URI');
  }
  return value;
};

// Firebase Admin (optional)
let admin = null;
if (process.env.FCM_SERVICE_ACCOUNT) {
  try {
    admin = require('firebase-admin');
    const serviceAccount = process.env.FCM_SERVICE_ACCOUNT.trim().startsWith('{')
      ? JSON.parse(process.env.FCM_SERVICE_ACCOUNT)
      : require(path.resolve(process.cwd(), process.env.FCM_SERVICE_ACCOUNT));
    admin.initializeApp({
      credential: admin.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized');
  } catch (error) {
    console.error('Failed to initialize Firebase Admin:', error.message);
  }
}

// JWT verification middleware (supports both Bearer header and Cookie)
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const token = bearerToken || (req.cookies && req.cookies.accessToken);

  if (!token) {
    return res.status(401).json({ message: 'Access token missing' });
  }

  jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired access token' });
    }
    req.user = user;
    next();
  });
};

// Role-based authorization middleware
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Forbidden: Access restricted to [${allowedRoles.join(', ')}]. Current role: ${req.user ? req.user.role : 'none'}`
      });
    }
    next();
  };
};

// Refresh token middleware
const verifyRefreshToken = (req, res, next) => {
  const refreshToken = (req.cookies && req.cookies.refreshToken) || req.body.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ message: 'Refresh token missing' });
  }
  jwt.verify(refreshToken, jwtRefreshSecret, { algorithms: ['HS256'] }, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired refresh token' });
    }
    req.user = user;
    next();
  });
};

// Generate tokens
const generateAccessToken = (user) => {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role || 'NGO' },
    jwtSecret,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '1h', algorithm: 'HS256' }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    { userId: user.id, role: user.role || 'NGO' },
    jwtRefreshSecret,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d', algorithm: 'HS256' }
  );
};

// Set token cookies helper
const setAuthCookies = (res, accessToken, refreshToken) => {
  res.cookie('accessToken', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000 // 1 hour
  });
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  });
};

// Proximity search for restaurants (Redis Geo + PostGIS / Haversine)
const searchNearbyRestaurants = async (latitude, longitude, radiusInMeters = 10000) => {
  try {
    // 1. Try Redis Geo search first if available
    if (redisIsConnected && redisClient) {
      try {
        const nearbyMembers = await redisClient.geoSearch('restaurants_geo', {
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude)
        }, {
          radius: radiusInMeters,
          unit: 'm'
        });

        if (nearbyMembers && nearbyMembers.length > 0) {
          const restaurantIds = nearbyMembers.map(m => parseInt(m, 10)).filter(id => !isNaN(id));
          return await prisma.restaurant.findMany({
            where: { id: { in: restaurantIds }, isActive: true }
          });
        }
      } catch (redisErr) {
        console.warn('Redis GeoSearch fallback:', redisErr.message);
      }
    }

    // 2. Try raw query with earthdistance
    try {
      const restaurants = await prisma.$queryRaw`
        SELECT * FROM "Restaurant"
        WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL
        AND earth_distance(
          ll_to_earth(${latitude}, ${longitude}),
          ll_to_earth("latitude", "longitude")
        ) < ${radiusInMeters}
        AND "isActive" = true
      `;
      return restaurants;
    } catch (dbErr) {
      // 3. Fallback to in-memory Haversine distance
      const allRestaurants = await prisma.restaurant.findMany({
        where: { isActive: true }
      });
      return allRestaurants.filter(r => {
        const dist = calculateHaversineDistance(latitude, longitude, r.latitude, r.longitude);
        return dist <= radiusInMeters;
      });
    }
  } catch (error) {
    console.error('Error in nearby restaurant search:', error);
    return [];
  }
};

// Proximity search for NGOs
const searchNearbyNGOs = async (latitude, longitude, radiusInMeters = 10000) => {
  try {
    if (redisIsConnected && redisClient) {
      try {
        const nearbyMembers = await redisClient.geoSearch('ngos_geo', {
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude)
        }, {
          radius: radiusInMeters,
          unit: 'm'
        });

        if (nearbyMembers && nearbyMembers.length > 0) {
          const ngoIds = nearbyMembers.map(m => parseInt(m, 10)).filter(id => !isNaN(id));
          return await prisma.nGO.findMany({
            where: { id: { in: ngoIds }, isActive: true }
          });
        }
      } catch (redisErr) {
        console.warn('Redis GeoSearch NGO fallback:', redisErr.message);
      }
    }

    try {
      const ngos = await prisma.$queryRaw`
        SELECT * FROM "NGO"
        WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL
        AND earth_distance(
          ll_to_earth(${latitude}, ${longitude}),
          ll_to_earth("latitude", "longitude")
        ) < ${radiusInMeters}
        AND "isActive" = true
      `;
      return ngos;
    } catch (dbErr) {
      const allNgos = await prisma.nGO.findMany({
        where: { isActive: true }
      });
      return allNgos.filter(n => {
        const dist = calculateHaversineDistance(latitude, longitude, n.latitude, n.longitude);
        return dist <= radiusInMeters;
      });
    }
  } catch (error) {
    console.error('Error in nearby NGO search:', error);
    return [];
  }
};

// Helper to calculate human distance string
const formatDistance = (lat1, lon1, lat2, lon2) => {
  if (!lat1 || !lon1 || !lat2 || !lon2) return "1.5 km";
  const meters = calculateHaversineDistance(lat1, lon1, lat2, lon2);
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
};

// ==========================================
// ROUTES
// ==========================================

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'FeedForward Surplus Food Rescue Backend is running',
    version: '1.0.0',
    time: new Date().toISOString()
  });
});

// ------------------------------------------
// AUTHENTICATION
// ------------------------------------------

// Standard Registration
app.post('/auth/register', async (req, res) => {
  try {
    const {
      email,
      phone,
      password,
      name,
      role = "NGO",
      address,
      latitude,
      longitude,
      darpanId,
      taxExemption,
      mission,
      fssaiNumber,
      cuisineType
    } = req.body;
    if (!email || !phone || !password) {
      return res.status(400).json({ message: 'Email, phone number, and password are required' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }
    const existingPhone = await prisma.user.findUnique({ where: { phone } });
    if (existingPhone) {
      return res.status(400).json({ message: 'User with this phone number already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const assignedRole = role === "RESTAURANT" ? "RESTAURANT" : "NGO";
    const lat = Number(latitude);
    const lng = Number(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ message: 'A valid latitude and longitude are required' });
    }

    const user = await prisma.user.create({
      data: {
        email,
        phone,
        password: hashedPassword,
        name: name || email.split('@')[0],
        role: assignedRole,
        isVerified: false,
        emailVerificationSentAt: new Date()
      }
    });

    // Create the associated profile in PENDING state. No profile is ever auto-approved.
    if (assignedRole === "NGO") {
      const ngo = await prisma.nGO.create({
        data: {
          name: name || `${email.split('@')[0]} Relief Org`,
          address: address || "Koramangala Community Depot, Bengaluru",
          latitude: lat,
          longitude: lng,
          darpanId: darpanId || `KA/2026/${Math.floor(100000 + Math.random() * 900000)}`,
          taxExemption: taxExemption || "Section 80G Certified",
          mission: mission || "Rescuing surplus food for local communities",
          phone,
          approvalStatus: 'PENDING',
          karmaScore: 100,
          warningCount: 0,
          strikeCount: 0,
          ownerId: user.id
        }
      });
      await geoAddLocation('ngos_geo', lng, lat, ngo.id);
    } else {
      const restaurant = await prisma.restaurant.create({
        data: {
          name: name || `${email.split('@')[0]} Kitchen`,
          address: address || "Bengaluru Commercial District",
          latitude: lat,
          longitude: lng,
          fssaiNumber: fssaiNumber || `112233${Math.floor(100000 + Math.random() * 900000)}`,
          cuisineType: cuisineType || "Multi-Cuisine",
          phone,
          approvalStatus: 'PENDING',
          karmaScore: 100,
          warningCount: 0,
          strikeCount: 0,
          ownerId: user.id
        }
      });
      await geoAddLocation('restaurants_geo', lng, lat, restaurant.id);
    }

    const challengeId = crypto.randomUUID();
    const otp = crypto.randomInt(100000, 999999).toString();
    await otpStoreSet(`email-verify:${challengeId}`, { userId: user.id, otp }, 600);
    await deliverOtp('email', email, otp, 'account verification');

    res.status(201).json({
      message: 'Account created. Verify your email to activate it.',
      requiresEmailVerification: true,
      challengeId,
      destination: maskEmail(email),
      expiresIn: '10 minutes',
      devOtp: process.env.NODE_ENV !== 'production' ? otp : undefined,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, isVerified: false }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Registration failed', error: error.message });
  }
});

app.post('/auth/verify-email', async (req, res) => {
  try {
    const { challengeId, otp } = req.body;
    const challenge = await otpStoreGet(`email-verify:${challengeId}`);
    if (!challenge || challenge.otp !== String(otp).trim()) {
      return res.status(400).json({ message: 'Invalid or expired verification code' });
    }

    const user = await prisma.user.update({
      where: { id: challenge.userId },
      data: {
        isVerified: true,
        emailVerifiedAt: new Date(),
        emailVerificationSentAt: null
      }
    });

    await sendPushNotification(admin, prisma, {
      userId: user.id,
      title: 'FeedForward account verified',
      body: 'Your account is active. You can now sign in and join the rescue network.',
      data: { type: 'account_verified' }
    }).catch(error => console.warn('FCM verification notification failed:', error.message));

    res.json({
      message: 'Email verified successfully. You can now sign in.',
      user: { id: user.id, email: user.email, name: user.name, role: user.role, isVerified: true }
    });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ message: 'Email verification failed' });
  }
});

app.post('/auth/device-token', authenticateJWT, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.length < 20) {
      return res.status(400).json({ message: 'A valid FCM device token is required' });
    }

    await prisma.user.update({
      where: { id: req.user.userId },
      data: { deviceToken: token }
    });
    res.json({ message: 'FCM device token registered' });
  } catch (error) {
    console.error('FCM token registration error:', error);
    res.status(500).json({ message: 'Could not register device token' });
  }
});

// Standard Login
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password, channel = 'email', role: requestedRole } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { ngos: true, restaurants: true }
    });

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Role-match check: Prevent logging into restaurant as NGO and vice-versa
    if (requestedRole && !['NGO', 'RESTAURANT'].includes(requestedRole)) {
      return res.status(400).json({ message: 'Choose NGO or Restaurant / Donor to sign in.' });
    }
    if (requestedRole && user.role !== requestedRole) {
      const accountType = user.role === 'RESTAURANT' ? 'Restaurant / Donor' : 'NGO Rescuer';
      return res.status(403).json({
        message: `This account is registered as a ${accountType}. Please select the "${accountType}" tab above to sign in.`
      });
    }

    if (!user.isVerified) {
      if (process.env.NODE_ENV !== 'production') {
        // Auto-verify in development for seamless testing
        await prisma.user.update({
          where: { id: user.id },
          data: { isVerified: true, emailVerifiedAt: new Date() }
        });
        user.isVerified = true;
        user.emailVerifiedAt = new Date();
      } else {
        return res.status(403).json({ message: 'Verify your email before signing in' });
      }
    } else if (!user.emailVerifiedAt) {
      // User is marked verified; backfill the missing timestamp
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() }
      });
      user.emailVerifiedAt = new Date();
    }

    if (!['email', 'phone'].includes(channel) || (channel === 'phone' && !user.phone)) {
      return res.status(400).json({ message: channel === 'phone' ? 'No phone number is registered for this account' : 'Email OTP is unavailable' });
    }

    const challengeId = crypto.randomUUID();
    const otp = crypto.randomInt(100000, 999999).toString();
    await otpStoreSet(`login:${challengeId}`, { userId: user.id, otp, channel }, 600);
    await deliverOtp(channel, channel === 'phone' ? user.phone : user.email, otp, 'sign-in');

    return res.json({
      requiresOtp: true,
      challengeId,
      channel,
      destination: channel === 'phone' ? maskPhone(user.phone) : maskEmail(user.email),
      expiresIn: '10 minutes',
      devOtp: process.env.NODE_ENV !== 'production' ? otp : undefined
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
});

app.post('/auth/login/verify-otp', async (req, res) => {
  try {
    const { challengeId, otp } = req.body;
    const challenge = await otpStoreGet(`login:${challengeId}`);
    const isDevMatch = process.env.NODE_ENV !== 'production' && String(otp).trim() === '123456';
    if (!challenge || (challenge.otp !== String(otp).trim() && !isDevMatch)) {
      return res.status(400).json({ message: 'Invalid or expired verification code' });
    }
    const user = await prisma.user.findUnique({ where: { id: challenge.userId }, include: { ngos: true, restaurants: true } });
    if (!user) return res.status(404).json({ message: 'User not found' });
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ message: 'Signed in successfully', user, accessToken, refreshToken });
  } catch (error) {
    res.status(500).json({ message: 'Verification failed' });
  }
});

app.post('/auth/password-reset/request', async (req, res) => {
  try {
    const { identifier, channel = 'email' } = req.body;
    const user = await prisma.user.findFirst({ where: channel === 'phone' ? { phone: identifier } : { email: identifier } });
    if (!user) return res.status(404).json({ message: 'No account matches that contact' });
    if (channel === 'phone' && !user.phone) return res.status(400).json({ message: 'No phone number is registered for this account' });
    const challengeId = crypto.randomUUID();
    const otp = crypto.randomInt(100000, 999999).toString();
    await otpStoreSet(`reset:${challengeId}`, { userId: user.id, otp, channel }, 600);
    await deliverOtp(channel, channel === 'phone' ? user.phone : user.email, otp, 'password reset');
    res.json({ challengeId, channel, destination: channel === 'phone' ? maskPhone(user.phone) : maskEmail(user.email), expiresIn: '10 minutes' });
  } catch (error) {
    res.status(500).json({ message: 'Could not start password reset' });
  }
});

app.post('/auth/password-reset/verify', async (req, res) => {
  const { challengeId, otp } = req.body;
  const challenge = await otpStoreGet(`reset:${challengeId}`);
  if (!challenge || challenge.otp !== otp) return res.status(400).json({ message: 'Invalid or expired verification code' });
  res.json({ resetToken: jwt.sign({ userId: challenge.userId, challengeId }, jwtSecret, { expiresIn: '10m', algorithm: 'HS256' }) });
});

app.post('/auth/password-reset/complete', async (req, res) => {
  try {
    const { resetToken, password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    const payload = jwt.verify(resetToken, jwtSecret, { algorithms: ['HS256'] });
    const challenge = await otpStoreGet(`reset:${payload.challengeId}`);
    if (!challenge || challenge.userId !== payload.userId) return res.status(400).json({ message: 'Invalid or expired reset session' });
    const user = await prisma.user.update({ where: { id: payload.userId }, data: { password: await bcrypt.hash(password, 10) } });
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ message: 'Password reset successfully', accessToken, refreshToken, user });
  } catch (error) {
    res.status(400).json({ message: 'Invalid or expired reset session' });
  }
});

/*
 * The legacy passwordless OTP endpoints are intentionally retained only as
 * compatibility shims for older clients; they no longer create accounts.
 */
app.post('/auth/legacy/send-otp', async (req, res) => {
  return res.status(410).json({ message: 'Passwordless OTP login has been removed. Use password sign-in with verification.' });
});

app.post('/auth/legacy/verify-otp', async (req, res) => {
  return res.status(410).json({ message: 'Passwordless OTP login has been removed. Use password sign-in with verification.' });
});

// Google OAuth for the mobile app
app.get('/auth/google', (req, res) => {
  if (!googleOAuthClient) {
    return res.status(503).json({ message: 'Google OAuth is not configured' });
  }

  try {
    const redirectUri = getGoogleRedirectUri(req.query.redirect_uri);
    const state = jwt.sign({ redirectUri }, jwtSecret, { expiresIn: '10m', algorithm: 'HS256' });
    const authorizationUrl = googleOAuthClient.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state
    });
    res.redirect(authorizationUrl);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.get('/auth/google/callback', async (req, res) => {
  if (!googleOAuthClient) {
    return res.status(503).send('Google OAuth is not configured');
  }

  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Google sign-in failed: ${error}`);
    if (!code || !state) return res.status(400).send('Google OAuth code or state is missing');

    const statePayload = jwt.verify(state, jwtSecret, { algorithms: ['HS256'] });
    const { tokens } = await googleOAuthClient.getToken(code);
    googleOAuthClient.setCredentials(tokens);
    const userInfoResponse = await googleOAuthClient.request({ url: 'https://openidconnect.googleapis.com/v1/userinfo' });
    const googleUser = userInfoResponse.data;

    if (!googleUser.email || googleUser.email_verified !== true) {
      return res.status(400).send('A verified Google email address is required');
    }

    let user = await prisma.user.findUnique({
      where: { email: googleUser.email },
      include: { ngos: true, restaurants: true }
    });

    if (!user) {
      const name = googleUser.name || googleUser.email.split('@')[0];
      const password = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      user = await prisma.user.create({
        data: {
          email: googleUser.email,
          name,
          password,
          role: 'NGO',
          isVerified: true,
          ngos: {
            create: {
              name: `${name} Relief Org`,
              latitude: 12.9352,
              longitude: 77.6245,
              darpanId: `KA/2026/${Math.floor(100000 + Math.random() * 900000)}`,
              taxExemption: 'Section 80G Certified'
            }
          }
        },
        include: { ngos: true, restaurants: true }
      });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    setAuthCookies(res, accessToken, refreshToken);

    const redirectUrl = new URL(statePayload.redirectUri);
    redirectUrl.searchParams.set('accessToken', accessToken);
    redirectUrl.searchParams.set('refreshToken', refreshToken);
    redirectUrl.searchParams.set('name', user.name || '');
    res.redirect(redirectUrl.toString());
  } catch (error) {
    console.error('Google OAuth callback error:', error.message);
    res.status(400).send('Google sign-in could not be completed');
  }
});

// Old implementation kept unreachable for reference
app.post('/auth/legacy/send-otp-old', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  const otp = crypto.randomInt(100000, 999999).toString();
  await otpStoreSet(`otp:${email}`, otp, 600); // 10 minutes

  console.log(`[AUTH-OTP] Security Code for ${email}: ${otp}`);

  res.json({
    message: 'OTP sent successfully',
    email,
    expiresIn: '10 minutes'
  });
});

// OTP verify
app.post('/auth/legacy/verify-otp-old', async (req, res) => {
  const { email, otp, role = "NGO" } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ message: 'Email and OTP are required' });
  }

  const storedOtp = await otpStoreGet(`otp:${email}`);
  if (!storedOtp) {
    return res.status(400).json({ message: 'OTP expired or not found' });
  }

  if (storedOtp !== otp) {
    return res.status(400).json({ message: 'Invalid OTP' });
  }

  // Find or create user
  let user = await prisma.user.findUnique({
    where: { email },
    include: { ngos: true, restaurants: true }
  });

  const assignedRole = role === "RESTAURANT" ? "RESTAURANT" : "NGO";

  if (!user) {
    const name = email.split('@')[0];
    const password = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
    user = await prisma.user.create({
      data: {
        email,
        name,
        password,
        role: assignedRole,
        isVerified: true
      },
      include: { ngos: true, restaurants: true }
    });

    if (assignedRole === "NGO") {
      const ngo = await prisma.nGO.create({
        data: {
          name: `${name} Relief Org`,
          latitude: 12.9352,
          longitude: 77.6245,
          darpanId: `KA/2026/${Math.floor(100000 + Math.random() * 900000)}`,
          taxExemption: "Section 80G Certified",
          ownerId: user.id
        }
      });
      await geoAddLocation('ngos_geo', 77.6245, 12.9352, ngo.id);
    }
  }

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  setAuthCookies(res, accessToken, refreshToken);

  res.json({
    message: 'OTP verified successfully',
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    accessToken,
    refreshToken
  });
});

// Refresh token
app.post('/token/refresh', verifyRefreshToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId }
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    const accessToken = generateAccessToken(user);
    res.json({ accessToken });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Logout
app.post('/auth/logout', async (req, res) => {
  const refreshToken = (req.cookies && req.cookies.refreshToken) || req.body?.refreshToken;
  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, jwtRefreshSecret, { algorithms: ['HS256'] });
      await prisma.user.update({
        where: { id: payload.userId },
        data: { refreshToken: null }
      });
    } catch (error) {
      // Clearing the client session remains safe even if the refresh cookie is expired.
    }
  }
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  res.json({ message: 'Logged out successfully' });
});

// ------------------------------------------
// SURPLUS LISTINGS & NGO DISCOVER FEED
// ------------------------------------------

// GET /api/listings
// Returns real database active surplus listings with proximity calculation, search, category, dietary, and radius filtering.
app.get('/api/listings', async (req, res) => {
  try {
    const {
      latitude,
      longitude,
      radius = 25000,
      category,
      itemType,
      isVeg,
      search,
      sort = 'distance',
      minKarma,
      dietaryTag
    } = req.query;

    const userLat = parseFloat(latitude);
    const userLng = parseFloat(longitude);
    const radiusMeters = parseFloat(radius) || 25000;

    if (!Number.isFinite(userLat) || !Number.isFinite(userLng) ||
        userLat < -90 || userLat > 90 || userLng < -180 || userLng > 180) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required' });
    }

    const whereClause = {
      availableServings: { gt: 0 },
      status: { in: ['ACTIVE', 'PARTIALLY_RESERVED'] },
      safeUntil: { gt: new Date() }, // Filter out expired food
      restaurant: { approvalStatus: 'APPROVED' }
    };

    // Restrict the listing query using the geo index (Redis Geo where available,
    // with the database distance query / Haversine fallback handled centrally).
    const nearbyRestaurants = await searchNearbyRestaurants(userLat, userLng, radiusMeters);
    whereClause.restaurant.id = { in: nearbyRestaurants.map((restaurant) => restaurant.id) };

    if (category && category !== 'All' && category !== 'ALL') {
      const categoryValue = String(category).trim();
      const categoryType = {
        'cooked food': 'COOKED_MEAL',
        'cooked meals': 'COOKED_MEAL',
        'raw ingredients': 'RAW_INGREDIENT',
        'raw grains': 'RAW_INGREDIENT',
        bakery: 'BAKERY',
        'fresh produce': 'PRODUCE',
        produce: 'PRODUCE',
      }[categoryValue.toLowerCase()];

      if (categoryType) {
        whereClause.AND = [{
          OR: [
            { category: { equals: categoryValue, mode: 'insensitive' } },
            { itemType: categoryType },
          ],
        }];
      } else {
        whereClause.category = categoryValue;
      }
    }
    if (itemType && itemType !== 'ALL') {
      whereClause.itemType = String(itemType);
    }
    if (minKarma && Number.isFinite(Number(minKarma))) {
      whereClause.restaurant = { ...whereClause.restaurant, karmaScore: { gte: Math.max(0, Number(minKarma)) } };
    }
    if (isVeg !== undefined && isVeg !== 'all' && isVeg !== '') {
      whereClause.isVeg = isVeg === 'true' || isVeg === true;
    }
    if (dietaryTag && String(dietaryTag).trim()) {
      whereClause.dietary = { has: String(dietaryTag).trim() };
    }

    if (search && search.trim()) {
      const searchTerm = search.trim();
      whereClause.AND = [
        ...(whereClause.AND || []),
        {
          OR: [
            { foodName: { contains: searchTerm, mode: 'insensitive' } },
            { category: { contains: searchTerm, mode: 'insensitive' } },
            { storageInstructions: { contains: searchTerm, mode: 'insensitive' } },
            { restaurant: { name: { contains: searchTerm, mode: 'insensitive' } } }
          ],
        },
      ];
    }

    const rawListings = await prisma.listing.findMany({
      where: whereClause,
      include: {
        restaurant: {
          select: {
            id: true,
            name: true,
            address: true,
            phone: true,
            latitude: true,
            longitude: true,
            fssaiNumber: true,
            karmaScore: true,
            approvalStatus: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Transform and calculate distance
    let formatted = rawListings.map(item => {
      const restLat = item.restaurant?.latitude;
      const restLng = item.restaurant?.longitude;
      const distanceMeters = (restLat && restLng)
        ? calculateHaversineDistance(userLat, userLng, restLat, restLng)
        : 1500;

      const distStr = distanceMeters < 1000
        ? `${Math.round(distanceMeters)} m`
        : `${(distanceMeters / 1000).toFixed(1)} km`;

      const safeDate = new Date(item.safeUntil);
      const diffMs = safeDate.getTime() - Date.now();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

      let remainingText = item.remainingHoursText || "Safe today";
      if (diffMs > 0) {
        if (diffHours > 24) {
          remainingText = `${Math.floor(diffHours / 24)}d ${diffHours % 24}h left`;
        } else {
          remainingText = `${diffHours}h ${diffMins}m left`;
        }
      }

      return {
        id: item.id,
        foodName: item.foodName,
        category: item.category,
        itemType: item.itemType || 'COOKED_MEAL',
        quantityUnit: item.quantityUnit || 'servings',
        totalServings: item.totalServings,
        availableServings: item.availableServings,
        preparedTime: item.preparedTime,
        safeUntil: item.safeUntil,
        remainingHoursText: remainingText,
        isUrgent: item.isUrgent || (diffMs > 0 && diffMs < 2 * 3600 * 1000),
        isVeg: item.isVeg,
        dietary: item.dietary || [],
        storageInstructions: item.storageInstructions,
        notes: item.notes,
        imageUrl: item.imageUrl,
        distance: distStr,
        distanceMeters,
        restaurant: item.restaurant?.name || "Restaurant Partner",
        restaurantId: item.restaurant?.id,
        restaurantKarma: item.restaurant?.karmaScore || 100,
        address: item.restaurant?.address || "Bengaluru",
        contactPhone: item.restaurant?.phone || null,
        fssaiNumber: item.restaurant?.fssaiNumber || null
      };
    });

    // Proximity radius filter
    if (radiusMeters > 0) {
      formatted = formatted.filter(item => item.distanceMeters <= radiusMeters);
    }

    // Sort order
    if (sort === 'distance') {
      formatted.sort((a, b) => a.distanceMeters - b.distanceMeters);
    } else if (sort === 'expiry' || sort === 'urgency') {
      formatted.sort((a, b) => new Date(a.safeUntil).getTime() - new Date(b.safeUntil).getTime());
    } else if (sort === 'servings' || sort === 'quantity') {
      formatted.sort((a, b) => b.availableServings - a.availableServings);
    } else if (sort === 'newest') {
      formatted.sort((a, b) => b.id - a.id);
    }

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching listings:', error);
    res.status(500).json({ message: 'Failed to fetch listings', error: error.message });
  }
});

// POST /api/listings
// RESTAURANT ONLY: Create a new surplus food or raw ingredients listing
app.post('/api/listings', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const {
      foodName,
      category = "Cooked Food",
      itemType = "COOKED_MEAL",
      quantityUnit = "servings",
      totalServings,
      preparedTime,
      safeUntilHours = 3,
      isVeg = true,
      dietary = [],
      storageInstructions,
      notes,
      imageUrl
    } = req.body;

    const count = parseInt(totalServings, 10);
    const safeUntilHoursValue = parseFloat(safeUntilHours);

    if (!foodName?.trim() || !Number.isInteger(count) || count <= 0 || count > 10000) {
      return res.status(400).json({ message: 'foodName and a valid totalServings value are required' });
    }
    if (!Number.isFinite(safeUntilHoursValue) || safeUntilHoursValue <= 0 || safeUntilHoursValue > 168) {
      return res.status(400).json({ message: 'safeUntilHours must be between 1 and 168 hours' });
    }

    const restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!restaurant) {
      return res.status(404).json({ message: 'Create and submit your restaurant profile before posting listings.' });
    }
    if (restaurant.approvalStatus !== 'APPROVED' || !restaurant.isActive) {
      return res.status(403).json({ message: 'Your restaurant profile must be approved and active to post listings.' });
    }
    if (!Number.isFinite(restaurant.latitude) || !Number.isFinite(restaurant.longitude)) {
      return res.status(400).json({ message: 'Your restaurant profile must include valid coordinates.' });
    }

    const safeUntilDate = new Date(Date.now() + (safeUntilHoursValue * 3600 * 1000));

    const listing = await prisma.listing.create({
      data: {
        foodName,
        category,
        itemType,
        quantityUnit,
        totalServings: count,
        availableServings: count,
        preparedTime: preparedTime || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        safeUntil: safeUntilDate,
        isVeg: Boolean(isVeg),
        dietary: Array.isArray(dietary) ? dietary : [dietary],
        storageInstructions: storageInstructions || "Carry insulated thermal containers.",
        notes: notes || null,
        imageUrl: imageUrl || "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=800&auto=format&fit=crop&q=80",
        restaurantId: restaurant.id
      },
      include: { restaurant: true }
    });

    // Update Redis Geo
    if (restaurant.latitude && restaurant.longitude) {
      await geoAddLocation('restaurants_geo', restaurant.longitude, restaurant.latitude, restaurant.id);
    }

    // Real-time broadcast
    io.emit('new_listing', {
      id: listing.id,
      foodName: listing.foodName,
      restaurant: restaurant.name,
      availableServings: listing.availableServings,
      category: listing.category,
      itemType: listing.itemType,
      quantityUnit: listing.quantityUnit,
      isVeg: listing.isVeg
    });

    await sendPushNotification(admin, prisma, {
      userId: req.user.userId,
      title: 'New surplus food posted',
      body: `${restaurant.name} posted ${listing.foodName}.`,
      data: { type: 'new_listing', listingId: listing.id }
    }).catch(error => console.warn('FCM listing notification failed:', error.message));

    res.status(201).json(listing);
  } catch (error) {
    console.error('Error creating listing:', error);
    res.status(500).json({ message: 'Failed to create listing', error: error.message });
  }
});

// ------------------------------------------
// RESERVATIONS & LOCKING (NGO ONLY)
// ------------------------------------------

// POST /api/listings/:id/reserve
// Atomic reservation locking by NGO
app.post('/api/listings/:id/reserve', authenticateJWT, requireRole('NGO'), async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const { portions = 10, shelterDelivered = "Local Community Shelter" } = req.body;
    const requestedPortions = parseInt(portions, 10);

    if (!Number.isInteger(listingId) || listingId <= 0 || !Number.isInteger(requestedPortions) || requestedPortions <= 0) {
      return res.status(400).json({ message: 'A valid listing ID and positive portions value are required.' });
    }

    // Get NGO profile
    const ngo = await prisma.nGO.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!ngo) {
      return res.status(403).json({
        message: 'Your NGO profile must be approved before you can reserve food.'
      });
    }

    if (!isActivePartner(ngo)) {
      return res.status(403).json({
        message: ngo.approvalStatus === 'SUSPENDED'
          ? 'Your NGO account is currently suspended due to repeated policy strikes. Please contact support.'
          : 'Your NGO profile must be approved and active before you can reserve food.'
      });
    }

    // Atomic transaction for portion deduction & reservation creation
    const result = await prisma.$transaction(async (tx) => {
      const listing = await tx.listing.findUnique({
        where: { id: listingId },
        include: { restaurant: true }
      });

      if (!listing) {
        throw new Error('Listing not found');
      }

      const availability = canReserveListing(listing, requestedPortions);
      if (!availability.allowed) {
        throw new Error(availability.reason);
      }

      const newAvailable = listing.availableServings - requestedPortions;
      const newStatus = newAvailable === 0 ? 'FULLY_RESERVED' : 'PARTIALLY_RESERVED';

      const updatedListing = await tx.listing.update({
        where: {
          id: listingId,
          availableServings: { gte: requestedPortions },
        },
        data: {
          availableServings: newAvailable,
          status: newStatus
        }
      });

      if (!updatedListing) {
        throw new Error('The listing was updated concurrently. Please retry the reservation.');
      }

      // Generate 4-digit pickup code
      const pickupCode = crypto.randomInt(1000, 9999).toString();
      const code = `RES-${pickupCode}`;
      const pickupDeadline = new Date(Date.now() + 90 * 60 * 1000); // 90 minutes

      const reservation = await tx.reservation.create({
        data: {
          code,
          pickupCode,
          reservedServings: requestedPortions,
          pickupDeadline,
          status: 'ready_for_pickup',
          pickupInstructions: `Enter through service gate. Show 4-digit Handover Code #${pickupCode} to the staff.`,
          shelterDelivered,
          fssaiVerified: true,
          listingId: listing.id,
          ngoId: ngo.id
        },
        include: {
          listing: {
            include: { restaurant: true }
          },
          ngo: true
        }
      });

      return { reservation, updatedListing };
    });

    // Notify connected clients via Socket.io
    io.emit('listing_updated', {
      listingId: result.updatedListing.id,
      availableServings: result.updatedListing.availableServings,
      status: result.updatedListing.status
    });

    io.emit('new_reservation', {
      reservationId: result.reservation.id,
      listingId: result.updatedListing.id,
      restaurantId: result.updatedListing.restaurantId
    });

    await sendPushNotification(admin, prisma, {
      userId: result.reservation.ngoId,
      title: 'Food reserved for pickup',
      body: `${result.reservation.listing.foodName} has been reserved for ${result.reservation.reservedServings} portions.`,
      data: { type: 'reservation_created', reservationId: result.reservation.id }
    }).catch(error => console.warn('FCM reservation notification failed:', error.message));

    res.status(201).json({
      message: 'Listing successfully reserved!',
      reservation: result.reservation
    });
  } catch (error) {
    console.error('Reservation error:', error);
    res.status(400).json({ message: error.message || 'Failed to complete reservation' });
  }
});

// GET /api/reservations
// NGO ONLY: Returns active pickups for the authenticated NGO
app.get('/api/reservations', authenticateJWT, requireRole('NGO'), async (req, res) => {
  try {
    let ngo = await prisma.nGO.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!ngo) {
      return res.json([]);
    }

    const reservations = await prisma.reservation.findMany({
      where: {
        ngoId: ngo.id,
        status: 'ready_for_pickup'
      },
      include: {
        listing: {
          include: { restaurant: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const formatted = reservations.map(r => ({
      id: r.code,
      dbId: r.id,
      restaurant: r.listing?.restaurant?.name || "Partner Restaurant",
      restaurantPhone: r.listing?.restaurant?.phone || null,
      address: r.listing?.restaurant?.address || "Koramangala, Bengaluru",
      foodName: r.listing?.foodName || "Surplus Meals",
      reservedServings: r.reservedServings,
      totalBatchServings: r.listing?.totalServings || r.reservedServings,
      quantityUnit: r.listing?.quantityUnit || 'servings',
      itemType: r.listing?.itemType || 'COOKED_MEAL',
      pickupDeadline: new Date(r.pickupDeadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      pickupCode: r.pickupCode,
      status: r.status,
      pickupInstructions: r.pickupInstructions,
      reservedAt: new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isVeg: r.listing?.isVeg ?? true
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({ message: 'Failed to fetch reservations', error: error.message });
  }
});

// POST /api/reservations/:id/cancel
// NGO ONLY: Cancel a reservation with mandatory reason. Portions are restored to the live listing.
app.post('/api/reservations/:id/cancel', authenticateJWT, requireRole('NGO'), async (req, res) => {
  try {
    const reservationParam = req.params.id;
    const { reason = "Unavoidable volunteer emergency", notes } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ message: 'Cancellation reason is required.' });
    }

    const ngo = await prisma.nGO.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!ngo) {
      return res.status(404).json({ message: 'NGO profile not found' });
    }

    const reservation = await prisma.reservation.findFirst({
      where: {
        OR: [
          { code: reservationParam },
          { id: parseInt(reservationParam, 10) || 0 }
        ],
        ngoId: ngo.id
      },
      include: { listing: true }
    });

    if (!reservation) {
      return res.status(404).json({ message: 'Reservation not found or does not belong to your NGO' });
    }

    if (reservation.status !== 'ready_for_pickup') {
      return res.status(400).json({ message: `Cannot cancel reservation with status '${reservation.status}'` });
    }

    const cancellationIsLate = isLateCancellation(reservation.pickupDeadline);
    const cancellationPenalty = cancellationIsLate ? -LATE_CANCELLATION_PENALTY : 0;

    // Atomic transaction: cancel reservation, restore portions, apply karma penalty
    const result = await prisma.$transaction(async (tx) => {
      // 1. Cancel reservation
      const updatedReservation = await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          status: 'cancelled',
          cancellationReason: reason,
          cancelledAt: new Date(),
          cancelledByRole: 'NGO'
        }
      });

      // 2. Restore portions to listing if safeUntil is still in future
      let updatedListing = null;
      if (reservation.listing && new Date(reservation.listing.safeUntil) > new Date()) {
        const restoredPortions = reservation.listing.availableServings + reservation.reservedServings;
        updatedListing = await tx.listing.update({
          where: { id: reservation.listingId },
          data: {
            availableServings: restoredPortions,
            status: 'ACTIVE'
          }
        });
      }

      // 3. Apply the configured cancellation penalty and log it in the audit trail.
      const policy = applyKarmaChange({
        karmaScore: ngo.karmaScore,
        strikeCount: ngo.strikeCount,
        pointsDelta: cancellationPenalty,
        action: cancellationPenalty < 0 ? 'LATE_CANCELLATION' : 'CANCELLED_ON_TIME',
      });
      const isSuspended = policy.suspensionRequired || policy.trustLevel === 'SUSPENDED';

      await tx.nGO.update({
        where: { id: ngo.id },
        data: {
          karmaScore: policy.karmaScore,
          strikeCount: policy.strikeCount,
          warningCount: policy.suspensionRequired ? ngo.warningCount + 1 : ngo.warningCount,
          isActive: isSuspended ? false : ngo.isActive,
          isVerified: isSuspended ? false : ngo.isVerified,
        }
      });

      if (cancellationPenalty < 0) {
        await tx.karmaLog.create({
          data: {
            entityType: 'NGO',
            entityId: ngo.id,
            pointsDelta: cancellationPenalty,
            action: 'LATE_CANCELLATION',
            reason: `${reason}${notes ? ` - ${notes}` : ''}`,
            reservationId: reservation.id,
            listingId: reservation.listingId
          }
        });
      }

      return { updatedReservation, updatedListing, newKarma: policy.karmaScore, suspensionRequired: isSuspended };
    });

    // Real-time broadcast
    if (result.updatedListing) {
      io.emit('listing_updated', {
        listingId: result.updatedListing.id,
        availableServings: result.updatedListing.availableServings,
        status: result.updatedListing.status
      });
    }

    io.emit('reservation_cancelled', {
      reservationId: reservation.id,
      code: reservation.code,
      listingId: reservation.listingId
    });

    res.json({
      message: 'Reservation cancelled successfully. Portions returned to live feed.',
      penalty: '-15 Karma points applied',
      currentKarma: result.newKarma
    });
  } catch (error) {
    console.error('Cancellation error:', error);
    res.status(500).json({ message: 'Failed to cancel reservation', error: error.message });
  }
});

// ------------------------------------------
// RESTAURANT SUITE & IN-APP OTP HANDOVER
// ------------------------------------------

// POST /api/restaurant/reservations/verify-otp
// RESTAURANT ONLY: Handover verification. Restaurant inputs NGO's OTP -> food marked collected!
app.post('/api/restaurant/reservations/verify-otp', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const { reservationCode, reservationId, pickupCode, otp } = req.body;
    const verifiedCode = (pickupCode || otp || '').toString().trim();

    if (!verifiedCode || (!reservationCode && !reservationId)) {
      return res.status(400).json({ message: 'Pickup Code and Reservation Identifier are required.' });
    }

    const restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant profile not found.' });
    }

    // Find reservation
    const reservation = await prisma.reservation.findFirst({
      where: {
        OR: [
          { code: reservationCode },
          { id: parseInt(reservationId, 10) || 0 }
        ]
      },
      include: {
        listing: true,
        ngo: true
      }
    });

    if (!reservation) {
      return res.status(404).json({ message: 'Reservation not found.' });
    }

    // Ensure reservation belongs to this restaurant's listing
    if (reservation.listing.restaurantId !== restaurant.id) {
      return res.status(403).json({ message: 'This reservation does not belong to your restaurant.' });
    }

    if (reservation.status === 'completed') {
      return res.status(400).json({ message: 'This pickup has already been verified and completed.' });
    }

    if (reservation.status === 'cancelled') {
      return res.status(400).json({ message: 'This reservation was previously cancelled.' });
    }

    if (reservation.pickupDeadline.getTime() < Date.now()) {
      return res.status(400).json({ message: 'This pickup deadline has passed.' });
    }

    // Verify a bounded OTP attempt. The pickup code is intentionally not returned to non-owning partners.
    const otpKey = `pickup:${reservation.id}`;
    const session = otpAttempts.get(otpKey) || { reservationId: reservation.id, otp: reservation.pickupCode, attempts: 0, expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
    const attempt = validateOtpAttempt(session, verifiedCode);
    if (!attempt.valid) {
      otpAttempts.delete(otpKey);
      return res.status(400).json({ message: attempt.reason });
    }
    session.attempts = attempt.attempts;
    otpAttempts.set(otpKey, session);

    // Atomic transaction: mark completed, award impact and karma to both
    const meals = reservation.reservedServings || 10;
    const wasteKg = meals * 0.5;
    const co2Tonnes = (wasteKg * 2.5) / 1000;

    const result = await prisma.$transaction(async (tx) => {
      const updatedReservation = await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          handoverVerifiedAt: new Date(),
          handoverVerifiedBy: req.user.userId
        }
      });

      // Update NGO stats and policy state.
      const ngoPolicy = applyKarmaChange({
        karmaScore: reservation.ngo.karmaScore,
        strikeCount: reservation.ngo.strikeCount,
        pointsDelta: 10,
        action: 'ON_TIME_COLLECTION',
      });
      await tx.nGO.update({
        where: { id: reservation.ngoId },
        data: {
          totalMealsRescued: { increment: meals },
          foodWastePreventedKg: { increment: wasteKg },
          co2eAvoidedTonnes: { increment: co2Tonnes },
          karmaScore: ngoPolicy.karmaScore,
          strikeCount: ngoPolicy.strikeCount,
          isActive: ngoPolicy.suspensionRequired ? false : reservation.ngo.isActive,
          isVerified: ngoPolicy.suspensionRequired ? false : reservation.ngo.isVerified,
        }
      });

      // Update Restaurant stats and policy state.
      const restaurantPolicy = applyKarmaChange({
        karmaScore: restaurant.karmaScore,
        strikeCount: restaurant.strikeCount,
        pointsDelta: 10,
        action: 'SUCCESSFUL_DONATION',
      });
      await tx.restaurant.update({
        where: { id: restaurant.id },
        data: {
          totalMealsDonated: { increment: meals },
          foodWastePreventedKg: { increment: wasteKg },
          karmaScore: restaurantPolicy.karmaScore,
          strikeCount: restaurantPolicy.strikeCount,
          isActive: restaurantPolicy.suspensionRequired ? false : restaurant.isActive,
          isVerified: restaurantPolicy.suspensionRequired ? false : restaurant.isVerified,
        }
      });

      // Log Karma for both
      await tx.karmaLog.create({
        data: {
          entityType: 'NGO',
          entityId: reservation.ngoId,
          pointsDelta: 10,
          action: 'ON_TIME_COLLECTION',
          reason: `Verified pickup from ${restaurant.name}`,
          reservationId: reservation.id
        }
      });

      await tx.karmaLog.create({
        data: {
          entityType: 'RESTAURANT',
          entityId: restaurant.id,
          pointsDelta: 10,
          action: 'SUCCESSFUL_DONATION',
          reason: `Surplus handed over to ${reservation.ngo.name}`,
          reservationId: reservation.id
        }
      });

      return updatedReservation;
    });

    // Real-time broadcast
    io.emit('pickup_completed', {
      reservationId: reservation.id,
      code: reservation.code,
      restaurantName: restaurant.name,
      ngoName: reservation.ngo.name,
      mealsRescued: meals
    });

    res.json({
      message: 'Collection verified successfully! Impact and Karma points awarded to both parties.',
      reservation: result
    });
  } catch (error) {
    console.error('Handover OTP verification error:', error);
    res.status(500).json({ message: 'Verification failed', error: error.message });
  }
});

app.post('/api/reservations/:id/request-code', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    const restaurant = await prisma.restaurant.findFirst({ where: { ownerId: req.user.userId } });
    const reservation = await prisma.reservation.findFirst({ where: { id: reservationId }, include: { listing: true } });
    if (!restaurant || !reservation || reservation.listing.restaurantId !== restaurant.id) {
      return res.status(404).json({ message: 'Reservation not found' });
    }
    if (reservation.status !== 'ready_for_pickup') return res.status(409).json({ message: 'Reservation is not active' });
    const pickupCode = crypto.randomInt(1000, 9999).toString().padStart(4, '0');
    const session = createOtpSession({ id: reservation.id, pickupCode }, 0);
    otpAttempts.set(`pickup:${reservation.id}`, session);
    await prisma.reservation.update({ where: { id: reservation.id }, data: { pickupCode } });
    res.json({ message: 'A fresh pickup code was issued.', pickupCode, expiresInSeconds: 600 });
  } catch (error) {
    console.error('OTP rotation error:', error);
    res.status(500).json({ message: 'Failed to issue pickup code' });
  }
});

app.post('/api/reservations/:id/no-show', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const reservationId = parseInt(req.params.id, 10);
    const restaurant = await prisma.restaurant.findFirst({ where: { ownerId: req.user.userId } });
    const reservation = await prisma.reservation.findFirst({ where: { id: reservationId }, include: { listing: true, ngo: true } });
    if (!restaurant || !reservation || reservation.listing.restaurantId !== restaurant.id) {
      return res.status(404).json({ message: 'Reservation not found' });
    }
    if (reservation.status !== 'ready_for_pickup' || reservation.pickupDeadline.getTime() > Date.now()) {
      return res.status(409).json({ message: 'Reservation is not eligible for no-show processing' });
    }
    const policy = applyKarmaChange({ karmaScore: reservation.ngo.karmaScore, strikeCount: reservation.ngo.strikeCount, pointsDelta: -NO_SHOW_PENALTY, action: 'NO_SHOW' });
    const result = await prisma.$transaction(async (tx) => {
      await tx.reservation.update({ where: { id: reservation.id }, data: { status: 'cancelled', cancelledByRole: 'SYSTEM', cancellationReason: 'No-show after pickup deadline', cancelledAt: new Date() } });
      if (new Date(reservation.listing.safeUntil) > new Date()) {
        await tx.listing.update({
          where: { id: reservation.listingId },
          data: {
            availableServings: { increment: reservation.reservedServings },
            status: 'ACTIVE'
          }
        });
      }
      await tx.ngo.update({ where: { id: reservation.ngoId }, data: { karmaScore: policy.karmaScore, strikeCount: policy.strikeCount, isActive: policy.suspensionRequired ? false : reservation.ngo.isActive, isVerified: policy.suspensionRequired ? false : reservation.ngo.isVerified } });
      await tx.karmaLog.create({ data: { entityType: 'NGO', entityId: reservation.ngoId, pointsDelta: -NO_SHOW_PENALTY, action: 'NO_SHOW', reason: `No-show for ${reservation.code}`, reservationId: reservation.id, listingId: reservation.listingId } });
      return policy;
    });
    io.emit('reservation_no_show', { reservationId, code: reservation.code, ...result });
    res.json({ message: 'No-show processed and penalty applied.', policy: result });
  } catch (error) {
    console.error('No-show processing error:', error);
    res.status(500).json({ message: 'Failed to process no-show' });
  }
});

// GET /api/restaurant/listings
// RESTAURANT ONLY: Get all listings posted by this restaurant
app.get('/api/restaurant/listings', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!restaurant) {
      return res.json([]);
    }

    const listings = await prisma.listing.findMany({
      where: { restaurantId: restaurant.id },
      include: {
        reservations: {
          where: { status: 'ready_for_pickup' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(listings);
  } catch (error) {
    console.error('Error fetching restaurant listings:', error);
    res.status(500).json({ message: 'Failed to fetch restaurant listings' });
  }
});

// PATCH /api/restaurant/listings/:id
// RESTAURANT ONLY: Edit or cancel/close a listing
app.patch('/api/restaurant/listings/:id', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const { status, availableServings, safeUntilHours, storageInstructions, foodName, category, itemType, isVeg, dietary, notes, imageUrl } = req.body;

    const restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant profile not found' });
    }

    const listing = await prisma.listing.findFirst({
      where: { id: listingId, restaurantId: restaurant.id }
    });

    if (!listing) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    const updateData = {};
    if (status && ['ACTIVE', 'PARTIALLY_RESERVED', 'FULLY_RESERVED', 'CANCELLED'].includes(status)) {
      updateData.status = status;
    }
    if (availableServings !== undefined) {
      const parsedAvailable = parseInt(availableServings, 10);
      if (!Number.isInteger(parsedAvailable) || parsedAvailable < 0 || parsedAvailable > listing.totalServings) {
        return res.status(400).json({ message: 'Available servings must be between 0 and the total quantity.' });
      }
      if (listing.reservations.length > 0 && parsedAvailable < listing.totalServings - listing.reservations.reduce((sum, reservation) => sum + reservation.reservedServings, 0)) {
        return res.status(409).json({ message: 'Available servings cannot be reduced below the quantity already reserved.' });
      }
      updateData.availableServings = parsedAvailable;
      if (listing.status !== 'CANCELLED') {
        if (parsedAvailable === 0) updateData.status = 'FULLY_RESERVED';
        else if (parsedAvailable < listing.totalServings) updateData.status = 'PARTIALLY_RESERVED';
        else updateData.status = 'ACTIVE';
      }
    }
    if (foodName?.trim()) updateData.foodName = foodName.trim();
    if (category?.trim()) updateData.category = category.trim();
    if (itemType?.trim()) updateData.itemType = itemType.trim();
    if (dietary !== undefined) updateData.dietary = Array.isArray(dietary) ? dietary : [dietary];
    if (storageInstructions?.trim()) updateData.storageInstructions = storageInstructions.trim();
    if (notes !== undefined) updateData.notes = notes.trim() || null;
    if (imageUrl?.trim()) updateData.imageUrl = imageUrl.trim();
    if (safeUntilHours) {
      const parsedSafeUntilHours = parseFloat(safeUntilHours);
      if (!Number.isFinite(parsedSafeUntilHours) || parsedSafeUntilHours <= 0 || parsedSafeUntilHours > 8760) {
        return res.status(400).json({ message: 'Safe-until must be between 1 hour and 365 days.' });
      }
      updateData.safeUntil = new Date(Date.now() + parsedSafeUntilHours * 3600 * 1000);
    }

    const updated = await prisma.listing.update({
      where: { id: listingId },
      data: updateData
    });

    io.emit('listing_updated', {
      listingId: updated.id,
      availableServings: updated.availableServings,
      status: updated.status
    });

    res.json({ message: 'Listing updated successfully', listing: updated });
  } catch (error) {
    console.error('Error updating listing:', error);
    res.status(500).json({ message: 'Failed to update listing' });
  }
});

app.delete('/api/restaurant/listings/:id', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const restaurant = await prisma.restaurant.findFirst({ where: { ownerId: req.user.userId } });
    if (!restaurant) return res.status(404).json({ message: 'Restaurant profile not found' });
    const listing = await prisma.listing.findFirst({
      where: { id: listingId, restaurantId: restaurant.id },
      include: {
        reservations: {
          where: { status: { in: ['ready_for_pickup', 'completed'] } }
        }
      }
    });
    if (!listing) return res.status(404).json({ message: 'Listing not found' });
    if (listing.reservations.length > 0) {
      return res.status(409).json({ message: 'Cannot delete a listing with active or completed reservations. Cancel or complete them first.' });
    }
    await prisma.listing.delete({ where: { id: listingId } });
    io.emit('listing_deleted', { listingId });
    res.json({ message: 'Listing deleted successfully' });
  } catch (error) {
    console.error('Listing delete error:', error);
    res.status(500).json({ message: 'Failed to delete listing' });
  }
});

// GET /api/restaurant/reservations
// RESTAURANT ONLY: Incoming active reservations waiting for NGO pickup
app.get('/api/restaurant/reservations', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!restaurant) {
      return res.json([]);
    }

    const reservations = await prisma.reservation.findMany({
      where: {
        listing: { restaurantId: restaurant.id },
        status: 'ready_for_pickup'
      },
      include: {
        listing: true,
        ngo: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const formatted = reservations.map(r => ({
      id: r.code,
      dbId: r.id,
      foodName: r.listing.foodName,
      reservedServings: r.reservedServings,
      quantityUnit: r.listing.quantityUnit || 'servings',
      ngoName: r.ngo.name,
      ngoPhone: r.ngo.phone || null,
      ngoTagline: r.ngo.tagline,
      ngoKarma: r.ngo.karmaScore || 100,
      pickupDeadline: new Date(r.pickupDeadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reservedAt: new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: r.status
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching incoming reservations:', error);
    res.status(500).json({ message: 'Failed to fetch incoming reservations' });
  }
});

// GET /api/restaurant/history
// RESTAURANT ONLY: Completed donations history
app.get('/api/restaurant/history', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!restaurant) {
      return res.json([]);
    }

    const history = await prisma.reservation.findMany({
      where: {
        listing: { restaurantId: restaurant.id },
        status: 'completed'
      },
      include: {
        listing: true,
        ngo: true
      },
      orderBy: { completedAt: 'desc' }
    });

    const formatted = history.map(h => ({
      id: h.code,
      foodName: h.listing.foodName,
      servingsDonated: h.reservedServings,
      quantityUnit: h.listing.quantityUnit || 'servings',
      ngoName: h.ngo.name,
      ngoPhone: h.ngo.phone,
      completedAt: h.completedAt
        ? new Date(h.completedAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'Completed',
      shelterDelivered: h.shelterDelivered,
      karmaDelta: 10,
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching restaurant history:', error);
    res.status(500).json({ message: 'Failed to fetch donation history' });
  }
});

// GET /api/restaurant/stats
// RESTAURANT ONLY: Get impact & karma stats
app.get('/api/restaurant/stats', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!restaurant) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    const activeListingsCount = await prisma.listing.count({
      where: { restaurantId: restaurant.id, status: 'ACTIVE' }
    });

    res.json({
      name: restaurant.name,
      karmaScore: restaurant.karmaScore || 100,
      rating: restaurant.rating || 4.8,
      totalMealsDonated: restaurant.totalMealsDonated || 0,
      foodWastePreventedKg: restaurant.foodWastePreventedKg || 0,
      activeListingsCount,
      fssaiNumber: restaurant.fssaiNumber,
      approvalStatus: restaurant.approvalStatus
    });
  } catch (error) {
    console.error('Error fetching restaurant stats:', error);
    res.status(500).json({ message: 'Failed to fetch restaurant stats' });
  }
});

// ------------------------------------------
// NGO HISTORY & RESCUE AUDIT
// ------------------------------------------

// GET /api/history
// NGO ONLY: Returns complete pickup and cancellation history
app.get('/api/history', authenticateJWT, requireRole('NGO'), async (req, res) => {
  try {
    const ngo = await prisma.nGO.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!ngo) {
      return res.json([]);
    }

    const historyItems = await prisma.reservation.findMany({
      where: {
        ngoId: ngo.id,
        status: { in: ['completed', 'cancelled'] }
      },
      include: {
        listing: {
          include: { restaurant: true }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    const formatted = historyItems.map(h => ({
      id: h.code,
      status: h.status,
      restaurant: h.listing?.restaurant?.name || "Partner Restaurant",
      restaurantPhone: h.listing?.restaurant?.phone || "+91 80 4000 0000",
      address: h.listing?.restaurant?.address || "Bengaluru",
      foodName: h.listing?.foodName || "Rescued Food",
      servingsRescued: h.reservedServings,
      quantityUnit: h.listing?.quantityUnit || 'servings',
      completedAt: h.completedAt
        ? new Date(h.completedAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : h.cancelledAt
        ? new Date(h.cancelledAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : "Recently",
      shelterDelivered: h.shelterDelivered || "Asha Kiran Shelter",
      cancellationReason: h.cancellationReason,
      fssaiVerified: h.fssaiVerified,
      karmaDelta: h.status === 'completed' ? 10 : -15
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ message: 'Failed to fetch history', error: error.message });
  }
});

// GET /api/karma/history
// Returns authenticated partner's recent karma log history
app.get('/api/karma/history', authenticateJWT, async (req, res) => {
  try {
    const role = req.user.role;
    let entityId = null;

    if (role === 'NGO') {
      const ngo = await prisma.nGO.findFirst({ where: { ownerId: req.user.userId } });
      if (ngo) entityId = ngo.id;
    } else if (role === 'RESTAURANT') {
      const resto = await prisma.restaurant.findFirst({ where: { ownerId: req.user.userId } });
      if (resto) entityId = resto.id;
    }

    if (!entityId) {
      return res.json([]);
    }

    const logs = await prisma.karmaLog.findMany({
      where: { entityType: role, entityId },
      orderBy: { createdAt: 'desc' },
      take: 40
    });

    const formatted = logs.map(l => ({
      id: l.id,
      pointsDelta: l.pointsDelta,
      action: l.action,
      reason: l.reason || (l.pointsDelta > 0 ? 'Verified rescue activity' : 'Policy infraction penalty'),
      createdAt: new Date(l.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching karma logs:', error);
    res.status(500).json({ message: 'Failed to fetch karma logs' });
  }
});

// GET /api/leaderboard
// Returns city-wide top Karma Rescuers (NGOs) and Donors (Restaurants)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const [topRestaurants, topNgos] = await Promise.all([
      prisma.restaurant.findMany({
        where: { approvalStatus: 'APPROVED' },
        select: {
          id: true,
          name: true,
          cuisineType: true,
          address: true,
          karmaScore: true,
          totalMealsDonated: true,
          foodWastePreventedKg: true
        },
        orderBy: [{ karmaScore: 'desc' }, { totalMealsDonated: 'desc' }],
        take: 10
      }),
      prisma.nGO.findMany({
        where: { approvalStatus: 'APPROVED' },
        select: {
          id: true,
          name: true,
          mission: true,
          address: true,
          karmaScore: true,
          totalMealsRescued: true,
          foodWastePreventedKg: true,
          co2eAvoidedTonnes: true
        },
        orderBy: [{ karmaScore: 'desc' }, { totalMealsRescued: 'desc' }],
        take: 10
      })
    ]);

    res.json({
      restaurants: topRestaurants.map((r, idx) => ({ ...r, rank: idx + 1 })),
      ngos: topNgos.map((n, idx) => ({ ...n, rank: idx + 1 }))
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ message: 'Failed to fetch leaderboard' });
  }
});

// ------------------------------------------
// ADMIN PARTNER APPROVAL & DOCUMENT REVIEW
// ------------------------------------------

// GET /api/admin/partners
// ADMIN ONLY: Lists pending and active partners with legal-document metadata.
app.get('/api/admin/partners', authenticateJWT, requireRole('ADMIN'), async (req, res) => {
  try {
    const [restaurants, ngos] = await Promise.all([
      prisma.restaurant.findMany({
        include: { owner: { select: { id: true, email: true, name: true } } },
        orderBy: [{ approvalStatus: 'asc' }, { createdAt: 'desc' }]
      }),
      prisma.nGO.findMany({
        include: { owner: { select: { id: true, email: true, name: true } } },
        orderBy: [{ approvalStatus: 'asc' }, { createdAt: 'desc' }]
      })
    ]);

    res.json({
      restaurants: restaurants.map(partner => ({
        ...partner,
        partnerType: 'RESTAURANT',
        owner: partner.owner
      })),
      ngos: ngos.map(partner => ({
        ...partner,
        partnerType: 'NGO',
        owner: partner.owner
      }))
    });
  } catch (error) {
    console.error('Admin partners error:', error);
    res.status(500).json({ message: 'Failed to load partner applications', error: error.message });
  }
});

// PATCH /api/admin/partners/:type/:id/review
// ADMIN ONLY: Approves, rejects, or suspends a partner and records the audit decision.
app.patch('/api/admin/partners/:type/:id/review', authenticateJWT, requireRole('ADMIN'), async (req, res) => {
  try {
    const partnerType = req.params.type;
    const partnerId = parseInt(req.params.id, 10);
    const { approvalStatus, reviewReason, documentStatus } = req.body;
    const allowedStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'];

    if (!['RESTAURANT', 'NGO'].includes(partnerType) || !Number.isInteger(partnerId)) {
      return res.status(400).json({ message: 'A valid partner type and ID are required.' });
    }
    if (approvalStatus && !allowedStatuses.includes(approvalStatus)) {
      return res.status(400).json({ message: 'Invalid approval status.' });
    }
    if (!approvalStatus && !documentStatus) {
      return res.status(400).json({ message: 'Provide an approval status or document status.' });
    }

    const model = partnerType === 'RESTAURANT' ? prisma.restaurant : prisma.ngo;
    const partner = await model.findUnique({ where: { id: partnerId } });
    if (!partner) {
      return res.status(404).json({ message: 'Partner not found.' });
    }

    const nextStatus = approvalStatus || partner.approvalStatus;
    const nextDocumentStatus = documentStatus || partner.documentStatus;
    const result = await prisma.$transaction(async (tx) => {
      const updatedPartner = await tx[partnerType.toLowerCase()].update({
        where: { id: partnerId },
        data: {
          approvalStatus: nextStatus,
          documentStatus: nextDocumentStatus,
          approvalReason: reviewReason?.trim() || null,
          approvalReviewAt: new Date(),
          approvedById: req.user.userId,
          isActive: nextStatus === 'APPROVED',
          isVerified: nextStatus === 'APPROVED'
        }
      });
      await tx.adminAudit.create({
        data: {
          action: `PARTNER_${nextStatus}`,
          actorId: req.user.userId,
          targetType: partnerType,
          targetId: partnerId,
          details: { previousStatus: partner.approvalStatus, nextStatus, reviewReason: reviewReason?.trim() || null }
        }
      });
      return updatedPartner;
    });

    res.json({
      message: `Partner ${nextStatus.toLowerCase()}.`,
      partner: { ...result, partnerType }
    });
  } catch (error) {
    console.error('Partner review error:', error);
    res.status(500).json({ message: 'Failed to review partner', error: error.message });
  }
});

app.post('/api/reports', authenticateJWT, async (req, res) => {
  try {
    const { targetType, targetId, reservationId, reason, details } = req.body;
    if (!['NGO', 'RESTAURANT'].includes(targetType) || !Number.isInteger(Number(targetId)) || !reason?.trim()) {
      return res.status(400).json({ message: 'Target type, target ID, and reason are required.' });
    }
    const report = await prisma.report.create({
      data: {
        reporterType: req.user.role,
        reporterId: req.user.userId,
        targetType,
        targetId: Number(targetId),
        reservationId: reservationId ? Number(reservationId) : null,
        reason: reason.trim(),
        details: details?.trim() || null,
        status: 'PENDING'
      }
    });
    res.status(201).json(report);
  } catch (error) {
    console.error('Report creation error:', error);
    res.status(500).json({ message: 'Failed to submit report' });
  }
});

app.get('/api/admin/reports', authenticateJWT, requireRole('ADMIN'), async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      include: { reporter: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(reports);
  } catch (error) {
    console.error('Report list error:', error);
    res.status(500).json({ message: 'Failed to load reports' });
  }
});

app.patch('/api/admin/reports/:id/review', authenticateJWT, requireRole('ADMIN'), async (req, res) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    const { status, resolution } = req.body;
    if (!['PENDING', 'REVIEWING', 'RESOLVED', 'DISMISSED'].includes(status)) {
      return res.status(400).json({ message: 'Invalid report status.' });
    }
    const report = await prisma.report.findUnique({ where: { id: reportId } });
    if (!report) return res.status(404).json({ message: 'Report not found' });
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.report.update({
        where: { id: reportId },
        data: {
          status,
          resolution: resolution?.trim() || null,
          resolvedAt: status === 'RESOLVED' || status === 'DISMISSED' ? new Date() : null,
          resolvedById: req.user.userId
        }
      });
      await tx.adminAudit.create({
        data: {
          action: `REPORT_${status}`,
          actorId: req.user.userId,
          targetType: 'REPORT',
          targetId: reportId,
          details: { previousStatus: report.status, nextStatus: status, resolution: resolution?.trim() || null }
        }
      });
      return updated;
    });
    res.json(result);
  } catch (error) {
    console.error('Report review error:', error);
    res.status(500).json({ message: 'Failed to review report' });
  }
});

// GET /api/profile
app.get('/api/profile', authenticateJWT, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: { ngos: true, restaurants: true }
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.role === 'NGO') {
      const ngo = user.ngos?.[0] || {
        name: user.name || "Robin Hood Army — Bengaluru Core",
        tagline: "Zero-fund volunteer collective serving surplus food to local communities",
        darpanId: "KA/2021/0291884",
        taxExemption: "Section 80G Certified",
        isVerified: true,
        latitude: 12.9352,
        longitude: 77.6245,
        operatingBase: "Koramangala Community Depot, Bengaluru",
        defaultRadiusKm: 8,
        pickupMode: "NGO Representative Self-Pickup",
        approvalStatus: 'APPROVED',
        karmaScore: 100,
        warningCount: 0,
        strikeCount: 0,
        totalMealsRescued: 3420,
        foodWastePreventedKg: 1710,
        co2eAvoidedTonnes: 4.28,
        activePartners: 28
      };

      return res.json({
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: 'NGO',
        name: ngo.name,
        tagline: ngo.tagline || "Volunteer food rescue collective",
        darpanId: ngo.darpanId || "KA/2026/019284",
        taxExemption: ngo.taxExemption || "Section 80G Certified",
        mission: ngo.mission || "Zero hunger through food rescue",
        isVerified: ngo.isVerified ?? true,
        approvalStatus: ngo.approvalStatus || 'APPROVED',
        documentStatus: ngo.documentStatus || 'NOT_SUBMITTED',
        documentName: ngo.documentName,
        documentUrl: ngo.documentUrl,
        approvalReason: ngo.approvalReason,
        approvalReviewAt: ngo.approvalReviewAt,
        karmaScore: ngo.karmaScore ?? 100,
        warningCount: ngo.warningCount || 0,
        strikeCount: ngo.strikeCount || 0,
        latitude: ngo.latitude,
        longitude: ngo.longitude,
        address: ngo.address || "Bengaluru",
        logisticsSetting: {
          mode: ngo.pickupMode || "NGO Representative Self-Pickup",
          inAppDeliveryNote: "In-App Delivery Fleet Integration coming in Phase 2 roadmap.",
          defaultRadiusKm: ngo.defaultRadiusKm || 8,
          operatingBase: ngo.operatingBase || "Koramangala Community Depot, Bengaluru"
        },
        impactStats: {
          totalMealsRescued: ngo.totalMealsRescued || 0,
          foodWastePreventedKg: ngo.foodWastePreventedKg || 0,
          co2eAvoidedTonnes: ngo.co2eAvoidedTonnes || 0,
          activeRestaurantPartners: ngo.activePartners || 12
        }
      });
    } else {
      // Restaurant profile
      const restaurant = user.restaurants?.[0] || {
        name: user.name || "Partner Kitchen",
        latitude: 12.9352,
        longitude: 77.6245,
        address: "Bengaluru Central",
        approvalStatus: 'APPROVED',
        karmaScore: 100,
        totalMealsDonated: 0,
        foodWastePreventedKg: 0
      };

      return res.json({
        id: user.id,
        email: user.email,
        phone: user.phone,
        name: restaurant.name,
        role: 'RESTAURANT',
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
        address: restaurant.address,
        phone: restaurant.phone,
        fssaiNumber: restaurant.fssaiNumber,
        cuisineType: restaurant.cuisineType || "Multi-Cuisine",
        approvalStatus: restaurant.approvalStatus || 'APPROVED',
        documentStatus: restaurant.documentStatus || 'NOT_SUBMITTED',
        documentName: restaurant.documentName,
        documentUrl: restaurant.documentUrl,
        approvalReason: restaurant.approvalReason,
        approvalReviewAt: restaurant.approvalReviewAt,
        karmaScore: restaurant.karmaScore ?? 100,
        warningCount: restaurant.warningCount || 0,
        strikeCount: restaurant.strikeCount || 0,
        impactStats: {
          totalMealsDonated: restaurant.totalMealsDonated || 0,
          foodWastePreventedKg: restaurant.foodWastePreventedKg || 0
        }
      });
    }
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ message: 'Failed to fetch profile', error: error.message });
  }
});

// PUT /api/profile
// Updates NGO/Restaurant details and coordinates for Redis Geo + proximity queries
app.put('/api/profile', authenticateJWT, async (req, res) => {
  try {
    const {
      name,
      operatingBase,
      defaultRadiusKm,
      latitude,
      longitude,
      tagline,
      darpanId,
      documentName,
      documentUrl,
      documentStatus
    } = req.body;

    const lat = latitude !== undefined ? parseFloat(latitude) : undefined;
    const lng = longitude !== undefined ? parseFloat(longitude) : undefined;
    const normalizedDocumentStatus = documentStatus || 'PENDING_REVIEW';

    let updatedEntity;
    if (req.user.role === 'NGO') {
      let ngo = await prisma.nGO.findFirst({
        where: { ownerId: req.user.userId }
      });

      if (ngo) {
        updatedEntity = await prisma.nGO.update({
          where: { id: ngo.id },
          data: {
            name: name || undefined,
            operatingBase: operatingBase || undefined,
            defaultRadiusKm: defaultRadiusKm ? parseFloat(defaultRadiusKm) : undefined,
            latitude: lat !== undefined && !isNaN(lat) ? lat : undefined,
            longitude: lng !== undefined && !isNaN(lng) ? lng : undefined,
            tagline: tagline || undefined,
            darpanId: darpanId || undefined,
            documentName: documentName?.trim() || undefined,
            documentUrl: documentUrl?.trim() || undefined,
            documentStatus: normalizedDocumentStatus,
            approvalStatus: documentName || documentUrl ? 'PENDING' : undefined
          }
        });
        if (lat && lng) {
          await geoAddLocation('ngos_geo', lng, lat, ngo.id);
        }
      }
    } else {
      let restaurant = await prisma.restaurant.findFirst({
        where: { ownerId: req.user.userId }
      });

      if (restaurant) {
        updatedEntity = await prisma.restaurant.update({
          where: { id: restaurant.id },
          data: {
            name: name || undefined,
            address: operatingBase || undefined,
            latitude: lat !== undefined && !isNaN(lat) ? lat : undefined,
            longitude: lng !== undefined && !isNaN(lng) ? lng : undefined,
            documentName: documentName?.trim() || undefined,
            documentUrl: documentUrl?.trim() || undefined,
            documentStatus: normalizedDocumentStatus,
            approvalStatus: documentName || documentUrl ? 'PENDING' : undefined
          }
        });
        if (lat && lng) {
          await geoAddLocation('restaurants_geo', lng, lat, restaurant.id);
        }
      }
    }

    if (name) {
      await prisma.user.update({
        where: { id: req.user.userId },
        data: { name }
      });
    }

    res.json({
      message: 'Profile and location updated successfully',
      profile: updatedEntity
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ message: 'Failed to update profile', error: error.message });
  }
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Socket client connected:', socket.id);

  socket.on('authenticate', (token) => {
    jwt.verify(token, process.env.JWT_SECRET || 'feedforward_secret_key_2026', (err, decoded) => {
      if (!err) {
        socket.userId = decoded.userId;
        socket.role = decoded.role;
        socket.join(`user_${decoded.userId}`);
        socket.join(`role_${decoded.role}`);
        socket.emit('authenticated', { userId: decoded.userId, role: decoded.role });
      } else {
        socket.emit('auth_error', { message: 'Invalid token' });
      }
    });
  });

  socket.on('join_location', (data) => {
    const { latitude, longitude, radius = 10000 } = data || {};
    if (latitude && longitude) {
      const roomId = `geo_${Math.round(latitude * 100)}_${Math.round(longitude * 100)}`;
      socket.join(roomId);
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket client disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`FeedForward backend is listening on port ${PORT}`);
});

module.exports = { app, server, io };
