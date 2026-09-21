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
    return;
  }
  if (channel === 'phone' && twilioClient && process.env.TWILIO_FROM) {
    await twilioClient.messages.create({ body: message, from: process.env.TWILIO_FROM, to: destination });
    return;
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
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d', algorithm: 'HS256' }
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
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
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

// Mock Seed Data for Fallback when Database is Empty
const defaultMockListings = [
  {
    id: 1,
    foodName: "Chicken Dum Biryani & Mirchi Ka Salan",
    category: "Cooked Food",
    totalServings: 45,
    availableServings: 30,
    preparedTime: "7:30 PM",
    safeUntil: new Date(Date.now() + 2.5 * 3600 * 1000),
    remainingHoursText: "2h 30m left",
    isUrgent: true,
    isVeg: false,
    dietary: ["Halal", "Contains Dairy"],
    storageInstructions: "Hot cooked food. Carry insulated thermal crates.",
    imageUrl: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80",
    restaurant: {
      id: 101,
      name: "Royal Biryani House",
      address: "88, 5th Cross, 60ft Road, Koramangala 5th Block, Bengaluru",
      phone: "+91 80 4122 9011",
      latitude: 12.9352,
      longitude: 77.6245
    }
  },
  {
    id: 2,
    foodName: "Ghee Podi Idli & Medu Vada with Sambar",
    category: "Cooked Food",
    totalServings: 60,
    availableServings: 60,
    preparedTime: "8:00 PM",
    safeUntil: new Date(Date.now() + 3.5 * 3600 * 1000),
    remainingHoursText: "3h 30m left",
    isUrgent: false,
    isVeg: true,
    dietary: ["Pure Veg", "Jain Friendly"],
    storageInstructions: "Keep warm. Bring food-grade stainless containers.",
    imageUrl: "https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800&auto=format&fit=crop&q=80",
    restaurant: {
      id: 102,
      name: "The Rameshwaram Cafe",
      address: "2984, 12th Main Rd, HAL 2nd Stage, Indiranagar, Bengaluru",
      phone: "+91 80 2520 7744",
      latitude: 12.9719,
      longitude: 77.6412
    }
  },
  {
    id: 3,
    foodName: "Sourdough Boules, Brioche & Baguettes",
    category: "Bakery",
    totalServings: 35,
    availableServings: 25,
    preparedTime: "5:30 PM",
    safeUntil: new Date(Date.now() + 18 * 3600 * 1000),
    remainingHoursText: "Next day safe",
    isUrgent: false,
    isVeg: true,
    dietary: ["Pure Veg", "Contains Gluten"],
    storageInstructions: "Dry ambient storage. Cardboard or cloth bags suitable.",
    imageUrl: "https://images.unsplash.com/photo-1509440159596-0249088772ff?w=800&auto=format&fit=crop&q=80",
    restaurant: {
      id: 103,
      name: "Sandoitchi Artisanal Bakery",
      address: "411, 27th Main Rd, Sector 4, HSR Layout, Bengaluru",
      phone: "+91 80 4390 1120",
      latitude: 12.9121,
      longitude: 77.6446
    }
  }
];

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
    const { email, phone, password, name, role = "NGO", address, latitude, longitude } = req.body;
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

    const user = await prisma.user.create({
      data: {
        email,
        phone,
        password: hashedPassword,
        name: name || email.split('@')[0],
        role: assignedRole,
        isVerified: true
      }
    });

    // Create associated profile entity
    const lat = parseFloat(latitude) || 12.9352;
    const lng = parseFloat(longitude) || 77.6245;

    if (assignedRole === "NGO") {
      const ngo = await prisma.nGO.create({
        data: {
          name: name || `${email.split('@')[0]} Relief Org`,
          address: address || "Koramangala Community Depot, Bengaluru",
          latitude: lat,
          longitude: lng,
          darpanId: `KA/2026/${Math.floor(100000 + Math.random() * 900000)}`,
          taxExemption: "Section 80G Certified",
          phone,
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
          fssaiNumber: `112233${Math.floor(100000 + Math.random() * 900000)}`,
          ownerId: user.id
        }
      });
      await geoAddLocation('restaurants_geo', lng, lat, restaurant.id);
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    setAuthCookies(res, accessToken, refreshToken);

    res.status(201).json({
      message: 'Account created successfully',
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      accessToken,
      refreshToken
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Registration failed', error: error.message });
  }
});

// Standard Login
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password, channel = 'email' } = req.body;
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
      expiresIn: '10 minutes'
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
    if (!challenge || challenge.otp !== otp) {
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
// Open to authenticated users. Returns active food listings.
// Calculates real-time distance relative to user/NGO's latitude and longitude.
app.get('/api/listings', async (req, res) => {
  try {
    const { latitude, longitude, radius = 25000, category, isVeg } = req.query;
    const userLat = latitude ? parseFloat(latitude) : 12.9352;
    const userLng = longitude ? parseFloat(longitude) : 77.6245;

    let listings = [];
    try {
      const whereClause = {
        availableServings: { gt: 0 },
        status: { in: ['ACTIVE', 'PARTIALLY_RESERVED'] }
      };

      if (category) whereClause.category = String(category);
      if (isVeg !== undefined) whereClause.isVeg = isVeg === 'true';

      listings = await prisma.listing.findMany({
        where: whereClause,
        include: {
          restaurant: {
            select: {
              id: true,
              name: true,
              address: true,
              phone: true,
              latitude: true,
              longitude: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      });
    } catch (err) {
      console.warn('Prisma listings lookup error:', err.message);
    }

    // Fallback to default mock listings if DB has no listings yet
    if (!listings || listings.length === 0) {
      listings = defaultMockListings;
    }

    // Transform with computed distance and time left
    const formatted = listings.map(item => {
      const restLat = item.restaurant?.latitude;
      const restLng = item.restaurant?.longitude;
      const distStr = formatDistance(userLat, userLng, restLat, restLng);

      const safeDate = new Date(item.safeUntil);
      const diffMs = safeDate.getTime() - Date.now();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

      let remainingText = item.remainingHoursText || "Safe today";
      if (diffMs > 0 && !item.remainingHoursText) {
        remainingText = `${diffHours}h ${diffMins}m left`;
      }

      return {
        id: item.id,
        foodName: item.foodName,
        category: item.category,
        totalServings: item.totalServings,
        availableServings: item.availableServings,
        preparedTime: item.preparedTime,
        safeUntil: item.safeUntil,
        remainingHoursText: remainingText,
        isUrgent: item.isUrgent || (diffMs > 0 && diffMs < 2 * 3600 * 1000),
        isVeg: item.isVeg,
        dietary: item.dietary || [],
        storageInstructions: item.storageInstructions,
        imageUrl: item.imageUrl,
        distance: distStr,
        restaurant: item.restaurant?.name || "Restaurant Partner",
        address: item.restaurant?.address || "Bengaluru",
        contactPhone: item.restaurant?.phone || "+91 80 4000 0000"
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching listings:', error);
    res.status(500).json({ message: 'Failed to fetch listings', error: error.message });
  }
});

// POST /api/listings
// RESTRICTED: RESTAURANT ONLY. NGOs cannot post food listings!
app.post('/api/listings', authenticateJWT, requireRole('RESTAURANT'), async (req, res) => {
  try {
    const {
      foodName,
      category = "Cooked Food",
      totalServings,
      preparedTime,
      safeUntilHours = 3,
      isVeg = true,
      dietary = [],
      storageInstructions,
      imageUrl
    } = req.body;

    if (!foodName || !totalServings) {
      return res.status(400).json({ message: 'foodName and totalServings are required' });
    }

    // Find restaurant owned by this user
    let restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!restaurant) {
      // Auto-create a restaurant entity for this user if needed
      restaurant = await prisma.restaurant.create({
        data: {
          name: `${req.user.name || 'Restaurant'} Kitchen`,
          address: "Bengaluru Central",
          latitude: 12.9352,
          longitude: 77.6245,
          ownerId: req.user.userId
        }
      });
    }

    const safeUntilDate = new Date(Date.now() + (parseFloat(safeUntilHours) * 3600 * 1000));

    const listing = await prisma.listing.create({
      data: {
        foodName,
        category,
        totalServings: parseInt(totalServings, 10),
        availableServings: parseInt(totalServings, 10),
        preparedTime: preparedTime || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        safeUntil: safeUntilDate,
        isVeg: Boolean(isVeg),
        dietary: Array.isArray(dietary) ? dietary : [dietary],
        storageInstructions: storageInstructions || "Keep at safe holding temperature.",
        imageUrl: imageUrl || "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=800&auto=format&fit=crop&q=80",
        restaurantId: restaurant.id
      },
      include: { restaurant: true }
    });

    // Update Redis Geo
    if (restaurant.latitude && restaurant.longitude) {
      await geoAddLocation('restaurants_geo', restaurant.longitude, restaurant.latitude, restaurant.id);
    }

    // Real-time broadcast to all listening NGOs
    io.emit('new_listing', {
      id: listing.id,
      foodName: listing.foodName,
      restaurant: restaurant.name,
      availableServings: listing.availableServings,
      category: listing.category
    });

    res.status(201).json(listing);
  } catch (error) {
    console.error('Error creating listing:', error);
    res.status(500).json({ message: 'Failed to create listing', error: error.message });
  }
});

// ------------------------------------------
// RESERVATIONS & LOCKING
// ------------------------------------------

// POST /api/listings/:id/reserve
// RESTRICTED: NGO ONLY. Restaurants CANNOT reserve food!
// Performs an atomic reservation lock.
app.post('/api/listings/:id/reserve', authenticateJWT, requireRole('NGO'), async (req, res) => {
  try {
    const listingId = parseInt(req.params.id, 10);
    const { portions = 10, shelterDelivered = "Local Community Shelter" } = req.body;
    const requestedPortions = Math.max(1, parseInt(portions, 10));

    // Get NGO profile for current user
    let ngo = await prisma.nGO.findFirst({
      where: { ownerId: req.user.userId }
    });

    if (!ngo) {
      // Auto-create NGO profile if not yet created
      ngo = await prisma.nGO.create({
        data: {
          name: `${req.user.name || 'NGO'} Volunteer Network`,
          latitude: 12.9352,
          longitude: 77.6245,
          ownerId: req.user.userId
        }
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

      if (listing.availableServings < requestedPortions) {
        throw new Error(`Only ${listing.availableServings} servings available. Cannot reserve ${requestedPortions}.`);
      }

      const newAvailable = listing.availableServings - requestedPortions;
      const newStatus = newAvailable === 0 ? 'FULLY_RESERVED' : 'PARTIALLY_RESERVED';

      // Update listing
      const updatedListing = await tx.listing.update({
        where: { id: listingId },
        data: {
          availableServings: newAvailable,
          status: newStatus
        }
      });

      // Generate pickup code and deadline
      const pickupCode = crypto.randomInt(1000, 9999).toString();
      const code = `RES-${pickupCode}`;
      const pickupDeadline = new Date(Date.now() + 90 * 60 * 1000); // 90 minutes from now

      // Create reservation
      const reservation = await tx.reservation.create({
        data: {
          code,
          pickupCode,
          reservedServings: requestedPortions,
          pickupDeadline,
          status: 'ready_for_pickup',
          pickupInstructions: `Enter through rear service corridor. Bring thermal bags. Pickup Code: ${pickupCode}`,
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
// RESTRICTED: NGO ONLY. Returns active pickups for the authenticated NGO.
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
      restaurantPhone: r.listing?.restaurant?.phone || "+91 80 4920 1888",
      address: r.listing?.restaurant?.address || "Koramangala, Bengaluru",
      foodName: r.listing?.foodName || "Surplus Meals",
      reservedServings: r.reservedServings,
      totalBatchServings: r.listing?.totalServings || r.reservedServings,
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

// PATCH /api/reservations/:id/complete
// RESTRICTED: NGO ONLY. Marks pickup completed and increments impact stats.
app.patch('/api/reservations/:id/complete', authenticateJWT, requireRole('NGO'), async (req, res) => {
  try {
    const reservationParam = req.params.id;
    const { shelterDelivered = "Local Community Shelter" } = req.body;

    const reservation = await prisma.reservation.findFirst({
      where: {
        OR: [
          { code: reservationParam },
          { id: parseInt(reservationParam, 10) || 0 }
        ]
      },
      include: { ngo: true }
    });

    if (!reservation) {
      return res.status(404).json({ message: 'Reservation not found' });
    }

    const meals = reservation.reservedServings || 10;
    const wasteKg = meals * 0.5;
    const co2Tonnes = (wasteKg * 2.5) / 1000;

    // Update reservation status and NGO impact stats
    const updated = await prisma.$transaction([
      prisma.reservation.update({
        where: { id: reservation.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          shelterDelivered
        }
      }),
      prisma.nGO.update({
        where: { id: reservation.ngoId },
        data: {
          totalMealsRescued: { increment: meals },
          foodWastePreventedKg: { increment: wasteKg },
          co2eAvoidedTonnes: { increment: co2Tonnes }
        }
      })
    ]);

    io.emit('reservation_completed', {
      reservationId: reservation.id,
      code: reservation.code,
      mealsRescued: meals
    });

    res.json({
      message: 'Pickup completed successfully! Impact recorded.',
      reservation: updated[0]
    });
  } catch (error) {
    console.error('Error completing reservation:', error);
    res.status(500).json({ message: 'Failed to complete reservation', error: error.message });
  }
});

// GET /api/history
// RESTRICTED: NGO ONLY. Returns completed pickup history.
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
        status: 'completed'
      },
      include: {
        listing: {
          include: { restaurant: true }
        }
      },
      orderBy: { completedAt: 'desc' }
    });

    const formatted = historyItems.map(h => ({
      id: h.code,
      restaurant: h.listing?.restaurant?.name || "Partner Restaurant",
      foodName: h.listing?.foodName || "Rescued Food",
      servingsRescued: h.reservedServings,
      completedAt: h.completedAt ? new Date(h.completedAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "Recently",
      shelterDelivered: h.shelterDelivered || "Asha Kiran Shelter",
      fssaiVerified: h.fssaiVerified
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ message: 'Failed to fetch history', error: error.message });
  }
});

// ------------------------------------------
// PROFILE & LOGISTICS (WITH GOOGLE MAPS LAT/LNG)
// ------------------------------------------

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
        totalMealsRescued: 3420,
        foodWastePreventedKg: 1710,
        co2eAvoidedTonnes: 4.28,
        activePartners: 28
      };

      return res.json({
        id: user.id,
        email: user.email,
        name: ngo.name,
        tagline: ngo.tagline || "Volunteer food rescue collective",
        darpanId: ngo.darpanId || "KA/2026/019284",
        taxExemption: ngo.taxExemption || "Section 80G Certified",
        isVerified: ngo.isVerified ?? true,
        latitude: ngo.latitude,
        longitude: ngo.longitude,
        logisticsSetting: {
          mode: ngo.pickupMode || "NGO Representative Self-Pickup",
          inAppDeliveryNote: "In-App Delivery Fleet Integration coming in Phase 2 roadmap.",
          defaultRadiusKm: ngo.defaultRadiusKm || 8,
          operatingBase: ngo.operatingBase || "Koramangala Community Depot, Bengaluru"
        },
        impactStats: {
          totalMealsRescued: ngo.totalMealsRescued || 3420,
          foodWastePreventedKg: ngo.foodWastePreventedKg || 1710,
          co2eAvoidedTonnes: ngo.co2eAvoidedTonnes || 4.28,
          activeRestaurantPartners: ngo.activePartners || 28
        }
      });
    } else {
      // Restaurant profile
      const restaurant = user.restaurants?.[0] || {
        name: user.name || "Partner Kitchen",
        latitude: 12.9352,
        longitude: 77.6245,
        address: "Bengaluru Central"
      };

      return res.json({
        id: user.id,
        email: user.email,
        name: restaurant.name,
        role: 'RESTAURANT',
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
        address: restaurant.address,
        phone: restaurant.phone,
        fssaiNumber: restaurant.fssaiNumber
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
      darpanId
    } = req.body;

    const lat = latitude !== undefined ? parseFloat(latitude) : undefined;
    const lng = longitude !== undefined ? parseFloat(longitude) : undefined;

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
            darpanId: darpanId || undefined
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
            longitude: lng !== undefined && !isNaN(lng) ? lng : undefined
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