const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const twilio = require('twilio');
const XLSX = require('xlsx');
require('dotenv').config({ path: __dirname + '/.env' });

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const twilioFromNumber = process.env.TWILIO_PHONE_NUMBER || null;
const twilioVerifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID || null;
const verifyServiceUrl = process.env.VERIFY_SERVICE_URL || null;
const verifyServiceApiKey = process.env.VERIFY_SERVICE_API_KEY || null;
const verifyServiceAuthHeader = process.env.VERIFY_SERVICE_AUTH_HEADER || 'Authorization';
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';

const formatPhoneE164 = (phone) => phone.startsWith('+') ? phone : `+91${phone}`;

function signAuthToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || 'jeevanconnect_secret', { expiresIn: '7d' });
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  if (req.body && req.body.token) {
    return req.body.token;
  }

  return null;
}

function isValidAdminKey(req) {
  const headerKey = req.headers['x-admin-key'];
  const bodyKey = req.body?.adminKey;
  const suppliedKey = (headerKey || bodyKey || '').toString();
  const expectedKey = (process.env.ADMIN_MIGRATION_KEY || '').toString();

  if (!expectedKey) return true;
  return suppliedKey === expectedKey;
}

async function requireHospitalAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'jeevanconnect_secret');
    if (decoded.role !== 'hospital' || !decoded.hospitalId) {
      return res.status(403).json({ success: false, message: 'Hospital access required' });
    }

    const hospital = await Hospital.findById(decoded.hospitalId);
    if (!hospital) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    req.authHospital = hospital;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

function toObjectIdOrNull(value) {
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(String(value)) ? value : null;
}

async function resolveDriverMongoId(...candidates) {
  for (const raw of candidates) {
    if (!raw) continue;
    const value = String(raw).trim();
    if (!value) continue;

    if (mongoose.Types.ObjectId.isValid(value)) {
      return value;
    }

    try {
      const driver = await Driver.findOne({
        $or: [
          { driverId: value },
          { loginId: value.toLowerCase() },
          { ambulanceId: value },
          { phone: value }
        ]
      }).select('_id');

      if (driver?._id) {
        return String(driver._id);
      }
    } catch (_) {
      // Ignore lookup errors and keep trying other candidates.
    }
  }

  return null;
}

async function sendOtpViaTwilioVerify(phone) {
  if (!twilioClient || !twilioVerifyServiceSid) return false;
  try {
    const to = formatPhoneE164(phone);
    const verification = await twilioClient.verify.v2
      .services(twilioVerifyServiceSid)
      .verifications.create({ to, channel: 'sms' });
    return verification.status === 'pending';
  } catch (error) {
    console.error('Twilio Verify error:', error.message || error);
    return false;
  }
}

async function checkOtpViaTwilioVerify(phone, code) {
  if (!twilioClient || !twilioVerifyServiceSid) return false;
  try {
    const to = formatPhoneE164(phone);
    const verificationCheck = await twilioClient.verify.v2
      .services(twilioVerifyServiceSid)
      .verificationChecks.create({ to, code });
    return verificationCheck.status === 'approved';
  } catch (error) {
    console.error('Twilio Verify check error:', error.message || error);
    return false;
  }
}

async function sendOtpViaCustomService(phone, otp) {
  if (!verifyServiceUrl) return false;

  const payload = {
    phone: formatPhoneE164(phone),
    otp,
    message: `Your Jeevan Connect OTP is ${otp}`
  };

  const headers = {
    'Content-Type': 'application/json'
  };
  if (verifyServiceApiKey) {
    headers[verifyServiceAuthHeader] = `Bearer ${verifyServiceApiKey}`;
  }

  try {
    const response = await fetch(verifyServiceUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    return response.ok;
  } catch (error) {
    console.error('Custom verify service error:', error.message || error);
    return false;
  }
}

if (!twilioClient || !twilioFromNumber) {
  console.warn('Twilio is not fully configured. OTP will be logged in the backend console and demo OTP will be returned instead.');
} else {
  console.log('Twilio SMS is configured. OTP messages will be sent via Twilio.');
}
if (verifyServiceUrl) {
  console.log('Custom verify service is configured. OTP may be sent using this service.');
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:8080',
      'http://127.0.0.1:8080'
    ],
    methods: ["GET", "POST"]
  }
});

// Lightweight in-memory dispatch state for real-time SOS flow.
const onlineDrivers = new Map(); // socketId -> { driverId, name, vehicle, location, isAvailable }
const activeDispatches = new Map(); // sosId -> { citizenSocketId, payload, status, driverSocketId }

const MUMBAI_LOCATION_REFERENCE = [
  { name: 'Colaba', lat: 18.9067, lng: 72.8147 },
  { name: 'Mumbai Central', lat: 18.9681, lng: 72.8190 },
  { name: 'Parel', lat: 18.9986, lng: 72.8437 },
  { name: 'Dadar', lat: 19.0178, lng: 72.8478 },
  { name: 'Sion', lat: 19.0467, lng: 72.8619 },
  { name: 'Bandra West', lat: 19.0596, lng: 72.8295 },
  { name: 'Kurla', lat: 19.0728, lng: 72.8826 },
  { name: 'Ghatkopar', lat: 19.0846, lng: 72.9069 },
  { name: 'Andheri West', lat: 19.1197, lng: 72.8468 },
  { name: 'Juhu', lat: 19.1075, lng: 72.8372 },
  { name: 'Powai', lat: 19.1176, lng: 72.9060 },
  { name: 'Goregaon', lat: 19.1663, lng: 72.8526 },
  { name: 'Malad', lat: 19.1864, lng: 72.8480 },
  { name: 'Kandivali', lat: 19.2043, lng: 72.8510 },
  { name: 'Borivali', lat: 19.2307, lng: 72.8567 }
];

function pickNearestAvailableDriver(targetLocation) {
  const drivers = Array.from(onlineDrivers.entries())
    .filter(([, driver]) => driver.isAvailable);

  if (!drivers.length) return null;
  if (!targetLocation || typeof targetLocation.lat !== 'number' || typeof targetLocation.lng !== 'number') {
    return { socketId: drivers[0][0], driver: drivers[0][1] };
  }

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const [socketId, driver] of drivers) {
    if (!driver.location || typeof driver.location.lat !== 'number' || typeof driver.location.lng !== 'number') {
      if (!best) {
        best = { socketId, driver };
      }
      continue;
    }

    const dLat = driver.location.lat - targetLocation.lat;
    const dLng = driver.location.lng - targetLocation.lng;
    const score = (dLat * dLat) + (dLng * dLng);
    if (score < bestScore) {
      best = { socketId, driver };
      bestScore = score;
    }
  }

  return best;
}

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || (15 * 60 * 1000)),
  max: Number(process.env.RATE_LIMIT_MAX || 1200),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const ip = String(req.ip || '').toLowerCase();
    const host = String(req.hostname || '').toLowerCase();
    return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || host === 'localhost' || host === '127.0.0.1';
  }
});
app.use(limiter);

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'Jeevan Connect Backend',
    message: 'API is running',
    endpoints: {
      config: '/api/config',
      health: '/health'
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    uptime: Math.round(process.uptime())
  });
});

app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  const runtimeGoogleMapsApiKey = (process.env.GOOGLE_MAPS_API_KEY || googleMapsApiKey || '').trim();
  res.json({
    googleMapsApiKey: runtimeGoogleMapsApiKey
  });
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'jeevanconnect_secret');

    if (decoded.role === 'driver' && decoded.driverId) {
      const driver = await Driver.findById(decoded.driverId);
      if (!driver) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
      }

      return res.json({
        success: true,
        user: {
          role: 'driver',
          id: driver._id,
          phone: driver.phone,
          name: driver.name,
          ambulanceId: driver.ambulanceId,
          vehicleType: driver.vehicleType
        }
      });
    }

    if (decoded.userId) {
      const user = await User.findById(decoded.userId);
      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
      }

      return res.json({
        success: true,
        user: {
          role: user.role || 'citizen',
          id: user._id,
          phone: user.phone,
          name: user.name,
          email: user.email,
          bloodGroup: user.bloodGroup
        }
      });
    }

    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/jeevanconnect', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch((err) => {
  console.error('MongoDB connection error:', err?.message || err);
  if (err?.stack) {
    console.error(err.stack);
  }
});

// Models
const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  name: String,
  email: String,
  bloodGroup: String,
  medicalProfile: {
    organDonor: { type: String, enum: ['yes', 'no', 'unknown'], default: 'unknown' },
    allergies: [{ type: String }],
    conditions: [{
      name: String,
      status: String
    }],
    medications: [{
      name: String,
      frequency: String
    }],
    emergencyNote: { type: String, default: '' }
  },
  role: { type: String, enum: ['citizen', 'driver'], default: 'citizen' },
  isVerified: { type: Boolean, default: false },
  lastLoginAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const DriverSchema = new mongoose.Schema({
  driverId: { type: String, unique: true, sparse: true },
  loginId: { type: String, unique: true, sparse: true },
  password: { type: String, default: 'Driver@123' },
  phone: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  licenseNumber: String,
  vehicleType: { type: String, default: 'Basic Life Support' },
  ambulanceId: String,
  status: { type: String, enum: ['available', 'busy', 'offline'], default: 'offline' },
  isOnline: { type: Boolean, default: false },
  lastLoginAt: Date,
  location: {
    lat: Number,
    lng: Number,
    address: String,
    city: String,
    state: String,
    simulated: { type: Boolean, default: true },
    lastUpdated: Date
  },
  createdAt: { type: Date, default: Date.now }
});

const EmergencySchema = new mongoose.Schema({
  citizenName: String,
  citizenPhone: String,
  citizenId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  requestChannel: { type: String, enum: ['api', 'socket'], default: 'api' },
  initiatedBy: {
    role: { type: String, enum: ['citizen', 'admin', 'system', 'unknown'], default: 'unknown' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String,
    phone: String,
    socketId: String
  },
  emergencyType: String,
  location: {
    lat: Number,
    lng: Number,
    address: String
  },
  status: { type: String, enum: ['pending', 'assigned', 'enroute', 'arrived', 'completed', 'cancelled'], default: 'pending' },
  assignedDriver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  assignedDriverSnapshot: {
    driverId: String,
    loginId: String,
    ambulanceId: String,
    name: String,
    vehicle: String,
    phone: String,
    source: String,
    distanceKm: Number,
    location: {
      lat: Number,
      lng: Number,
      address: String,
      city: String,
      state: String
    }
  },
  assignedHospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  ambulancePickedAt: Date,
  hospitalAssignedAt: Date,
  completedAt: Date,
  cancelledAt: Date,
  cancelledBy: {
    role: { type: String, enum: ['citizen', 'admin', 'system', 'unknown'], default: 'unknown' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String,
    phone: String,
    socketId: String
  },
  priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'high' },
  description: String,
  medicalSnapshot: {
    bloodGroup: String,
    organDonor: String,
    allergies: [String],
    conditions: [{
      name: String,
      status: String
    }],
    medications: [{
      name: String,
      frequency: String
    }],
    emergencyNote: String
  },
  createdAt: { type: Date, default: Date.now }
});

const HospitalSchema = new mongoose.Schema({
  name: { type: String, required: true },
  hospitalNo: Number,
  loginId: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  passwordHash: String,
  lastLoginAt: Date,
  source: { type: String, default: 'system' },
  type: { type: String, enum: ['Government', 'Private', 'Trust'], default: 'Government' },
  specialties: [String],
  distance: Number,
  driveTime: String,
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: String,
    city: String,
    state: String
  },
  facilities: {
    icuBeds: { type: Number, default: 0 },
    generalBeds: { type: Number, default: 0 },
    lowBeds: { type: Number, default: 0 },
    totalBeds: { type: Number, default: 0 }
  },
  services: {
    opd: { type: String, enum: ['Open', 'Closed', 'Busy'], default: 'Open' },
    lab: { type: String, default: '24/7' },
    bloodBank: { type: String, default: 'Available' },
    parking: { type: String, default: 'Free' },
    trauma: { type: Boolean, default: false },
    cardiology: { type: Boolean, default: false }
  },
  operatingHours: String,
  phoneNumber: String,
  rating: { type: Number, default: 4.5 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Driver = mongoose.model('Driver', DriverSchema);
const Emergency = mongoose.model('Emergency', EmergencySchema);
const Hospital = mongoose.model('Hospital', HospitalSchema);

function getDriverAvailabilityStatus(driver = {}) {
  const status = String(driver.status || '').toLowerCase();
  if (status) return status;
  return driver.isOnline ? 'available' : 'offline';
}

function getDriverLocation(driver = {}) {
  const lat = Number(driver.location?.lat ?? driver.lat);
  const lng = Number(driver.location?.lng ?? driver.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

function inferMumbaiLocality(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const point of MUMBAI_LOCATION_REFERENCE) {
    const distance = calculateDistance(lat, lng, point.lat, point.lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }

  if (!best) return null;
  return `${best.name}, Mumbai, Maharashtra`;
}

function snapToNearestMumbaiLandPoint(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const point of MUMBAI_LOCATION_REFERENCE) {
    const distance = calculateDistance(lat, lng, point.lat, point.lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }

  if (!best) return null;
  return {
    lat: best.lat,
    lng: best.lng,
    address: `${best.name}, Mumbai, Maharashtra`,
    city: 'Mumbai',
    state: 'Maharashtra',
    distanceKm: bestDistance
  };
}

function buildDriverLocation(location = {}, fallback = {}) {
  const lat = Number(location.lat ?? fallback.lat);
  const lng = Number(location.lng ?? fallback.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const snapped = snapToNearestMumbaiLandPoint(lat, lng);
  const likelyWaterOrOutlier = lng < 72.81 || !snapped || snapped.distanceKm > 6;
  const safeLat = likelyWaterOrOutlier && snapped ? snapped.lat : lat;
  const safeLng = likelyWaterOrOutlier && snapped ? snapped.lng : lng;

  const inferredAddress = inferMumbaiLocality(safeLat, safeLng);

  return {
    lat: safeLat,
    lng: safeLng,
    address: String(location.address || fallback.address || snapped?.address || inferredAddress || 'Mumbai, Maharashtra'),
    city: String(location.city || fallback.city || 'Mumbai'),
    state: String(location.state || fallback.state || 'Maharashtra'),
    simulated: location.simulated === undefined ? true : Boolean(location.simulated),
    lastUpdated: location.lastUpdated ? new Date(location.lastUpdated) : new Date()
  };
}

function formatDriverLocationLabel(location = {}) {
  if (!location) return 'Location unavailable';
  if (location.address) return location.address;
  if (location.city || location.state) {
    return [location.city, location.state].filter(Boolean).join(', ');
  }

  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return inferMumbaiLocality(lat, lng) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  return 'Location unavailable';
}

function getDriverSocketLocation(driver = {}) {
  if (!driver.location || typeof driver.location.lat !== 'number' || typeof driver.location.lng !== 'number') return null;
  return { lat: driver.location.lat, lng: driver.location.lng };
}

function normalizeDriverKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

async function cancelEmergencyAndDispatch({ emergencyId, sosId, cancelledBy = {} } = {}) {
  let dispatchEntry = null;

  if (sosId && activeDispatches.has(sosId)) {
    dispatchEntry = { sosId, dispatch: activeDispatches.get(sosId) };
  }

  if (!dispatchEntry && emergencyId) {
    const emergencyKey = String(emergencyId);
    for (const [key, dispatch] of activeDispatches.entries()) {
      const dispatchEmergencyId = String(dispatch?.payload?.emergencyId || dispatch?.payload?.emergencyMongoId || '');
      if (dispatchEmergencyId && dispatchEmergencyId === emergencyKey) {
        dispatchEntry = { sosId: key, dispatch };
        break;
      }
    }
  }

  const resolvedEmergencyId = String(
    emergencyId || dispatchEntry?.dispatch?.payload?.emergencyId || dispatchEntry?.dispatch?.payload?.emergencyMongoId || ''
  ).trim();

  if (!resolvedEmergencyId || !mongoose.Types.ObjectId.isValid(resolvedEmergencyId)) {
    return { success: false, message: 'Valid emergency id is required for cancellation' };
  }

  const emergency = await Emergency.findById(resolvedEmergencyId);
  if (!emergency) {
    return { success: false, message: 'Emergency not found' };
  }

  if (emergency.status === 'completed') {
    return { success: false, message: 'Completed emergencies cannot be cancelled' };
  }

  if (dispatchEntry?.dispatch) {
    const dispatch = dispatchEntry.dispatch;

    if (dispatch.driverSocketId) {
      const liveDriver = onlineDrivers.get(dispatch.driverSocketId);
      if (liveDriver) {
        onlineDrivers.set(dispatch.driverSocketId, {
          ...liveDriver,
          isAvailable: true
        });
      }

      io.to(dispatch.driverSocketId).emit('sos-cancelled', {
        sosId: dispatchEntry.sosId,
        emergencyId: resolvedEmergencyId,
        message: 'Citizen cancelled this SOS request'
      });
    }

    if (dispatch.payload?.driverMongoId && mongoose.Types.ObjectId.isValid(String(dispatch.payload.driverMongoId))) {
      await Driver.findByIdAndUpdate(dispatch.payload.driverMongoId, { status: 'available', isOnline: true }).catch(() => {});
    }

    if (dispatch.citizenSocketId) {
      io.to(dispatch.citizenSocketId).emit('sos-cancelled', {
        sosId: dispatchEntry.sosId,
        emergencyId: resolvedEmergencyId,
        message: 'SOS request cancelled'
      });
    }

    activeDispatches.delete(dispatchEntry.sosId);
  }

  emergency.status = 'cancelled';
  emergency.cancelledAt = new Date();
  emergency.cancelledBy = {
    role: ['citizen', 'admin', 'system', 'unknown'].includes(cancelledBy.role) ? cancelledBy.role : 'citizen',
    userId: toObjectIdOrNull(cancelledBy.userId) || emergency.cancelledBy?.userId || null,
    name: cancelledBy.name || emergency.cancelledBy?.name || emergency.citizenName || 'Unknown Citizen',
    phone: cancelledBy.phone || emergency.cancelledBy?.phone || emergency.citizenPhone || '',
    socketId: cancelledBy.socketId || ''
  };
  await emergency.save();

  return {
    success: true,
    emergencyId: String(emergency._id),
    sosId: dispatchEntry?.sosId || sosId || null,
    status: emergency.status
  };
}

function getCandidateDriverKeys(candidate = {}) {
  return [
    candidate.mongoId,
    candidate.driverId,
    candidate.loginId,
    candidate.ambulanceId,
    candidate.name,
    candidate.vehicle
  ].map(normalizeDriverKey).filter(Boolean);
}

function findSocketIdForCandidate(candidate = {}) {
  const targetKeys = new Set(getCandidateDriverKeys(candidate));
  if (!targetKeys.size) return null;

  for (const [socketId, live] of onlineDrivers.entries()) {
    if (live?.isAvailable === false) continue;
    const liveKeys = [
      live.driverId,
      live.id,
      live.loginId,
      live.ambulanceId,
      live.vehicle,
      live.name
    ].map(normalizeDriverKey).filter(Boolean);

    if (liveKeys.some((key) => targetKeys.has(key))) {
      return socketId;
    }
  }

  return null;
}

async function getAvailableAmbulanceCandidates(options = {}) {
  const excludedKeys = new Set((options.excludeDriverKeys || []).map(normalizeDriverKey).filter(Boolean));

  for (const [, dispatch] of activeDispatches.entries()) {
    if (!dispatch || !dispatch.payload) continue;
    if (dispatch.status !== 'assigned' && dispatch.status !== 'enroute' && dispatch.status !== 'hospital_assigned') continue;

    [
      dispatch.payload.driverMongoId,
      dispatch.payload.driverId,
      dispatch.payload.driverLoginId,
      dispatch.payload.driverAmbulanceId
    ].map(normalizeDriverKey).filter(Boolean).forEach((key) => excludedKeys.add(key));
  }

  try {
    const records = await Driver.find({ status: 'available' }).lean();
    return records.map((driver) => {
      const location = getDriverLocation(driver);
      if (!location) return null;

      const candidate = {
        source: 'mongodb',
        mongoId: String(driver._id),
        driverId: driver.driverId || '',
        loginId: driver.loginId || '',
        ambulanceId: driver.ambulanceId || '',
        name: driver.name || 'Ambulance Driver',
        vehicle: driver.ambulanceId || driver.vehicleType || 'Ambulance Unit',
        phone: driver.phone || '',
        isAvailable: true,
        location,
        socketId: null
      };

      candidate.socketId = findSocketIdForCandidate(candidate);
      const keys = getCandidateDriverKeys(candidate);
      if (keys.some((key) => excludedKeys.has(key))) return null;

      return candidate;
    }).filter(Boolean);
  } catch (error) {
    console.warn('Could not load ambulance candidates from MongoDB:', error.message || error);
    return [];
  }
}

function rankAmbulancesByDistance(targetLocation, candidates = []) {
  const withDistance = candidates.filter((driver) => driver.location && typeof driver.location.lat === 'number' && typeof driver.location.lng === 'number')
    .map((driver) => {
      const distanceKm = (targetLocation && typeof targetLocation.lat === 'number' && typeof targetLocation.lng === 'number')
        ? calculateDistance(targetLocation.lat, targetLocation.lng, driver.location.lat, driver.location.lng)
        : Number.POSITIVE_INFINITY;
      return { ...driver, distanceKm: Number.isFinite(distanceKm) ? distanceKm : null };
    });

  withDistance.sort((a, b) => {
    const da = Number.isFinite(a.distanceKm) ? a.distanceKm : Number.POSITIVE_INFINITY;
    const db = Number.isFinite(b.distanceKm) ? b.distanceKm : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return normalizeDriverKey(a.name).localeCompare(normalizeDriverKey(b.name));
  });

  return withDistance;
}

function pickNearestAmbulance(targetLocation, candidates = []) {
  const ranked = rankAmbulancesByDistance(targetLocation, candidates);
  return {
    selected: ranked.length ? ranked[0] : null,
    ranked
  };
}

function getEmergencyHospitalProfile(emergencyType = '') {
  const lower = String(emergencyType || '').toLowerCase();
  return {
    critical: /cardiac|stroke|critical|heart|brain|trauma|accident/.test(lower),
    trauma: /accident|trauma|injury|fracture|bleed|bleeding/.test(lower),
    neuro: /stroke|neuro|brain/.test(lower),
    cardiac: /cardiac|heart|chest pain|heart attack/.test(lower)
  };
}

function normalizeGeoPoint(point = {}) {
  if (!point || typeof point !== 'object') return null;
  const lat = Number(point.lat ?? point.latitude);
  const lng = Number(point.lng ?? point.longitude ?? point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function selectBestHospitalForEmergency(emergencyType, patientLocation) {
  const patientPoint = normalizeGeoPoint(patientLocation);
  if (!patientPoint) return null;

  // Use the same nearby source as hospital finder UI so assignment matches what user sees.
  let nearby = await fetchGoogleNearbyHospitals(patientPoint.lat, patientPoint.lng, 10);
  if (!nearby.length) {
    nearby = getLocalMumbaiNearbyHospitals(patientPoint.lat, patientPoint.lng, 10);
  }
  if (!nearby.length) {
    nearby = mockHospitals.map((hospital) => {
      const point = normalizeGeoPoint(hospital.location || {});
      if (!point) return null;
      const distanceKm = calculateDistance(patientPoint.lat, patientPoint.lng, point.lat, point.lng);
      return {
        ...hospital,
        distance: Number(distanceKm.toFixed(1)),
        driveTime: `${Math.max(2, Math.ceil(distanceKm * 1.5))} min drive`,
        source: 'fallback-mock'
      };
    }).filter(Boolean);
  }

  if (!nearby.length) return null;

  const profile = getEmergencyHospitalProfile(emergencyType);
  const ranked = nearby
    .map((hospital) => {
      const point = normalizeGeoPoint(hospital.location || {});
      if (!point) return null;

      const distanceKm = calculateDistance(patientPoint.lat, patientPoint.lng, point.lat, point.lng);
      const icuBeds = Number(hospital.facilities?.icuBeds || 0);
      const tieCapabilityScore =
        (profile.trauma && hospital.services?.trauma ? 2 : 0)
        + (profile.cardiac && hospital.services?.cardiology ? 2 : 0)
        + (profile.neuro && icuBeds > 0 ? 1 : 0)
        + Math.min(icuBeds, 20) * 0.05;

      return { hospital, distanceKm, tieCapabilityScore };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Strict nearest-first; capability is only tie-break when distance is almost identical.
      if (Math.abs(a.distanceKm - b.distanceKm) > 0.15) return a.distanceKm - b.distanceKm;
      return b.tieCapabilityScore - a.tieCapabilityScore || a.distanceKm - b.distanceKm;
    });

  const winner = ranked[0].hospital;
  const winnerPoint = normalizeGeoPoint(winner.location || {});
  if (!winnerPoint) return null;

  const normalizedType = ['Government', 'Private', 'Trust'].includes(winner.type) ? winner.type : 'Private';
  const hospitalRecord = await Hospital.findOneAndUpdate(
    {
      name: String(winner.name || '').trim(),
      'location.lat': winnerPoint.lat,
      'location.lng': winnerPoint.lng
    },
    {
      $set: {
        name: String(winner.name || '').trim() || 'Nearest Hospital',
        source: String(winner.source || 'assignment-nearby'),
        type: normalizedType,
        specialties: Array.isArray(winner.specialties) ? winner.specialties : ['Emergency', 'General Care'],
        distance: Number.isFinite(Number(winner.distance)) ? Number(winner.distance) : Number(ranked[0].distanceKm.toFixed(1)),
        driveTime: String(winner.driveTime || `${Math.max(2, Math.ceil(ranked[0].distanceKm * 1.5))} min drive`),
        location: {
          lat: winnerPoint.lat,
          lng: winnerPoint.lng,
          address: String(winner.location?.address || ''),
          city: String(winner.location?.city || 'Mumbai') || 'Mumbai',
          state: String(winner.location?.state || 'Maharashtra') || 'Maharashtra'
        },
        facilities: winner.facilities || estimateHospitalFacilitiesByType(normalizedType),
        services: {
          opd: ['Open', 'Closed', 'Busy'].includes(winner.services?.opd) ? winner.services.opd : 'Open',
          lab: winner.services?.lab || 'Available',
          bloodBank: winner.services?.bloodBank || 'Unknown',
          parking: winner.services?.parking || 'Unknown',
          trauma: Boolean(winner.services?.trauma),
          cardiology: Boolean(winner.services?.cardiology)
        },
        operatingHours: winner.operatingHours || 'Hours unavailable',
        phoneNumber: winner.phoneNumber || '',
        rating: Number(winner.rating || 4.0)
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    hospitalId: hospitalRecord?._id || null,
    hospitalNo: hospitalRecord?.hospitalNo || winner.hospitalNo,
    name: hospitalRecord?.name || winner.name,
    type: hospitalRecord?.type || normalizedType,
    facilities: hospitalRecord?.facilities || winner.facilities || estimateHospitalFacilitiesByType(normalizedType),
    phoneNumber: hospitalRecord?.phoneNumber || winner.phoneNumber || '',
    location: {
      lat: Number(hospitalRecord?.location?.lat ?? winnerPoint.lat),
      lng: Number(hospitalRecord?.location?.lng ?? winnerPoint.lng),
      address: String(hospitalRecord?.location?.address || winner.location?.address || ''),
      city: String(hospitalRecord?.location?.city || winner.location?.city || 'Mumbai') || 'Mumbai',
      state: String(hospitalRecord?.location?.state || winner.location?.state || 'Maharashtra') || 'Maharashtra'
    },
    distanceKm: ranked[0].distanceKm,
    source: String(winner.source || 'assignment-nearby'),
    selectionBasis: {
      method: 'nearest-distance',
      radiusKm: 10,
      tieBreakWindowKm: 0.15,
      comparedHospitals: ranked.length
    }
  };
}

// Mock hospital data for Nashik region
const mockHospitals = [
  {
    name: 'Civil Hospital, Nashik',
    type: 'Government',
    specialties: ['Trauma Centre', '24/7'],
    location: { lat: 19.9975, lng: 73.7898, address: 'Civil Hospital Road, Nashik', city: 'Nashik', state: 'Maharashtra' },
    facilities: { icuBeds: 14, generalBeds: 50, lowBeds: 20, totalBeds: 84 },
    services: { opd: 'Open', lab: '24/7', bloodBank: 'Available', parking: 'Free', trauma: true },
    operatingHours: '24/7',
    phoneNumber: '+91-253-2570000',
    rating: 4.3
  },
  {
    name: 'Wockhardt Hospital',
    type: 'Private',
    specialties: ['Multi-Specialty', '24/7'],
    location: { lat: 19.9895, lng: 73.7805, address: 'Ravivar Peth, Nashik', city: 'Nashik', state: 'Maharashtra' },
    facilities: { icuBeds: 3, generalBeds: 40, lowBeds: 15, totalBeds: 58 },
    services: { opd: 'Open', lab: 'Busy', bloodBank: 'Available', parking: 'Paid', trauma: false },
    operatingHours: '24/7',
    phoneNumber: '+91-253-2350000',
    rating: 4.6
  },
  {
    name: 'Nashik District Hospital',
    type: 'Government',
    specialties: ['General', '24/7'],
    location: { lat: 20.0055, lng: 73.7643, address: 'Nashik Road, Nashik', city: 'Nashik', state: 'Maharashtra' },
    facilities: { icuBeds: 8, generalBeds: 60, lowBeds: 30, totalBeds: 98 },
    services: { opd: 'Open', lab: '24/7', bloodBank: 'Low', parking: 'Free', trauma: true },
    operatingHours: '24/7',
    phoneNumber: '+91-253-2560000',
    rating: 4.1
  },
  {
    name: 'Ratnadeep Hospital',
    type: 'Private',
    specialties: ['Cardiac Specialty'],
    location: { lat: 19.9750, lng: 73.7920, address: 'New Road, Nashik', city: 'Nashik', state: 'Maharashtra' },
    facilities: { icuBeds: 0, generalBeds: 25, lowBeds: 10, totalBeds: 35 },
    services: { opd: 'Closed', lab: 'Open', bloodBank: 'Available', parking: 'Paid', trauma: false, cardiology: true },
    operatingHours: '9:00 AM - 6:00 PM',
    phoneNumber: '+91-253-2400000',
    rating: 4.4
  },
  {
    name: 'Metropolis Hospital',
    type: 'Private',
    specialties: ['Multi-Specialty', '24/7'],
    location: { lat: 19.9920, lng: 73.7680, address: 'Gangapur Road, Nashik', city: 'Nashik', state: 'Maharashtra' },
    facilities: { icuBeds: 12, generalBeds: 55, lowBeds: 25, totalBeds: 92 },
    services: { opd: 'Open', lab: '24/7', bloodBank: 'Available', parking: 'Paid', trauma: true },
    operatingHours: '24/7',
    phoneNumber: '+91-253-2430000',
    rating: 4.7
  },
  {
    name: 'KIMS Hospital Nashik',
    type: 'Private',
    specialties: ['Multi-Specialty', 'Emergency'],
    location: { lat: 19.9850, lng: 73.8050, address: 'Deolali Road, Nashik', city: 'Nashik', state: 'Maharashtra' },
    facilities: { icuBeds: 10, generalBeds: 45, lowBeds: 20, totalBeds: 75 },
    services: { opd: 'Open', lab: '24/7', bloodBank: 'Available', parking: 'Free', trauma: true },
    operatingHours: '24/7',
    phoneNumber: '+91-253-2450000',
    rating: 4.5
  },
  {
    name: 'Sahyadri Hospital',
    type: 'Private',
    specialties: ['Cardiac', 'Neuro'],
    location: { lat: 19.9780, lng: 73.8120, address: 'Upnagar, Nashik', city: 'Nashik', state: 'Maharashtra' },
    facilities: { icuBeds: 6, generalBeds: 35, lowBeds: 15, totalBeds: 56 },
    services: { opd: 'Open', lab: 'Busy', bloodBank: 'Low', parking: 'Paid', trauma: false },
    operatingHours: '24/7',
    phoneNumber: '+91-253-2460000',
    rating: 4.2
  },
  {
    name: 'Sanjeevan Hospital',
    type: 'Government',
    specialties: ['General', 'Emergency'],
    location: { lat: 20.0120, lng: 73.7550, address: 'College Road, Nashik', city: 'Nashik', state: 'Maharashtra' },
    facilities: { icuBeds: 5, generalBeds: 40, lowBeds: 20, totalBeds: 65 },
    services: { opd: 'Closed', lab: '24/7', bloodBank: 'Available', parking: 'Free', trauma: true },
    operatingHours: '24/7',
    phoneNumber: '+91-253-2470000',
    rating: 4.0
  }
];

// OTP storage (in production, use Redis)
const otpStore = new Map();

// Routes
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone, type } = req.body; // type: 'login' or 'register'

    if (type === 'login') {
      const existingUser = await User.findOne({ phone });
      if (!existingUser) {
        return res.status(400).json({
          success: false,
          message: 'Phone number not registered. Please register first.'
        });
      }
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP with expiration (5 minutes)
    otpStore.set(phone, {
      otp,
      expires: Date.now() + 5 * 60 * 1000,
      type
    });

    // In production, send SMS via Twilio
    console.log(`OTP for ${phone}: ${otp}`);

    let smsStatus = 'skipped';
    let smsProvider = 'none';
    let smsError = null;

    if (twilioVerifyServiceSid) {
      const sent = await sendOtpViaTwilioVerify(phone);
      if (sent) {
        smsStatus = 'sent';
        smsProvider = 'twilio-verify';
      }
    }

    if (smsStatus !== 'sent' && verifyServiceUrl) {
      const sent = await sendOtpViaCustomService(phone, otp);
      if (sent) {
        smsStatus = 'sent';
        smsProvider = 'custom';
      }
    }

    if (smsStatus !== 'sent' && !twilioVerifyServiceSid && twilioClient && twilioFromNumber) {
      try {
        await twilioClient.messages.create({
          body: `Your Jeevan Connect OTP is ${otp}. It expires in 5 minutes.`,
          from: twilioFromNumber,
          to: formatPhoneE164(phone)
        });
        smsStatus = 'sent';
        smsProvider = 'twilio-sms';
      } catch (twilioError) {
        smsStatus = 'failed';
        smsError = twilioError.message || String(twilioError);
        console.error('Twilio SMS error:', twilioError.message || twilioError);
      }
    }

    const responsePayload = {
      success: true,
      message: smsStatus === 'sent'
        ? `OTP sent via ${smsProvider}.`
        : 'OTP generated. Check backend log or configure SMS provider to send OTP.',
      smsStatus,
      provider: smsProvider,
      error: smsError || undefined,
      // Always return demo OTP so deployment demos can continue even if SMS providers throttle or fail.
      demoOtp: otp
    };

    res.json(responsePayload);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp, type } = req.body;

    let verified = false;
    if (twilioVerifyServiceSid) {
      verified = await checkOtpViaTwilioVerify(phone, otp);
      if (!verified) {
        return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
      }
    } else {
      const storedOtp = otpStore.get(phone);
      if (!storedOtp || storedOtp.otp !== otp || storedOtp.expires < Date.now()) {
        return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
      }
      if (storedOtp.type !== type) {
        return res.status(400).json({ success: false, message: 'OTP verification type mismatch' });
      }
      verified = true;
    }

    let user;
    if (type === 'register') {
      user = await User.findOne({ phone });
      if (!user) {
        user = new User({ phone, role: 'citizen' });
        await user.save();
      }
    } else {
      // Find existing user
      user = await User.findOne({ phone });
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
    }

    user.isVerified = true;
    user.lastLoginAt = new Date();
    await user.save();

    // Generate JWT token
    const token = signAuthToken({ userId: user._id, role: user.role });

    // Clear OTP
    otpStore.delete(phone);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        phone: user.phone,
        name: user.name,
        email: user.email,
        bloodGroup: user.bloodGroup,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

app.post('/api/auth/check-phone', async (req, res) => {
  try {
    const { phone, type } = req.body;
    const existingUser = await User.findOne({ phone });

    if (type === 'login') {
      return res.json({
        success: true,
        exists: !!existingUser,
        message: existingUser ? 'User found' : 'User not found'
      });
    }

    if (type === 'register') {
      return res.json({
        success: true,
        exists: !existingUser,
        message: existingUser ? 'Phone already registered' : 'Phone is available for registration'
      });
    }

    return res.json({ success: false, message: 'Invalid check type' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Phone check failed' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, name, email, bloodGroup } = req.body;

    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }

    const user = new User({
      phone,
      name,
      email,
      bloodGroup,
      role: 'citizen'
    });

    await user.save();
    res.json({ success: true, message: 'Registration successful' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

app.get('/api/auth/profile', async (req, res) => {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'jeevanconnect_secret');
    if (!decoded.userId) {
      return res.status(403).json({ success: false, message: 'Citizen access required' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({
      success: true,
      profile: {
        id: user._id,
        phone: user.phone,
        name: user.name,
        email: user.email,
        bloodGroup: user.bloodGroup,
        medicalProfile: {
          organDonor: user.medicalProfile?.organDonor || 'unknown',
          allergies: user.medicalProfile?.allergies || [],
          conditions: user.medicalProfile?.conditions || [],
          medications: user.medicalProfile?.medications || [],
          emergencyNote: user.medicalProfile?.emergencyNote || ''
        }
      }
    });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
});

app.put('/api/auth/profile', async (req, res) => {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      console.log('PUT profile: No token provided');
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'jeevanconnect_secret');
    if (!decoded.userId) {
      console.log('PUT profile: No userId in token');
      return res.status(403).json({ success: false, message: 'Citizen access required' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      console.log('PUT profile: User not found for ID', decoded.userId);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    console.log('PUT profile: Updating user', decoded.userId);
    const incomingProfile = req.body.medicalProfile || {};
    const normalizedProfile = {
      organDonor: ['yes', 'no', 'unknown'].includes(incomingProfile.organDonor) ? incomingProfile.organDonor : 'unknown',
      allergies: Array.isArray(incomingProfile.allergies) ? incomingProfile.allergies.filter(Boolean).map(String) : [],
      conditions: Array.isArray(incomingProfile.conditions)
        ? incomingProfile.conditions
            .filter(item => item && item.name)
            .map(item => ({ name: String(item.name).trim(), status: String(item.status || '').trim() }))
        : [],
      medications: Array.isArray(incomingProfile.medications)
        ? incomingProfile.medications
            .filter(item => item && item.name)
            .map(item => ({ name: String(item.name).trim(), frequency: String(item.frequency || '').trim() }))
        : [],
      emergencyNote: String(incomingProfile.emergencyNote || '').trim()
    };

    user.medicalProfile = normalizedProfile;
    await user.save();
    console.log('PUT profile: User saved successfully');

    return res.json({
      success: true,
      message: 'Medical profile updated',
      medicalProfile: normalizedProfile
    });
  } catch (error) {
    console.error('PUT profile error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Database error: ' + (error.message || 'Unknown error') });
  }
});

const MUMBAI_DRIVER_SEED = [
  { driverId: 'D101', name: 'Aarav Patil', ambulanceId: 'A101', phone: '9000000101', loginId: 'drv101', password: 'Driver@123', location: { lat: 19.083962, lng: 72.987165 }, status: 'available' },
  { driverId: 'D102', name: 'Rohan Naik', ambulanceId: 'A102', phone: '9000000102', loginId: 'drv102', password: 'Driver@123', location: { lat: 18.920363, lng: 72.929485 }, status: 'available' },
  { driverId: 'D103', name: 'Siddharth More', ambulanceId: 'A103', phone: '9000000103', loginId: 'drv103', password: 'Driver@123', location: { lat: 18.903038, lng: 72.883209 }, status: 'available' },
  { driverId: 'D104', name: 'Pratik Shinde', ambulanceId: 'A104', phone: '9000000104', loginId: 'drv104', password: 'Driver@123', location: { lat: 19.032318, lng: 72.981409 }, status: 'available' },
  { driverId: 'D105', name: 'Vivek Sawant', ambulanceId: 'A105', phone: '9000000105', loginId: 'drv105', password: 'Driver@123', location: { lat: 19.064399, lng: 72.827001 }, status: 'available' },
  { driverId: 'D106', name: 'Nikhil Jadhav', ambulanceId: 'A106', phone: '9000000106', loginId: 'drv106', password: 'Driver@123', location: { lat: 19.085199, lng: 72.888719 }, status: 'available' },
  { driverId: 'D107', name: 'Kunal Deshmukh', ambulanceId: 'A107', phone: '9000000107', loginId: 'drv107', password: 'Driver@123', location: { lat: 18.970068, lng: 72.806359 }, status: 'available' },
  { driverId: 'D108', name: 'Harshal Kale', ambulanceId: 'A108', phone: '9000000108', loginId: 'drv108', password: 'Driver@123', location: { lat: 19.265675, lng: 72.869929 }, status: 'available' },
  { driverId: 'D109', name: 'Akshay Bhosale', ambulanceId: 'A109', phone: '9000000109', loginId: 'drv109', password: 'Driver@123', location: { lat: 19.099599, lng: 72.893701 }, status: 'available' },
  { driverId: 'D110', name: 'Tejas Pawar', ambulanceId: 'A110', phone: '9000000110', loginId: 'drv110', password: 'Driver@123', location: { lat: 19.032613, lng: 72.960343 }, status: 'available' },
  { driverId: 'D111', name: 'Sanket Dighe', ambulanceId: 'A111', phone: '9000000111', loginId: 'drv111', password: 'Driver@123', location: { lat: 19.163541, lng: 72.957088 }, status: 'available' },
  { driverId: 'D112', name: 'Mihir Patankar', ambulanceId: 'A112', phone: '9000000112', loginId: 'drv112', password: 'Driver@123', location: { lat: 19.208064, lng: 72.985568 }, status: 'available' },
  { driverId: 'D113', name: 'Rahul Bendre', ambulanceId: 'A113', phone: '9000000113', loginId: 'drv113', password: 'Driver@123', location: { lat: 18.996125, lng: 72.888029 }, status: 'available' },
  { driverId: 'D114', name: 'Aniket Kolekar', ambulanceId: 'A114', phone: '9000000114', loginId: 'drv114', password: 'Driver@123', location: { lat: 19.261243, lng: 72.952815 }, status: 'available' },
  { driverId: 'D115', name: 'Omkar Kadam', ambulanceId: 'A115', phone: '9000000115', loginId: 'drv115', password: 'Driver@123', location: { lat: 19.103366, lng: 72.972965 }, status: 'available' },
  { driverId: 'D116', name: 'Yash Tamhane', ambulanceId: 'A116', phone: '9000000116', loginId: 'drv116', password: 'Driver@123', location: { lat: 19.281877, lng: 72.850208 }, status: 'available' },
  { driverId: 'D117', name: 'Aditya Rane', ambulanceId: 'A117', phone: '9000000117', loginId: 'drv117', password: 'Driver@123', location: { lat: 18.915471, lng: 72.951824 }, status: 'available' },
  { driverId: 'D118', name: 'Gaurav Khot', ambulanceId: 'A118', phone: '9000000118', loginId: 'drv118', password: 'Driver@123', location: { lat: 19.019629, lng: 72.876551 }, status: 'available' },
  { driverId: 'D119', name: 'Manish Shetty', ambulanceId: 'A119', phone: '9000000119', loginId: 'drv119', password: 'Driver@123', location: { lat: 19.141672, lng: 72.951133 }, status: 'available' },
  { driverId: 'D120', name: 'Saurabh Pise', ambulanceId: 'A120', phone: '9000000120', loginId: 'drv120', password: 'Driver@123', location: { lat: 19.0425, lng: 72.8616 }, status: 'available' },
  { driverId: 'D121', name: 'Nayan Jadhav', ambulanceId: 'A121', phone: '9000000121', loginId: 'drv121', password: 'Driver@123', location: { lat: 19.0178, lng: 72.8478 }, status: 'available', locationTag: 'Dadar' },
  { driverId: 'D122', name: 'Omkar More', ambulanceId: 'A122', phone: '9000000122', loginId: 'drv122', password: 'Driver@123', location: { lat: 19.0188, lng: 72.8490 }, status: 'available', locationTag: 'Wadala' }
];

app.post('/api/driver/register', async (req, res) => {
  try {
    const { phone, name, licenseNumber, vehicleType, ambulanceId, driverId, loginId, password, status } = req.body;

    const existingDriver = await Driver.findOne({
      $or: [
        { phone },
        ...(driverId ? [{ driverId }] : []),
        ...(loginId ? [{ loginId: loginId.toLowerCase() }] : [])
      ]
    });
    if (existingDriver) {
      return res.status(400).json({ success: false, message: 'Driver already exists with same phone or login' });
    }

    const generatedIdPart = phone ? phone.slice(-4) : Math.floor(1000 + Math.random() * 9000).toString();
    const normalizedDriverId = driverId || `D${generatedIdPart}`;
    const normalizedLoginId = (loginId || `drv${generatedIdPart}`).toLowerCase();

    const driver = new Driver({
      driverId: normalizedDriverId,
      loginId: normalizedLoginId,
      password: password || 'Driver@123',
      phone,
      name,
      licenseNumber,
      vehicleType: vehicleType || 'Basic Life Support',
      ambulanceId: ambulanceId || `A${generatedIdPart}`,
      status: status || 'offline'
    });

    await driver.save();
    res.json({
      success: true,
      message: 'Driver registration successful',
      driver: {
        id: driver._id,
        driverId: driver.driverId,
        loginId: driver.loginId,
        ambulanceId: driver.ambulanceId,
        defaultPassword: driver.password
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Driver registration failed' });
  }
});

app.post('/api/admin/seed/mumbai-drivers', async (req, res) => {
  try {
    const adminKeyHeader = req.headers['x-admin-key'];
    const adminKeyBody = req.body?.adminKey;
    const suppliedKey = (adminKeyHeader || adminKeyBody || '').toString();
    const expectedKey = (process.env.ADMIN_MIGRATION_KEY || '').toString();

    if (expectedKey && suppliedKey !== expectedKey) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    // First delete existing drivers to ensure clean slate
    await Driver.deleteMany({});

    const now = new Date();
    const docsToInsert = MUMBAI_DRIVER_SEED.map((item) => ({
      driverId: item.driverId,
      loginId: item.loginId,
      password: item.password,
      name: item.name,
      ambulanceId: item.ambulanceId,
      phone: item.phone,
      vehicleType: 'Basic Life Support',
      status: 'available',
      isOnline: true,
      location: buildDriverLocation(item.location, {
        address: inferMumbaiLocality(item.location.lat, item.location.lng),
        city: 'Mumbai',
        state: 'Maharashtra',
        simulated: true,
        lastUpdated: now
      }),
      lastLoginAt: now,
      createdAt: now
    }));

    const result = await Driver.insertMany(docsToInsert, { ordered: false });
    const totalDrivers = await Driver.countDocuments();

    console.log(`Seeded ${result.length} drivers to MongoDB`);

    res.json({
      success: true,
      message: 'Mumbai driver dataset seeded to DB',
      seededTemplateCount: MUMBAI_DRIVER_SEED.length,
      insertedCount: result.length,
      totalDrivers,
      demoCredentials: {
        loginId: 'drv101',
        password: 'Driver@123'
      }
    });
  } catch (error) {
    console.error('Seed Mumbai drivers error:', error.message || error);
    res.status(500).json({ success: false, message: 'Failed to seed Mumbai drivers: ' + error.message });
  }
});

app.get('/api/drivers', async (req, res) => {
  try {
    const drivers = await Driver.find({}).sort({ driverId: 1, name: 1 });
    return res.json({
      success: true,
      source: 'mongodb',
      drivers: drivers.map((driver) => ({
        id: driver._id,
        driverId: driver.driverId,
        loginId: driver.loginId,
        name: driver.name,
        ambulanceId: driver.ambulanceId,
        phone: driver.phone,
        status: String(driver.status || 'offline'),
        location: buildDriverLocation(driver.location || {}, {
          lat: driver.location?.lat,
          lng: driver.location?.lng
        }),
        locationName: formatDriverLocationLabel(driver.location || {}),
        isOnline: Boolean(driver.isOnline),
        vehicleType: driver.vehicleType
      }))
    });
  } catch (error) {
    console.error('List drivers error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to load drivers from DB' });
  }
});

app.get('/api/admin/ambulance-assignments', async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || 20);
    const limit = Math.max(5, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 20));

    const liveAssignments = Array.from(activeDispatches.entries()).map(([sosId, dispatch]) => {
      const payload = dispatch?.payload || {};
      const assignedHospital = payload.assignedHospital || null;
      const hospitalName = typeof assignedHospital === 'string'
        ? assignedHospital
        : (assignedHospital?.name || assignedHospital?.location?.address || null);

      return {
        source: 'live-dispatch',
        sosId,
        emergencyId: payload.emergencyId || payload.emergencyMongoId || null,
        status: dispatch?.status || payload.status || 'pending',
        emergencyType: payload.emergencyType || 'Emergency',
        priority: payload.priority || 'high',
        driver: {
          id: payload.driverId || null,
          mongoId: payload.driverMongoId || null,
          driverId: payload.driverId || null,
          loginId: payload.driverLoginId || null,
          ambulanceId: payload.driverAmbulanceId || payload.vehicle || null,
          name: payload.driverName || 'Ambulance Driver',
          vehicle: payload.vehicle || 'Ambulance Unit',
          phone: payload.driverPhone || null
        },
        assignmentBasis: payload.assignmentBasis || null,
        patientLocation: payload.patientLocation || payload.location || null,
        hospital: hospitalName ? { name: hospitalName, location: assignedHospital?.location || null } : null,
        citizen: {
          name: payload.citizenName || payload.requesterName || payload.initiatedBy?.name || 'Unknown Citizen',
          phone: payload.citizenPhone || payload.requesterPhone || payload.initiatedBy?.phone || ''
        },
        requester: {
          name: payload.requesterName || payload.initiatedBy?.name || payload.citizenName || 'Unknown Citizen',
          phone: payload.requesterPhone || payload.initiatedBy?.phone || payload.citizenPhone || ''
        },
        initiatedBy: payload.initiatedBy || null,
        createdAt: payload.createdAt ? new Date(payload.createdAt) : new Date(),
        updatedAt: new Date()
      };
    });

    const recentEmergencies = await Emergency.find({
      status: { $in: ['pending', 'assigned', 'enroute', 'arrived', 'completed'] }
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .populate('assignedDriver', 'name ambulanceId driverId loginId phone')
      .populate('assignedHospital', 'name hospitalNo location');

    const persistedAssignments = recentEmergencies.map((emergency) => ({
      source: 'mongodb',
      sosId: String(emergency._id),
      emergencyId: String(emergency._id),
      status: emergency.status || 'pending',
      emergencyType: emergency.emergencyType || 'Emergency',
      priority: emergency.priority || 'high',
      driver: {
        id: emergency.assignedDriver?._id ? String(emergency.assignedDriver._id) : null,
        mongoId: emergency.assignedDriver?._id ? String(emergency.assignedDriver._id) : null,
        driverId: emergency.assignedDriver?.driverId || emergency.assignedDriverSnapshot?.driverId || null,
        loginId: emergency.assignedDriver?.loginId || emergency.assignedDriverSnapshot?.loginId || null,
        ambulanceId: emergency.assignedDriver?.ambulanceId || emergency.assignedDriverSnapshot?.ambulanceId || null,
        name: emergency.assignedDriver?.name || emergency.assignedDriverSnapshot?.name || 'Not assigned',
        vehicle: emergency.assignedDriver?.ambulanceId || emergency.assignedDriver?.driverId || emergency.assignedDriver?.loginId || emergency.assignedDriverSnapshot?.vehicle || emergency.assignedDriverSnapshot?.ambulanceId || 'Pending',
        phone: emergency.assignedDriver?.phone || emergency.assignedDriverSnapshot?.phone || null
      },
      assignmentBasis: null,
      patientLocation: emergency.location || null,
      hospital: emergency.assignedHospital
        ? {
            id: String(emergency.assignedHospital._id),
            name: emergency.assignedHospital.name || 'Assigned Hospital',
            location: emergency.assignedHospital.location || null
          }
        : null,
      citizen: {
        name: emergency.citizenName || emergency.initiatedBy?.name || 'Unknown Citizen',
        phone: emergency.citizenPhone || emergency.initiatedBy?.phone || ''
      },
      requester: {
        name: emergency.initiatedBy?.name || emergency.citizenName || 'Unknown Citizen',
        phone: emergency.initiatedBy?.phone || emergency.citizenPhone || ''
      },
      initiatedBy: emergency.initiatedBy || null,
      createdAt: emergency.createdAt,
      updatedAt: emergency.updatedAt
    }));

    const merged = [];
    const seen = new Set();
    for (const assignment of [...liveAssignments, ...persistedAssignments]) {
      const key = assignment.emergencyId || assignment.sosId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(assignment);
    }

    merged.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());

    res.json({
      success: true,
      count: merged.length,
      assignments: merged.slice(0, limit)
    });
  } catch (error) {
    console.error('List ambulance assignments error:', error.message || error);
    res.status(500).json({ success: false, message: 'Failed to load ambulance assignments' });
  }
});

app.post('/api/admin/migrations/force-drivers-available-with-location', async (req, res) => {
  try {
    const adminKeyHeader = req.headers['x-admin-key'];
    const adminKeyBody = req.body?.adminKey;
    const suppliedKey = (adminKeyHeader || adminKeyBody || '').toString();
    const expectedKey = (process.env.ADMIN_MIGRATION_KEY || '').toString();

    if (expectedKey && suppliedKey !== expectedKey) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    const drivers = await Driver.find({}).lean();
    const seedByDriverId = new Map(MUMBAI_DRIVER_SEED.map((item) => [item.driverId, item]));
    const now = new Date();

    const operations = drivers.map((driver) => {
      const seed = seedByDriverId.get(driver.driverId) || null;
      const normalizedLocation = buildDriverLocation(driver.location || {}, seed?.location || {
        lat: 19.0760,
        lng: 72.8777,
        address: 'Mumbai, Maharashtra',
        city: 'Mumbai',
        state: 'Maharashtra'
      });

      return {
        updateOne: {
          filter: { _id: driver._id },
          update: {
            $set: {
              status: 'available',
              isOnline: true,
              location: normalizedLocation,
              lastLoginAt: now
            }
          }
        }
      };
    });

    if (operations.length) {
      await Driver.bulkWrite(operations, { ordered: false });
    }

    return res.json({
      success: true,
      updatedDrivers: operations.length,
      message: 'All drivers set to available with named locations'
    });
  } catch (error) {
    console.error('Force drivers available migration error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to force driver availability migration' });
  }
});

app.post('/api/admin/migrations/cluster-drivers-nearby', async (req, res) => {
  try {
    const adminKeyHeader = req.headers['x-admin-key'];
    const adminKeyBody = req.body?.adminKey;
    const suppliedKey = (adminKeyHeader || adminKeyBody || '').toString();
    const expectedKey = (process.env.ADMIN_MIGRATION_KEY || '').toString();

    if (expectedKey && suppliedKey !== expectedKey) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    const centerLat = Number(req.body?.lat);
    const centerLng = Number(req.body?.lng);
    const radiusKm = Math.max(0.2, Math.min(5, Number(req.body?.radiusKm || 1.2)));
    const targetLat = Number.isFinite(centerLat) ? centerLat : 19.0954;
    const targetLng = Number.isFinite(centerLng) ? centerLng : 72.8975;

    const drivers = await Driver.find({}).lean();
    const now = new Date();
    const total = drivers.length;
    if (!total) {
      return res.json({ success: true, updatedDrivers: 0, center: { lat: targetLat, lng: targetLng } });
    }

    const latDegPerKm = 1 / 111.32;
    const lngDegPerKm = 1 / (111.32 * Math.cos((targetLat * Math.PI) / 180));

    const operations = drivers.map((driver, index) => {
      const angle = (2 * Math.PI * index) / total;
      const ring = 0.15 + ((index % 5) / 5) * radiusKm;
      const offsetLat = Math.sin(angle) * ring * latDegPerKm;
      const offsetLng = Math.cos(angle) * ring * lngDegPerKm;
      const lat = Number((targetLat + offsetLat).toFixed(6));
      const lng = Number((targetLng + offsetLng).toFixed(6));

      return {
        updateOne: {
          filter: { _id: driver._id },
          update: {
            $set: {
              status: 'available',
              isOnline: true,
              location: {
                lat,
                lng,
                address: `Near test SOS zone ${index + 1}, Mumbai`,
                city: 'Mumbai',
                state: 'Maharashtra'
              },
              lastLoginAt: now
            }
          }
        }
      };
    });

    await Driver.bulkWrite(operations, { ordered: false });

    return res.json({
      success: true,
      updatedDrivers: operations.length,
      center: { lat: targetLat, lng: targetLng },
      radiusKm,
      message: 'Drivers clustered near the requested location and marked available'
    });
  } catch (error) {
    console.error('Cluster drivers migration error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to cluster drivers nearby' });
  }
});

app.post('/api/admin/migrations/randomize-drivers-mumbai', async (req, res) => {
  try {
    const adminKeyHeader = req.headers['x-admin-key'];
    const adminKeyBody = req.body?.adminKey;
    const suppliedKey = (adminKeyHeader || adminKeyBody || '').toString();
    const expectedKey = (process.env.ADMIN_MIGRATION_KEY || '').toString();

    if (expectedKey && suppliedKey !== expectedKey) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    const drivers = await Driver.find({}).lean();
    if (!drivers.length) {
      return res.json({ success: true, updatedDrivers: 0, message: 'No drivers found to randomize' });
    }

    const bbox = {
      southLat: Number(req.body?.southLat ?? 18.89),
      northLat: Number(req.body?.northLat ?? 19.30),
      westLng: Number(req.body?.westLng ?? 72.77),
      eastLng: Number(req.body?.eastLng ?? 72.99)
    };

    const randomInRange = (min, max) => min + (Math.random() * (max - min));
    const filteredReferences = MUMBAI_LOCATION_REFERENCE.filter((point) => (
      point.lat >= Math.min(bbox.southLat, bbox.northLat)
      && point.lat <= Math.max(bbox.southLat, bbox.northLat)
      && point.lng >= Math.min(bbox.westLng, bbox.eastLng)
      && point.lng <= Math.max(bbox.westLng, bbox.eastLng)
    ));
    const references = filteredReferences.length ? filteredReferences : MUMBAI_LOCATION_REFERENCE;
    const now = new Date();

    const operations = drivers.map((driver, index) => {
      const anchor = references[index % references.length];
      const jitterLat = randomInRange(-0.008, 0.008);
      const jitterLng = randomInRange(-0.008, 0.008);
      const lat = Number((anchor.lat + jitterLat).toFixed(6));
      const lng = Number((anchor.lng + jitterLng).toFixed(6));
      const inferred = inferMumbaiLocality(lat, lng) || `${anchor.name}, Mumbai, Maharashtra`;

      return {
        updateOne: {
          filter: { _id: driver._id },
          update: {
            $set: {
              status: 'available',
              isOnline: true,
              location: {
                lat,
                lng,
                address: inferred,
                city: 'Mumbai',
                state: 'Maharashtra',
                simulated: true,
                lastUpdated: now
              },
              lastLoginAt: now
            }
          }
        }
      };
    });

    await Driver.bulkWrite(operations, { ordered: false });

    return res.json({
      success: true,
      updatedDrivers: operations.length,
      bounds: bbox,
      message: 'Drivers randomized across Mumbai city and marked available'
    });
  } catch (error) {
    console.error('Randomize drivers Mumbai migration error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to randomize drivers across Mumbai' });
  }
});

app.post('/api/admin/migrations/smart-cluster-drivers-mumbai', async (req, res) => {
  try {
    const adminKeyHeader = req.headers['x-admin-key'];
    const adminKeyBody = req.body?.adminKey;
    const suppliedKey = (adminKeyHeader || adminKeyBody || '').toString();
    const expectedKey = (process.env.ADMIN_MIGRATION_KEY || '').toString();

    if (expectedKey && suppliedKey !== expectedKey) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    const drivers = await Driver.find({}).lean();
    if (!drivers.length) {
      return res.json({ success: true, updatedDrivers: 0, message: 'No drivers found to distribute' });
    }

    const clusterZones = {
      ghatkopar: [
        { lat: 19.0846, lng: 72.9069, spot: 'Main Road' },
        { lat: 19.0856, lng: 72.9081, spot: 'E-Pass Junction' },
        { lat: 19.0836, lng: 72.9050, spot: 'Link Road' }
      ],
      wadala: [
        { lat: 19.0178, lng: 72.8478, spot: 'TT Junction' },
        { lat: 19.0188, lng: 72.8490, spot: 'Wadala East' },
        { lat: 19.0168, lng: 72.8468, spot: 'Wadala West' }
      ],
      dadar: [
        { lat: 19.0178, lng: 72.8478, spot: 'Dadar East' },
        { lat: 19.0195, lng: 72.8510, spot: 'Dadar Market' },
        { lat: 19.0160, lng: 72.8450, spot: 'Dadar West' }
      ],
      distributed: [
        { lat: 19.1197, lng: 72.8468, spot: 'Andheri West' },
        { lat: 19.0596, lng: 72.8295, spot: 'Bandra West' },
        { lat: 19.0728, lng: 72.8826, spot: 'Kurla' },
        { lat: 18.9986, lng: 72.8437, spot: 'Parel' },
        { lat: 19.1176, lng: 72.9060, spot: 'Powai' },
        { lat: 19.0467, lng: 72.8619, spot: 'Sion' },
        { lat: 19.1663, lng: 72.8526, spot: 'Goregaon' }
      ]
    };

    const placement = [];
    placement.push(...clusterZones.ghatkopar.slice(0, 2));
    placement.push(...clusterZones.wadala.slice(0, 2));
    placement.push(...clusterZones.dadar.slice(0, 3));
    placement.push(...clusterZones.distributed);

    const now = new Date();
    const operations = drivers.map((driver, index) => {
      const spot = placement[index % placement.length];
      const jitterLat = (Math.random() - 0.5) * 0.004;
      const jitterLng = (Math.random() - 0.5) * 0.004;
      const lat = Number((spot.lat + jitterLat).toFixed(6));
      const lng = Number((spot.lng + jitterLng).toFixed(6));
      const inferred = inferMumbaiLocality(lat, lng) || spot.spot;

      return {
        updateOne: {
          filter: { _id: driver._id },
          update: {
            $set: {
              status: 'available',
              isOnline: true,
              location: {
                lat,
                lng,
                address: inferred,
                city: 'Mumbai',
                state: 'Maharashtra',
                simulated: true,
                lastUpdated: now
              },
              lastLoginAt: now
            }
          }
        }
      };
    });

    await Driver.bulkWrite(operations, { ordered: false });

    return res.json({
      success: true,
      updatedDrivers: operations.length,
      distribution: {
        ghatkopar: 2,
        wadala: 2,
        dadar: 3,
        distributed: 7
      },
      totalPlacementSpots: placement.length,
      message: 'Drivers smart-clustered across Mumbai key areas with real road locations'
    });
  } catch (error) {
    console.error('Smart cluster drivers migration error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to smart-cluster drivers' });
  }
});

app.post('/api/admin/migrations/backfill-emergency-assigned-driver', async (req, res) => {
  try {
    const adminKeyHeader = req.headers['x-admin-key'];
    const adminKeyBody = req.body?.adminKey;
    const suppliedKey = (adminKeyHeader || adminKeyBody || '').toString();
    const expectedKey = (process.env.ADMIN_MIGRATION_KEY || '').toString();

    if (expectedKey && suppliedKey !== expectedKey) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    const emergencies = await Emergency.find({
      $or: [
        { assignedDriver: { $exists: false } },
        { assignedDriver: null }
      ]
    }).lean();

    let updatedCount = 0;

    for (const emergency of emergencies) {
      const snapshot = emergency.assignedDriverSnapshot || {};
      const resolvedDriverMongoId = await resolveDriverMongoId(
        snapshot.mongoId,
        snapshot.driverMongoId,
        snapshot.driverId,
        snapshot.loginId,
        snapshot.ambulanceId,
        snapshot.phone,
        snapshot.name
      );

      if (!resolvedDriverMongoId) continue;

      await Emergency.updateOne(
        { _id: emergency._id },
        { $set: { assignedDriver: resolvedDriverMongoId } }
      );
      updatedCount += 1;
    }

    return res.json({
      success: true,
      scannedEmergencies: emergencies.length,
      updatedEmergencies: updatedCount,
      message: 'Backfilled assignedDriver where resolvable'
    });
  } catch (error) {
    console.error('Backfill emergency assignedDriver migration error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to backfill emergency assignedDriver' });
  }
});

app.post('/api/driver/login', async (req, res) => {
  try {
    const { loginId, password, ambulanceId, phone } = req.body;

    let driver = null;
    if (loginId && password) {
      driver = await Driver.findOne({ loginId: loginId.toLowerCase().trim() });
      if (!driver) {
        return res.status(404).json({ success: false, message: 'Driver login ID not found' });
      }
      if (driver.password !== password) {
        return res.status(401).json({ success: false, message: 'Invalid password' });
      }
    } else {
      driver = await Driver.findOne({ phone });
      if (!driver) {
        return res.status(404).json({ success: false, message: 'Driver not found' });
      }

      if (ambulanceId && driver.ambulanceId && ambulanceId !== driver.ambulanceId) {
        return res.status(401).json({ success: false, message: 'Ambulance ID mismatch' });
      }
    }

    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    driver.isOnline = true;
    if (!driver.status || driver.status === 'offline') {
      driver.status = 'available';
    }
    driver.lastLoginAt = new Date();
    await driver.save();

    // Generate token
    const token = signAuthToken({ driverId: driver._id, role: 'driver' });

    res.json({
      success: true,
      token,
      driver: {
        id: driver._id,
        driverId: driver.driverId,
        loginId: driver.loginId,
        name: driver.name,
        vehicleType: driver.vehicleType,
        ambulanceId: driver.ambulanceId,
        phone: driver.phone,
        status: driver.status,
        location: driver.location || null
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

app.post('/api/emergency', async (req, res) => {
  try {
    console.log('POST /api/emergency called with body:', JSON.stringify(req.body).substring(0, 200));
    const { citizenId, location, description, priority, emergencyType, medicalSnapshot } = req.body;

    const token = getTokenFromRequest(req);
    let resolvedCitizenId = citizenId;

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'jeevanconnect_secret');
        if (decoded.userId) {
          resolvedCitizenId = decoded.userId;
          console.log('POST emergency: Resolved citizenId from token:', resolvedCitizenId);
        }
      } catch (_) {
        // Token validation is optional here when citizenId is already supplied.
      }
    }

    if (!resolvedCitizenId) {
      console.log('POST emergency: No citizen identity');
      return res.status(400).json({ success: false, message: 'Citizen identity is required' });
    }

    const citizen = await User.findById(resolvedCitizenId);
    if (!citizen) {
      console.log('POST emergency: Citizen not found for ID', resolvedCitizenId);
      return res.status(404).json({ success: false, message: 'Citizen not found' });
    }

    console.log('POST emergency: Citizen found, creating emergency');
    const resolvedMedicalSnapshot = {
      bloodGroup: medicalSnapshot?.bloodGroup || citizen.bloodGroup || '',
      organDonor: medicalSnapshot?.organDonor || citizen.medicalProfile?.organDonor || 'unknown',
      allergies: Array.isArray(medicalSnapshot?.allergies) ? medicalSnapshot.allergies : (citizen.medicalProfile?.allergies || []),
      conditions: Array.isArray(medicalSnapshot?.conditions) ? medicalSnapshot.conditions : (citizen.medicalProfile?.conditions || []),
      medications: Array.isArray(medicalSnapshot?.medications) ? medicalSnapshot.medications : (citizen.medicalProfile?.medications || []),
      emergencyNote: medicalSnapshot?.emergencyNote || citizen.medicalProfile?.emergencyNote || ''
    };

    const emergency = new Emergency({
      citizenName: citizen.name || 'Unknown Citizen',
      citizenPhone: citizen.phone || '',
      citizenId: resolvedCitizenId,
      requestChannel: 'api',
      initiatedBy: {
        role: 'citizen',
        userId: resolvedCitizenId,
        name: citizen.name || 'Unknown Citizen',
        phone: citizen.phone || ''
      },
      location,
      emergencyType,
      description,
      priority: priority || 'high',
      medicalSnapshot: resolvedMedicalSnapshot
    });

    await emergency.save();
    console.log('POST emergency: Emergency saved successfully with ID', emergency._id);

    // Emit real-time emergency alert
    io.emit('new-emergency', {
      id: emergency._id,
      location: emergency.location,
      priority: emergency.priority,
      description: emergency.description,
      createdAt: emergency.createdAt
    });

    res.json({ success: true, emergencyId: emergency._id });
  } catch (error) {
    console.error('POST emergency error:', error.message || error);
    res.status(500).json({ success: false, message: 'Failed to create emergency request: ' + (error.message || 'Unknown error') });
  }
});

app.post('/api/emergency/:id/cancel', async (req, res) => {
  try {
    const emergencyId = String(req.params.id || '').trim();
    const token = getTokenFromRequest(req);

    let cancelledBy = {
      role: 'citizen',
      userId: req.body?.citizenId || null,
      name: req.body?.citizenName || '',
      phone: req.body?.citizenPhone || '',
      socketId: req.body?.socketId || ''
    };

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'jeevanconnect_secret');
        if (decoded.userId) {
          const user = await User.findById(decoded.userId).select('name phone').lean();
          cancelledBy = {
            ...cancelledBy,
            role: 'citizen',
            userId: decoded.userId,
            name: user?.name || cancelledBy.name,
            phone: user?.phone || cancelledBy.phone
          };
        }
      } catch (_) {
        // Allow cancellation with request payload fallback.
      }
    }

    const result = await cancelEmergencyAndDispatch({
      emergencyId,
      sosId: req.body?.sosId || null,
      cancelledBy
    });

    if (!result.success) {
      const code = /not found/i.test(result.message || '') ? 404 : /cannot be cancelled/i.test(result.message || '') ? 409 : 400;
      return res.status(code).json(result);
    }

    return res.json(result);
  } catch (error) {
    console.error('Cancel emergency error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to cancel emergency request' });
  }
});

app.get('/api/emergency/:id/dispatch-status', async (req, res) => {
  try {
    const emergencyId = String(req.params.id || '').trim();
    if (!emergencyId || !mongoose.Types.ObjectId.isValid(emergencyId)) {
      return res.status(400).json({ success: false, message: 'Valid emergency id is required' });
    }

    const emergency = await Emergency.findById(emergencyId)
      .populate('assignedDriver', 'name phone ambulanceId driverId loginId location status isOnline')
      .populate('assignedHospital', 'name location phoneNumber');

    if (!emergency) {
      return res.status(404).json({ success: false, message: 'Emergency not found' });
    }

    let liveDispatch = null;
    for (const [sosId, dispatch] of activeDispatches.entries()) {
      if (!dispatch?.payload) continue;
      const dispatchEmergencyId = String(dispatch.payload.emergencyId || dispatch.payload.emergencyMongoId || '');
      if (dispatchEmergencyId === emergencyId) {
        liveDispatch = { sosId, ...dispatch };
        break;
      }
    }

    const payload = liveDispatch?.payload || {};
    const assignedDriver = emergency.assignedDriver || null;
    const assignedDriverSnapshot = emergency.assignedDriverSnapshot || null;
    const assignedHospital = emergency.assignedHospital || null;

    res.json({
      success: true,
      emergencyId,
      status: liveDispatch?.status || emergency.status || 'pending',
      sosId: liveDispatch?.sosId || null,
      assignmentBasis: payload.assignmentBasis || null,
      driver: {
        id: payload.driverId || assignedDriverSnapshot?.driverId || (assignedDriver?._id ? String(assignedDriver._id) : null),
        name: payload.driverName || assignedDriverSnapshot?.name || assignedDriver?.name || null,
        vehicle: payload.vehicle || assignedDriverSnapshot?.vehicle || assignedDriverSnapshot?.ambulanceId || assignedDriver?.ambulanceId || assignedDriver?.driverId || assignedDriver?.loginId || null,
        phone: payload.driverPhone || assignedDriverSnapshot?.phone || assignedDriver?.phone || null,
        location: payload.driverLocation || assignedDriverSnapshot?.location || assignedDriver?.location || null,
        distanceKm: typeof payload.driverDistanceKm === 'number' ? payload.driverDistanceKm : null
      },
      hospital: assignedHospital
        ? {
            id: String(assignedHospital._id),
            name: assignedHospital.name || null,
            location: assignedHospital.location || null,
            phoneNumber: assignedHospital.phoneNumber || null
          }
        : (payload.assignedHospital || null),
      patientLocation: payload.patientLocation || emergency.location || null,
      updatedAt: emergency.updatedAt
    });
  } catch (error) {
    console.error('Dispatch status error:', error.message || error);
    res.status(500).json({ success: false, message: 'Failed to load dispatch status' });
  }
});

app.post('/api/admin/migrations/emergency-citizen-identity', async (req, res) => {
  try {
    const adminKeyHeader = req.headers['x-admin-key'];
    const adminKeyBody = req.body?.adminKey;
    const suppliedKey = (adminKeyHeader || adminKeyBody || '').toString();
    const expectedKey = (process.env.ADMIN_MIGRATION_KEY || '').toString();

    if (expectedKey && suppliedKey !== expectedKey) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    const filter = {
      citizenId: { $exists: true, $ne: null },
      $or: [
        { citizenName: { $exists: false } },
        { citizenName: '' },
        { citizenPhone: { $exists: false } },
        { citizenPhone: '' }
      ]
    };

    const emergencies = await Emergency.find(filter).populate('citizenId', 'name phone');

    let updated = 0;
    let skipped = 0;

    for (const emergency of emergencies) {
      const citizen = emergency.citizenId;
      if (!citizen) {
        skipped += 1;
        continue;
      }

      const nextName = emergency.citizenName || citizen.name || 'Unknown Citizen';
      const nextPhone = emergency.citizenPhone || citizen.phone || '';

      const needsUpdate = emergency.citizenName !== nextName || emergency.citizenPhone !== nextPhone;
      if (!needsUpdate) {
        skipped += 1;
        continue;
      }

      emergency.citizenName = nextName;
      emergency.citizenPhone = nextPhone;
      await emergency.save();
      updated += 1;
    }

    return res.json({
      success: true,
      scanned: emergencies.length,
      updated,
      skipped
    });
  } catch (error) {
    console.error('Emergency migration error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Migration failed: ' + (error.message || 'Unknown error') });
  }
});

// ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
// HOSPITAL ROUTES
// ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ

// Calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in km
}

function normalizeDistanceKm(distanceKm) {
  if (!Number.isFinite(distanceKm)) return null;
  if (distanceKm > 0 && distanceKm < 0.1) return 0.1;
  return Number(distanceKm.toFixed(2));
}

const googlePlacesApiKey = process.env.GOOGLE_PLACES_API_KEY || googleMapsApiKey;
let localMumbaiHospitals = [];

function isValidHospitalName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  if (
    lower === 'unnamed' ||
    lower === 'unnamed hospital' ||
    lower === 'unknown' ||
    lower === 'n/a' ||
    lower === 'na'
  ) {
    return false;
  }

  return true;
}

function sanitizeAndNumberLocalMumbaiHospitals(rows = []) {
  const unique = new Map();

  for (const row of rows) {
    const lat = Number(row?.Latitude ?? row?.lat);
    const lng = Number(row?.Longitude ?? row?.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const hospitalName = String(row?.HospitalName || row?.name || '').trim();
    if (!isValidHospitalName(hospitalName)) continue;

    const address = String(row?.Address || row?.address || '').trim();
    const operator = String(row?.Operator || row?.operator || '').trim();
    const city = String(row?.City || row?.city || 'Mumbai').trim() || 'Mumbai';
    const phone = String(row?.Phone || row?.phone || '').trim();
    const type = String(row?.Type || row?.type || 'hospital').trim() || 'hospital';

    const dedupeKey = `${hospitalName.toLowerCase()}|${Math.round(lat * 10000)}|${Math.round(lng * 10000)}`;
    if (!unique.has(dedupeKey)) {
      unique.set(dedupeKey, {
        HospitalName: hospitalName,
        Latitude: Number(lat.toFixed(7)),
        Longitude: Number(lng.toFixed(7)),
        City: city,
        Address: address,
        Operator: operator,
        Type: type,
        Phone: phone
      });
    }
  }

  return Array.from(unique.values())
    .sort((a, b) => a.HospitalName.localeCompare(b.HospitalName))
    .map((entry, index) => ({
      ...entry,
      HospitalNo: index + 1,
      hospitalNo: index + 1
    }));
}

function parseLocalHospitalRowsFromFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
}

function loadLocalMumbaiHospitalDataset() {
  const candidateFiles = [
    path.join(__dirname, 'mumbai-hospitals-all.xlsx')
  ];

  for (const filePath of candidateFiles) {
    try {
      const parsedRows = parseLocalHospitalRowsFromFile(filePath);
      const cleanedRows = sanitizeAndNumberLocalMumbaiHospitals(parsedRows);
      if (cleanedRows.length) {
        localMumbaiHospitals = cleanedRows;
        return;
      }
    } catch (_) {
      // Ignore and move to next candidate file.
    }
  }
}

loadLocalMumbaiHospitalDataset();

function classifyHospitalOwnership(name = '') {
  const lower = String(name).toLowerCase();
  if (
    lower.includes('government') ||
    lower.includes('govt') ||
    lower.includes('municipal') ||
    lower.includes('mcgm') ||
    lower.includes('bmc') ||
    lower.includes('civil') ||
    lower.includes('district') ||
    lower.includes('jj hospital') ||
    lower.includes('kem') ||
    lower.includes('nair hospital') ||
    lower.includes('sion hospital') ||
    lower.includes('st george')
  ) {
    return 'Government';
  }

  if (
    lower.includes('trust') ||
    lower.includes('charitable') ||
    lower.includes('mission')
  ) {
    return 'Trust';
  }

  return 'Private';
}

function estimateHospitalFacilitiesByType(type) {
  if (type === 'Government') {
    return { icuBeds: 18, generalBeds: 70, lowBeds: 25, totalBeds: 113 };
  }
  if (type === 'Trust') {
    return { icuBeds: 10, generalBeds: 45, lowBeds: 16, totalBeds: 71 };
  }
  return { icuBeds: 12, generalBeds: 55, lowBeds: 18, totalBeds: 85 };
}

function normalizeGooglePlaceHospital(place, userLat, userLng) {
  const lat = place?.geometry?.location?.lat;
  const lng = place?.geometry?.location?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const name = place.name || 'Unnamed Hospital';
  const ownershipType = classifyHospitalOwnership(name);
  const facilities = estimateHospitalFacilitiesByType(ownershipType);
  const distance = calculateDistance(userLat, userLng, lat, lng);
  const driveTime = Math.max(2, Math.ceil(distance * 2));

  return {
    name,
    type: ownershipType,
    specialties: ['Emergency', 'General Care'],
    location: {
      lat,
      lng,
      address: place.vicinity || place.formatted_address || '',
      city: 'Mumbai',
      state: 'Maharashtra'
    },
    facilities,
    services: {
      opd: 'Open',
      lab: 'Available',
      bloodBank: 'Unknown',
      parking: 'Unknown',
      trauma: true
    },
    operatingHours: place.opening_hours?.open_now ? 'Open now' : 'Hours unavailable',
    phoneNumber: '',
    rating: place.rating || 4.0,
    distance: parseFloat(distance.toFixed(1)),
    driveTime: `${driveTime} min drive`,
    placeId: place.place_id,
    source: 'google-places'
  };
}

function dedupeHospitals(hospitals = []) {
  const seen = new Set();
  const deduped = [];

  for (const h of hospitals) {
    const key = h.placeId
      ? `place:${h.placeId}`
      : `name:${String(h.name || '').toLowerCase()}|${Math.round((h.location?.lat || 0) * 10000)}|${Math.round((h.location?.lng || 0) * 10000)}`;

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(h);
  }

  return deduped;
}

function normalizeLocalMumbaiHospital(entry, userLat, userLng) {
  const lat = Number(entry.Latitude || entry.lat);
  const lng = Number(entry.Longitude || entry.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const name = String(entry.HospitalName || entry.name || '').trim();
  if (!isValidHospitalName(name)) return null;

  const hospitalNo = Number(entry.HospitalNo || entry.hospitalNo) || null;
  const ownershipType = classifyHospitalOwnership(name);
  const facilities = estimateHospitalFacilitiesByType(ownershipType);
  const distance = calculateDistance(userLat, userLng, lat, lng);
  const driveTime = Math.max(2, Math.ceil(distance * 2));

  return {
    name,
    type: ownershipType,
    specialties: ['Emergency', 'General Care'],
    location: {
      lat,
      lng,
      address: String(entry.Address || entry.address || ''),
      city: 'Mumbai',
      state: 'Maharashtra'
    },
    facilities,
    services: {
      opd: 'Open',
      lab: 'Available',
      bloodBank: 'Unknown',
      parking: 'Unknown',
      trauma: true
    },
    operatingHours: 'Hours unavailable',
    phoneNumber: String(entry.Phone || entry.phone || ''),
    rating: 4.0,
    distance: parseFloat(distance.toFixed(1)),
    driveTime: `${driveTime} min drive`,
    hospitalNo,
    source: 'local-mumbai-dataset'
  };
}

function normalizeLocalMumbaiHospitalForMap(entry) {
  const lat = Number(entry.Latitude || entry.lat);
  const lng = Number(entry.Longitude || entry.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const name = String(entry.HospitalName || entry.name || '').trim();
  if (!isValidHospitalName(name)) return null;

  const ownershipType = classifyHospitalOwnership(name);
  const facilities = estimateHospitalFacilitiesByType(ownershipType);
  const hospitalNo = Number(entry.HospitalNo || entry.hospitalNo) || null;

  return {
    hospitalNo,
    name,
    type: ownershipType,
    specialties: ['Emergency', 'General Care'],
    location: {
      lat,
      lng,
      address: String(entry.Address || entry.address || ''),
      city: String(entry.City || entry.city || 'Mumbai') || 'Mumbai',
      state: 'Maharashtra'
    },
    facilities,
    phoneNumber: String(entry.Phone || entry.phone || ''),
    source: 'local-mumbai-dataset'
  };
}

app.get('/api/hospitals/all', async (req, res) => {
  try {
    const mongoHospitals = await Hospital.find({ source: 'xlsx-import' })
      .sort({ hospitalNo: 1, name: 1 })
      .lean();

    if (mongoHospitals.length) {
      const hospitals = mongoHospitals.map((entry, index) => ({
        hospitalNo: Number(entry.hospitalNo) || (index + 1),
        name: entry.name,
        type: entry.type,
        specialties: Array.isArray(entry.specialties) ? entry.specialties : ['Emergency', 'General Care'],
        location: {
          lat: Number(entry.location?.lat),
          lng: Number(entry.location?.lng),
          address: String(entry.location?.address || ''),
          city: String(entry.location?.city || 'Mumbai') || 'Mumbai',
          state: String(entry.location?.state || 'Maharashtra') || 'Maharashtra'
        },
        facilities: entry.facilities || estimateHospitalFacilitiesByType(entry.type),
        phoneNumber: String(entry.phoneNumber || ''),
        source: 'mongodb-xlsx-import'
      }));

      return res.json({
        success: true,
        hospitals,
        total: hospitals.length,
        source: 'mongodb-xlsx-import'
      });
    }

    let hospitals = dedupeHospitals(
      (localMumbaiHospitals || [])
        .map(normalizeLocalMumbaiHospitalForMap)
        .filter(Boolean)
    ).sort((a, b) => {
      const aNo = Number(a.hospitalNo || Number.MAX_SAFE_INTEGER);
      const bNo = Number(b.hospitalNo || Number.MAX_SAFE_INTEGER);
      if (aNo !== bNo) return aNo - bNo;
      return a.name.localeCompare(b.name);
    });

    if (!hospitals.length) {
      hospitals = [
        { hospitalNo: 1, name: 'KEM Hospital', type: 'Government', specialties: ['Emergency', 'Trauma'], location: { lat: 19.0014, lng: 72.8419, address: 'Parel, Mumbai', city: 'Mumbai', state: 'Maharashtra' }, facilities: estimateHospitalFacilitiesByType('Government'), phoneNumber: '02224107000', source: 'hardcoded-fallback' },
        { hospitalNo: 2, name: 'Sion Hospital', type: 'Government', specialties: ['Emergency', 'General Care'], location: { lat: 19.0434, lng: 72.8602, address: 'Sion, Mumbai', city: 'Mumbai', state: 'Maharashtra' }, facilities: estimateHospitalFacilitiesByType('Government'), phoneNumber: '02224076381', source: 'hardcoded-fallback' },
        { hospitalNo: 3, name: 'Cooper Hospital', type: 'Municipal', specialties: ['Emergency', 'General Care'], location: { lat: 19.1075, lng: 72.8372, address: 'Juhu, Mumbai', city: 'Mumbai', state: 'Maharashtra' }, facilities: estimateHospitalFacilitiesByType('Municipal'), phoneNumber: '02226207254', source: 'hardcoded-fallback' },
        { hospitalNo: 4, name: 'Nair Hospital', type: 'Government', specialties: ['Emergency', 'Cardiac'], location: { lat: 18.9684, lng: 72.8191, address: 'Mumbai Central, Mumbai', city: 'Mumbai', state: 'Maharashtra' }, facilities: estimateHospitalFacilitiesByType('Government'), phoneNumber: '02223027000', source: 'hardcoded-fallback' },
        { hospitalNo: 5, name: 'Rajawadi Hospital', type: 'Municipal', specialties: ['Emergency', 'General Care'], location: { lat: 19.0846, lng: 72.9069, address: 'Ghatkopar, Mumbai', city: 'Mumbai', state: 'Maharashtra' }, facilities: estimateHospitalFacilitiesByType('Municipal'), phoneNumber: '02221022700', source: 'hardcoded-fallback' }
      ];
    }

    res.json({
      success: true,
      hospitals,
      total: hospitals.length,
      source: hospitals[0]?.source || 'local-mumbai-xlsx'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch hospitals list' });
  }
});

app.post('/api/hospital/bootstrap-logins', async (req, res) => {
  try {
    if (!isValidAdminKey(req)) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    const resetExisting = Boolean(req.body?.resetExisting);
    const defaultPassword = String(req.body?.defaultPassword || 'Hosp@123');
    const hospitals = await Hospital.find({ source: 'xlsx-import' }).sort({ hospitalNo: 1, name: 1 });

    if (!hospitals.length) {
      return res.status(404).json({ success: false, message: 'No imported hospitals found in DB' });
    }

    const passwordHash = await bcrypt.hash(defaultPassword, 10);
    let updatedCount = 0;
    let assignedHospitalNoCount = 0;

    for (let index = 0; index < hospitals.length; index += 1) {
      const hospital = hospitals[index];
      const serial = Number(hospital.hospitalNo) || (index + 1);
      const baseLoginId = `hosp${String(serial).padStart(4, '0')}`;
      const normalizedLoginId = String(hospital.loginId || baseLoginId).toLowerCase();

      const shouldSetPassword = resetExisting || !hospital.passwordHash;
      const shouldSetLoginId = !hospital.loginId || resetExisting;
      const shouldSetHospitalNo = !Number.isFinite(Number(hospital.hospitalNo)) || Number(hospital.hospitalNo) <= 0;

      if (!shouldSetLoginId && !shouldSetPassword && !shouldSetHospitalNo) continue;

      if (shouldSetHospitalNo) {
        hospital.hospitalNo = serial;
        assignedHospitalNoCount += 1;
      }

      if (shouldSetLoginId) hospital.loginId = normalizedLoginId;
      if (shouldSetPassword) hospital.passwordHash = passwordHash;
      await hospital.save();
      updatedCount += 1;
    }

    const sample = hospitals.slice(0, 25).map((h, index) => ({
      name: h.name,
      hospitalNo: h.loginId || `hosp${String(Number(h.hospitalNo) || (index + 1)).padStart(4, '0')}`
    }));

    return res.json({
      success: true,
      message: 'Hospital login credentials bootstrapped',
      totalHospitals: hospitals.length,
      updatedHospitals: updatedCount,
      hospitalNoAssignedInDb: assignedHospitalNoCount,
      defaultPassword,
      loginFormat: 'hosp0001 / hosp0002 / ...',
      sampleCredentials: sample
    });
  } catch (error) {
    console.error('Hospital bootstrap login error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to create hospital logins' });
  }
});

app.post('/api/hospital/migrate-login-ids', async (req, res) => {
  try {
    if (!isValidAdminKey(req)) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    const hospitals = await Hospital.find({ source: 'xlsx-import' }).sort({ hospitalNo: 1, name: 1 });
    let migratedCount = 0;

    for (let index = 0; index < hospitals.length; index += 1) {
      const hospital = hospitals[index];
      const serial = Number(hospital.hospitalNo) || (index + 1);
      const newLoginId = `hosp${String(serial).padStart(4, '0')}`;

      if (hospital.loginId !== newLoginId) {
        hospital.loginId = newLoginId;
        await hospital.save();
        migratedCount += 1;
      }
    }

    const sample = hospitals.slice(0, 10).map((h, index) => ({
      name: h.name,
      hospitalNo: `hosp${String(Number(h.hospitalNo) || (index + 1)).padStart(4, '0')}`
    }));

    return res.json({
      success: true,
      message: `Migrated ${migratedCount} hospital loginIds to new format`,
      totalHospitals: hospitals.length,
      migratedCount,
      sampleAfterMigration: sample
    });
  } catch (error) {
    console.error('Hospital loginId migration error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to migrate hospital loginIds' });
  }
});

app.get('/api/hospital/credentials', async (req, res) => {
  try {
    if (!isValidAdminKey(req)) {
      return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    const limitRequested = Number(req.query.limit || 2000);
    const limit = Math.max(1, Math.min(5000, Number.isFinite(limitRequested) ? limitRequested : 2000));
    const hospitals = await Hospital.find({ source: 'xlsx-import' })
      .sort({ hospitalNo: 1, name: 1 })
      .limit(limit)
      .select('hospitalNo name loginId source')
      .lean();

    return res.json({
      success: true,
      total: hospitals.length,
      credentials: hospitals.map((h, idx) => ({
        name: h.name,
        hospitalNo: h.loginId || `hosp${String(Number(h.hospitalNo) || (idx + 1)).padStart(4, '0')}`
      })),
      defaultPasswordNote: 'Use the default password configured during bootstrap (Hosp@123 unless overridden).'
    });
  } catch (error) {
    console.error('Hospital credentials list error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to load hospital credentials' });
  }
});

app.post('/api/hospital/login', async (req, res) => {
  try {
    const loginId = String(req.body?.loginId || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!loginId || !password) {
      return res.status(400).json({ success: false, message: 'Login ID and password are required' });
    }

    const hospital = await Hospital.findOne({ loginId });
    if (!hospital) {
      return res.status(404).json({ success: false, message: 'Hospital login ID not found' });
    }

    if (!hospital.passwordHash) {
      return res.status(400).json({ success: false, message: 'Hospital password is not set. Run bootstrap first.' });
    }

    const isMatch = await bcrypt.compare(password, hospital.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid password' });
    }

    hospital.lastLoginAt = new Date();
    await hospital.save();

    const token = signAuthToken({ hospitalId: hospital._id, role: 'hospital' });
    return res.json({
      success: true,
      token,
      hospital: {
        id: hospital._id,
        hospitalNo: hospital.hospitalNo,
        name: hospital.name,
        loginId: hospital.loginId,
        type: hospital.type,
        location: hospital.location,
        facilities: hospital.facilities,
        services: hospital.services,
        phoneNumber: hospital.phoneNumber
      }
    });
  } catch (error) {
    console.error('Hospital login error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Hospital login failed' });
  }
});

app.get('/api/hospital/me', requireHospitalAuth, async (req, res) => {
  const hospital = req.authHospital;
  return res.json({
    success: true,
    hospital: {
      id: hospital._id,
      hospitalNo: hospital.hospitalNo,
      name: hospital.name,
      loginId: hospital.loginId,
      type: hospital.type,
      location: hospital.location,
      facilities: hospital.facilities,
      services: hospital.services,
      phoneNumber: hospital.phoneNumber,
      lastLoginAt: hospital.lastLoginAt
    }
  });
});

app.put('/api/hospital/me/facilities', requireHospitalAuth, async (req, res) => {
  try {
    const hospital = req.authHospital;
    const toNumber = (value, fallback = 0) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(0, Math.round(n));
    };

    const current = hospital.facilities || {};
    const icuBeds = toNumber(req.body?.icuBeds, Number(current.icuBeds || 0));
    const generalBeds = toNumber(req.body?.generalBeds, Number(current.generalBeds || 0));
    const lowBeds = toNumber(req.body?.lowBeds, Number(current.lowBeds || 0));

    const requestedTotal = req.body?.totalBeds;
    const totalBeds = requestedTotal === undefined || requestedTotal === null || requestedTotal === ''
      ? Math.max(icuBeds + generalBeds + lowBeds, Number(current.totalBeds || 0))
      : toNumber(requestedTotal, icuBeds + generalBeds + lowBeds);

    hospital.facilities = {
      ...current,
      icuBeds,
      generalBeds,
      lowBeds,
      totalBeds: Math.max(totalBeds, icuBeds + generalBeds + lowBeds)
    };

    await hospital.save();

    return res.json({
      success: true,
      message: 'Hospital bed availability updated',
      facilities: hospital.facilities,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Hospital facilities update error:', error.message || error);
    return res.status(500).json({ success: false, message: 'Failed to update hospital facilities' });
  }
});

function getLocalMumbaiNearbyHospitals(userLat, userLng, radiusKm) {
  return dedupeHospitals(
    (localMumbaiHospitals || [])
      .map(entry => normalizeLocalMumbaiHospital(entry, userLat, userLng))
      .filter(Boolean)
      .filter(h => h.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance)
  );
}

async function fetchGoogleNearbyHospitals(userLat, userLng, radiusKm) {
  if (!googlePlacesApiKey) return [];

  const radiusMeters = Math.max(1000, Math.min(50000, Math.round(radiusKm * 1000)));
  const pages = [];
  let nextPageToken = null;

  for (let page = 0; page < 3; page += 1) {
    let url;
    if (nextPageToken) {
      // Google requires a short delay before using next_page_token.
      await new Promise(resolve => setTimeout(resolve, 2200));
      url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?pagetoken=${encodeURIComponent(nextPageToken)}&key=${encodeURIComponent(googlePlacesApiKey)}`;
    } else {
      url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${encodeURIComponent(`${userLat},${userLng}`)}&radius=${radiusMeters}&type=hospital&key=${encodeURIComponent(googlePlacesApiKey)}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || !data || (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS')) {
      break;
    }

    const normalized = (data.results || [])
      .map(place => normalizeGooglePlaceHospital(place, userLat, userLng))
      .filter(Boolean);

    pages.push(...normalized);
    nextPageToken = data.next_page_token;
    if (!nextPageToken) break;
  }

  return dedupeHospitals(pages);
}

async function fetchGoogleSearchHospitals(query, userLat, userLng) {
  if (!googlePlacesApiKey) return [];

  const pages = [];
  let nextPageToken = null;

  for (let page = 0; page < 3; page += 1) {
    let url;
    if (nextPageToken) {
      await new Promise(resolve => setTimeout(resolve, 2200));
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${encodeURIComponent(nextPageToken)}&key=${encodeURIComponent(googlePlacesApiKey)}`;
    } else {
      const text = `${query} hospital Mumbai`;
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(text)}&location=${encodeURIComponent(`${userLat},${userLng}`)}&radius=50000&key=${encodeURIComponent(googlePlacesApiKey)}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || !data || (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS')) {
      break;
    }

    const normalized = (data.results || [])
      .map(place => normalizeGooglePlaceHospital(place, userLat, userLng))
      .filter(Boolean);

    pages.push(...normalized);
    nextPageToken = data.next_page_token;
    if (!nextPageToken) break;
  }

  return dedupeHospitals(pages);
}

async function fetchOpenStreetMapNearbyHospitals(userLat, userLng, radiusKm) {
  const latDelta = Math.max(0.08, radiusKm / 111);
  const lngDelta = Math.max(0.08, radiusKm / (111 * Math.max(Math.cos(userLat * Math.PI / 180), 0.2)));
  const left = userLng - lngDelta;
  const right = userLng + lngDelta;
  const top = userLat + latDelta;
  const bottom = userLat - latDelta;

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent('hospital')}&bounded=1&limit=40&viewbox=${left},${top},${right},${bottom}`;

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'JeevanConnect/1.0 (Emergency Hospital Lookup)'
    }
  });

  if (!response.ok) return [];
  const places = await response.json();
  if (!Array.isArray(places)) return [];

  const normalized = places
    .map((place) => {
      const lat = Number(place.lat);
      const lng = Number(place.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      const distance = calculateDistance(userLat, userLng, lat, lng);
      if (!Number.isFinite(distance) || distance > Math.max(radiusKm, 50)) return null;

      const displayName = String(place.display_name || '').trim();
      const parsedName = displayName ? displayName.split(',')[0].trim() : '';
      const type = classifyHospitalOwnership(parsedName || 'Hospital');

      return {
        name: parsedName || 'Nearby Hospital',
        type,
        specialties: ['Emergency', 'General Care'],
        location: {
          lat,
          lng,
          address: displayName || '',
          city: '',
          state: ''
        },
        facilities: estimateHospitalFacilitiesByType(type),
        services: {
          opd: 'Unknown',
          lab: 'Unknown',
          bloodBank: 'Unknown',
          parking: 'Unknown',
          trauma: true
        },
        operatingHours: 'Hours unavailable',
        phoneNumber: '',
        rating: 4.0,
        distance: parseFloat(distance.toFixed(1)),
        driveTime: `${Math.max(2, Math.ceil(distance * 1.8))} min drive`,
        source: 'osm-nominatim'
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);

  return dedupeHospitals(normalized).slice(0, 30);
}

// Get nearby hospitals based on user location
app.get('/api/hospitals/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 10 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'Latitude and longitude required' });
    }

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const requestedRadius = parseFloat(radius) || 10;

    if (Number.isNaN(userLat) || Number.isNaN(userLng)) {
      return res.status(400).json({ success: false, message: 'Invalid latitude/longitude values' });
    }

    let nearby = await fetchGoogleNearbyHospitals(userLat, userLng, requestedRadius);
    let source = 'google-places';

    if (!nearby.length) {
      nearby = getLocalMumbaiNearbyHospitals(userLat, userLng, requestedRadius);
      if (nearby.length) {
        source = 'local-mumbai-dataset';
      }
    }

    if (!nearby.length) {
      nearby = await fetchOpenStreetMapNearbyHospitals(userLat, userLng, Math.max(requestedRadius, 20));
      if (nearby.length) {
        source = 'osm-nominatim';
      }
    }

    if (!nearby.length) {
      // Fallback to bundled dataset if Google Places is unavailable.
      nearby = mockHospitals
        .map(hospital => {
          const distance = calculateDistance(userLat, userLng, hospital.location.lat, hospital.location.lng);
          const driveTime = Math.ceil(distance * 1.5);
          return {
            ...hospital,
            distance: parseFloat(distance.toFixed(1)),
            driveTime: `${driveTime} min drive`,
            source: 'fallback-mock'
          };
        })
        .filter(h => h.distance <= requestedRadius)
        .sort((a, b) => a.distance - b.distance);

      source = 'fallback-mock';
    }

    nearby.sort((a, b) => a.distance - b.distance);

    // Calculate statistics
    const totalNearby = nearby.length;
    const totalICUBeds = nearby.reduce((sum, h) => sum + h.facilities.icuBeds, 0);
    const lowBedHospitals = nearby.filter(h => {
      const used = h.facilities.totalBeds - (h.facilities.generalBeds + h.facilities.icuBeds);
      return used > h.facilities.totalBeds * 0.8;
    });
    const fullHospitals = nearby.filter(h => h.facilities.icuBeds === 0);

    res.json({
      success: true,
      hospitals: nearby,
      stats: {
        nearby: totalNearby,
        icuBeds: totalICUBeds,
        lowBeds: lowBedHospitals.length,
        full: fullHospitals.length,
        source
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch hospitals' });
  }
});

// Search hospitals by name or area
app.get('/api/hospitals/search', async (req, res) => {
  try {
    const { query, lat, lng } = req.query;

    if (!query) {
      return res.status(400).json({ success: false, message: 'Search query required' });
    }

    const userLat = lat ? parseFloat(lat) : 19.0760;
    const userLng = lng ? parseFloat(lng) : 72.8777;

    let filtered = await fetchGoogleSearchHospitals(query, userLat, userLng);
    let source = 'google-places';

    if (!filtered.length) {
      const searchLower = query.toLowerCase();
      filtered = getLocalMumbaiNearbyHospitals(userLat, userLng, 50)
        .filter(h =>
          h.name.toLowerCase().includes(searchLower) ||
          h.type.toLowerCase().includes(searchLower) ||
          h.location.address.toLowerCase().includes(searchLower)
        )
        .sort((a, b) => a.distance - b.distance);

      if (filtered.length) {
        source = 'local-mumbai-dataset';
      }
    }

    if (!filtered.length) {
      const searchLower = query.toLowerCase();
      filtered = mockHospitals.filter(h =>
        h.name.toLowerCase().includes(searchLower) ||
        h.specialties.some(s => s.toLowerCase().includes(searchLower)) ||
        h.location.city.toLowerCase().includes(searchLower)
      );

      if (lat && lng) {
        filtered.forEach(h => {
          const distance = calculateDistance(userLat, userLng, h.location.lat, h.location.lng);
          h.distance = parseFloat(distance.toFixed(1));
          h.driveTime = `${Math.ceil(distance * 1.5)} min drive`;
        });

        filtered.sort((a, b) => a.distance - b.distance);
      }

      source = 'fallback-mock';
    }

    res.json({
      success: true,
      hospitals: filtered,
      source
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Search failed' });
  }
});

// Get hospital details
app.get('/api/hospitals/:id', async (req, res) => {
  try {
    const hospitalName = decodeURIComponent(req.params.id);
    const hospital = mockHospitals.find(h => h.name === hospitalName);
    
    if (!hospital) {
      return res.status(404).json({ success: false, message: 'Hospital not found' });
    }

    res.json({
      success: true,
      hospital
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch hospital details' });
  }
});

// Get hospital location map embed
app.get('/api/hospitals/map/:id', async (req, res) => {
  try {
    const hospitalName = decodeURIComponent(req.params.id);
    const hospital = mockHospitals.find(h => h.name === hospitalName);
    
    if (!hospital) {
      return res.status(404).json({ success: false, message: 'Hospital not found' });
    }

    const mapUrl = `https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3752.8866556!2d${hospital.location.lng}!3d${hospital.location.lat}!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x3bada91b6556a7f1%3A0x${hospital.name.replace(/ /g, '')}!2s${encodeURIComponent(hospital.name)}!5e0!3m2!1sen!2sin!4v1234567890`;

    res.json({
      success: true,
      mapUrl,
      hospital: {
        name: hospital.name,
        lat: hospital.location.lat,
        lng: hospital.location.lng,
        address: hospital.location.address
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get map' });
  }
});

// Socket.io real-time communication
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('citizen-register', () => {
    socket.join('citizens');
  });

  socket.on('driver-register', (payload = {}) => {
    const normalizedLocation = buildDriverLocation(payload.location || {}, payload.location || {});
    const driverProfile = {
      driverId: payload.driverId || socket.id,
      loginId: payload.loginId || null,
      ambulanceId: payload.ambulanceId || payload.vehicle || null,
      name: payload.name || 'Ambulance Driver',
      vehicle: payload.vehicle || 'Ambulance Unit',
      location: normalizedLocation,
      isAvailable: true
    };

    onlineDrivers.set(socket.id, driverProfile);
    socket.join('drivers');
    io.emit('dispatch-driver-count', { onlineDrivers: onlineDrivers.size });

    for (const [sosId, dispatch] of activeDispatches.entries()) {
      if (!dispatch || dispatch.status !== 'assigned') continue;
      const targetKeys = [
        dispatch.payload?.driverMongoId,
        dispatch.payload?.driverId,
        dispatch.payload?.driverLoginId,
        dispatch.payload?.driverAmbulanceId
      ].map(normalizeDriverKey).filter(Boolean);

      const liveKeys = [
        driverProfile.driverId,
        driverProfile.loginId,
        driverProfile.ambulanceId
      ].map(normalizeDriverKey).filter(Boolean);

      if (!targetKeys.length || !liveKeys.some((key) => targetKeys.includes(key))) continue;

      // Rebind mission to latest socket for the same driver identity after reconnect/login.
      if (dispatch.driverSocketId && dispatch.driverSocketId !== socket.id) {
        const previousDriver = onlineDrivers.get(dispatch.driverSocketId) || {};
        const previousKeys = [
          previousDriver.driverId,
          previousDriver.loginId,
          previousDriver.ambulanceId
        ].map(normalizeDriverKey).filter(Boolean);
        const sameDriverIdentity = previousKeys.length
          ? previousKeys.some((key) => targetKeys.includes(key))
          : true;
        if (!sameDriverIdentity) continue;
      }

      dispatch.driverSocketId = socket.id;
      activeDispatches.set(sosId, dispatch);

      socket.emit('dispatch-call', {
        ...dispatch.payload,
        status: 'ASSIGNED',
        emergencyId: dispatch.payload.emergencyId,
        patientLocation: dispatch.payload.patientLocation || dispatch.payload.location,
        routeStage: 'to_patient'
      });
      break;
    }
  });

  // Driver goes online
  socket.on('driver-online', async (data) => {
    const { driverId } = data;
    try {
      await Driver.findOneAndUpdate(
        { $or: [{ ambulanceId: driverId }, { driverId: driverId }, { loginId: driverId }] },
        { isOnline: true, status: 'available' }
      );
    } catch (error) {
      console.error('Error updating driver online status:', error.message || error);
    }
    socket.join('drivers');
    io.emit('driver-status-update', { driverId, isOnline: true });
  });

  // Driver location update
  socket.on('location-update', async (data) => {
    const { driverId, lat, lng } = data;
    const nextLocation = buildDriverLocation(data, { lat, lng });
    try {
      await Driver.findOneAndUpdate(
        { $or: [{ ambulanceId: driverId }, { driverId: driverId }, { loginId: driverId }] },
        {
          status: 'available',
          isOnline: true,
          location: nextLocation
        }
      );
    } catch (error) {
      console.error('Error updating driver location:', error.message || error);
    }
    socket.to('drivers').emit('driver-location-update', {
      driverId,
      lat,
      lng,
      address: nextLocation?.address || inferMumbaiLocality(Number(lat), Number(lng)) || null,
      city: nextLocation?.city || 'Mumbai',
      state: nextLocation?.state || 'Maharashtra'
    });

    if (onlineDrivers.has(socket.id)) {
      const driver = onlineDrivers.get(socket.id);
      driver.location = nextLocation;
      onlineDrivers.set(socket.id, driver);

      for (const [sosId, dispatch] of activeDispatches.entries()) {
        if (!dispatch || !dispatch.payload) continue;
        if (dispatch.status !== 'assigned' && dispatch.status !== 'enroute' && dispatch.status !== 'hospital_assigned') continue;

        const assignedKeys = [
          dispatch.payload.driverMongoId,
          dispatch.payload.driverId,
          dispatch.payload.driverLoginId,
          dispatch.payload.driverAmbulanceId,
          dispatch.payload.driverName
        ].map(normalizeDriverKey).filter(Boolean);

        const liveKeys = [
          driver.driverId,
          driver.loginId,
          driver.ambulanceId,
          driver.vehicle,
          driver.name
        ].map(normalizeDriverKey).filter(Boolean);

        if (!assignedKeys.length || !liveKeys.some((key) => assignedKeys.includes(key))) continue;

        dispatch.payload.driverLocation = { lat, lng };
        activeDispatches.set(sosId, dispatch);

        if (dispatch.citizenSocketId) {
          io.to(dispatch.citizenSocketId).emit('driver-location-update', {
            sosId,
            driverId: dispatch.payload.driverId || driver.driverId || null,
            lat,
            lng,
            address: nextLocation?.address || inferMumbaiLocality(Number(lat), Number(lng)) || null,
            city: nextLocation?.city || 'Mumbai',
            state: nextLocation?.state || 'Maharashtra',
            updatedAt: Date.now()
          });
        }
      }
    }
  });

  socket.on('citizen-sos-request', async (payload = {}) => {
    const sosId = payload.sosId || `SOS-${Date.now()}`;
    const resolvedSocketCitizenId = toObjectIdOrNull(payload.citizenId || payload.userId);
    const initiatorRole = payload.initiatedBy?.role || payload.requestedByRole || 'citizen';
    const genericCitizenNamePattern = /^(citizen sos request|unknown citizen|user|na)$/i;
    let resolvedCitizenProfile = null;

    if (resolvedSocketCitizenId) {
      resolvedCitizenProfile = await User.findById(resolvedSocketCitizenId).select('name phone').lean();
    }
    if (!resolvedCitizenProfile && payload.citizenPhone) {
      resolvedCitizenProfile = await User.findOne({ phone: payload.citizenPhone }).select('name phone _id').lean();
    }

    const payloadCitizenName = String(payload.citizenName || '').trim();
    const payloadCitizenPhone = String(payload.citizenPhone || '').trim();
    const profileCitizenName = String(resolvedCitizenProfile?.name || '').trim();
    const profileCitizenPhone = String(resolvedCitizenProfile?.phone || '').trim();

    const resolvedCitizenName = (!payloadCitizenName || genericCitizenNamePattern.test(payloadCitizenName))
      ? (profileCitizenName || payloadCitizenName || 'Unknown Citizen')
      : payloadCitizenName;
    const resolvedCitizenPhone = payloadCitizenPhone || profileCitizenPhone || '';
    const resolvedCitizenObjectId = resolvedSocketCitizenId || toObjectIdOrNull(resolvedCitizenProfile?._id);
    const resolvedRequesterName = String(payload.initiatedBy?.name || payload.requesterName || resolvedCitizenName || 'Unknown Citizen').trim();
    const resolvedRequesterPhone = String(payload.initiatedBy?.phone || payload.requesterPhone || resolvedCitizenPhone || '').trim();

    const dispatchPayload = {
      ...payload,
      sosId,
      status: 'pending',
      createdAt: payload.createdAt || Date.now(),
      citizenName: resolvedCitizenName,
      citizenPhone: resolvedCitizenPhone,
      requesterName: resolvedRequesterName,
      requesterPhone: resolvedRequesterPhone,
      initiatedBy: {
        role: ['citizen', 'admin', 'system', 'unknown'].includes(initiatorRole) ? initiatorRole : 'citizen',
        userId: resolvedCitizenObjectId,
        name: resolvedRequesterName,
        phone: resolvedRequesterPhone,
        socketId: socket.id
      }
    };

    let emergency = null;
    const emergencyId = payload.emergencyId || payload.sosId;
    if (emergencyId && mongoose.Types.ObjectId.isValid(emergencyId)) {
      emergency = await Emergency.findById(emergencyId);
    }

    if (!emergency) {
      emergency = new Emergency({
        citizenName: resolvedCitizenName || 'Unknown Citizen',
        citizenPhone: resolvedCitizenPhone || '',
        citizenId: resolvedCitizenObjectId,
        requestChannel: 'socket',
        initiatedBy: {
          role: ['citizen', 'admin', 'system', 'unknown'].includes(initiatorRole) ? initiatorRole : 'citizen',
          userId: resolvedCitizenObjectId,
          name: resolvedRequesterName,
          phone: resolvedRequesterPhone,
          socketId: socket.id
        },
        location: payload.location,
        emergencyType: payload.emergencyType || 'Emergency',
        description: payload.description || 'SOS request',
        priority: payload.priority || 'high',
        medicalSnapshot: payload.medicalSnapshot || {},
        status: 'pending'
      });
    } else {
      emergency.location = payload.location || emergency.location;
      emergency.emergencyType = payload.emergencyType || emergency.emergencyType;
      emergency.description = payload.description || emergency.description;
      emergency.priority = payload.priority || emergency.priority;
      emergency.medicalSnapshot = payload.medicalSnapshot || emergency.medicalSnapshot;
      emergency.citizenName = resolvedCitizenName || emergency.citizenName || 'Unknown Citizen';
      emergency.citizenPhone = resolvedCitizenPhone || emergency.citizenPhone || '';
      emergency.citizenId = emergency.citizenId || resolvedCitizenObjectId;
      emergency.requestChannel = emergency.requestChannel || 'socket';
      emergency.initiatedBy = {
        ...(emergency.initiatedBy || {}),
        role: ['citizen', 'admin', 'system', 'unknown'].includes(initiatorRole) ? initiatorRole : (emergency.initiatedBy?.role || 'citizen'),
        userId: resolvedCitizenObjectId || emergency.initiatedBy?.userId || null,
        name: resolvedRequesterName || emergency.initiatedBy?.name || resolvedCitizenName || 'Unknown Citizen',
        phone: resolvedRequesterPhone || emergency.initiatedBy?.phone || resolvedCitizenPhone || '',
        socketId: socket.id
      };
      emergency.status = 'pending';
    }

    await emergency.save();
    dispatchPayload.emergencyId = String(emergency._id);
    dispatchPayload.emergencyMongoId = String(emergency._id);
    dispatchPayload.medicalSnapshot = dispatchPayload.medicalSnapshot || emergency.medicalSnapshot || {};
    dispatchPayload.citizenName = dispatchPayload.citizenName || emergency.citizenName || 'Citizen SOS Request';
    dispatchPayload.citizenPhone = dispatchPayload.citizenPhone || emergency.citizenPhone || '';
    dispatchPayload.requesterName = dispatchPayload.requesterName || emergency.initiatedBy?.name || dispatchPayload.citizenName;
    dispatchPayload.requesterPhone = dispatchPayload.requesterPhone || emergency.initiatedBy?.phone || dispatchPayload.citizenPhone || '';
    dispatchPayload.patientLocation = payload.location || emergency.location || null;
    dispatchPayload.priority = payload.priority || emergency.priority || 'high';

    activeDispatches.set(sosId, {
      citizenSocketId: socket.id,
      payload: dispatchPayload,
      status: 'pending',
      driverSocketId: null
    });

    socket.emit('sos-pending', {
      sosId,
      message: 'SOS received. Finding nearest ambulance.'
    });

    setTimeout(async () => {
      const dispatch = activeDispatches.get(sosId);
      if (!dispatch || dispatch.status !== 'pending') return;

      const declinedDriverKeys = Array.isArray(dispatch.payload?.declinedDriverKeys) ? dispatch.payload.declinedDriverKeys : [];
      const candidates = await getAvailableAmbulanceCandidates({ excludeDriverKeys: declinedDriverKeys });
      const selection = pickNearestAmbulance(dispatch.payload?.patientLocation || payload.location, candidates);
      const selected = selection.selected;
      if (!selected) {
        socket.emit('sos-no-driver', {
          sosId,
          message: 'No available ambulance at the moment. Escalating to control room.'
        });
        return;
      }

      const { socketId: driverSocketId, mongoId, driverId: selectedDriverId, loginId, ambulanceId, name: driverName, vehicle, source, distanceKm, phone } = selected;
      dispatch.status = 'assigned';
      dispatch.driverSocketId = driverSocketId || null;
      dispatch.payload.status = 'assigned';
      dispatch.payload.driverId = selectedDriverId || mongoId || driverSocketId;
      dispatch.payload.driverMongoId = mongoId || null;
      dispatch.payload.driverLoginId = loginId || null;
      dispatch.payload.driverAmbulanceId = ambulanceId || vehicle;
      dispatch.payload.driverName = driverName;
      dispatch.payload.vehicle = vehicle;
      dispatch.payload.driverPhone = phone || '';
      dispatch.payload.driverSource = source;
      dispatch.payload.driverDistanceKm = normalizeDistanceKm(distanceKm);
      dispatch.payload.driverLocation = selected.location || null;
      const suggestedHospital = await selectBestHospitalForEmergency(
        payload.emergencyType || emergency.emergencyType || 'Emergency',
        dispatch.payload.patientLocation || payload.location || emergency.location || null
      );
      if (suggestedHospital) {
        dispatch.payload.assignedHospital = suggestedHospital;
      }
      dispatch.payload.assignmentBasis = {
        method: 'haversine-nearest',
        selectedDistanceKm: normalizeDistanceKm(distanceKm),
        selectedDriverId: selectedDriverId || mongoId || null,
        selectedDriverName: driverName,
        selectedDriverVehicle: ambulanceId || vehicle,
        rankedCandidates: selection.ranked.slice(0, 5).map((candidate, index) => ({
          rank: index + 1,
          driverId: candidate.driverId || candidate.mongoId || null,
          driverName: candidate.name,
          ambulanceId: candidate.ambulanceId || candidate.vehicle,
          distanceKm: normalizeDistanceKm(candidate.distanceKm),
          online: Boolean(candidate.socketId)
        }))
      };
      activeDispatches.set(sosId, dispatch);

      if (driverSocketId) {
        onlineDrivers.set(driverSocketId, {
          ...(onlineDrivers.get(driverSocketId) || {}),
          driverId: selectedDriverId || mongoId || driverSocketId,
          loginId,
          ambulanceId: ambulanceId || vehicle,
          name: driverName,
          vehicle,
          isAvailable: false
        });
      }

      if (mongoId && mongoose.Types.ObjectId.isValid(String(mongoId))) {
        await Driver.findByIdAndUpdate(mongoId, { status: 'busy', isOnline: true });
      }

      emergency.status = 'assigned';
      emergency.assignedDriver = mongoId && mongoose.Types.ObjectId.isValid(String(mongoId)) ? mongoId : emergency.assignedDriver;
      emergency.assignedHospital = suggestedHospital?.hospitalId || emergency.assignedHospital || null;
      emergency.assignedDriverSnapshot = {
        driverId: selectedDriverId || null,
        loginId: loginId || null,
        ambulanceId: ambulanceId || vehicle || null,
        name: driverName || 'Ambulance Driver',
        vehicle: vehicle || ambulanceId || 'Ambulance Unit',
        phone: phone || '',
        source: source || 'dispatch',
        distanceKm: normalizeDistanceKm(distanceKm),
        location: selected.location || null
      };
      await emergency.save();

      io.to(dispatch.citizenSocketId).emit('sos-assigned', {
        sosId,
        emergencyId: String(emergency._id),
        driverId: selectedDriverId || mongoId || null,
        driverName,
        vehicle,
        driverPhone: phone || '',
        driverDistanceKm: distanceKm,
        driverLocation: selected.location || null,
        etaMinutes: payload.etaMinutes || Math.max(3, Math.ceil((distanceKm || 1) * 2)),
        patientLocation: payload.location || null,
        assignedHospital: dispatch.payload.assignedHospital || null,
        emergencyType: payload.emergencyType || emergency.emergencyType || 'Emergency',
        priority: payload.priority || emergency.priority || 'high',
        assignmentBasis: dispatch.payload.assignmentBasis
      });

      if (driverSocketId) {
        io.to(driverSocketId).emit('dispatch-call', {
          ...dispatch.payload,
          status: 'ASSIGNED',
          patientLocation: payload.location || null,
          emergencyId: String(emergency._id),
          routeStage: 'to_patient'
        });
      }
    }, 1500 + Math.floor(Math.random() * 2500));
  });

  socket.on('citizen-cancel-sos', async (payload = {}) => {
    const result = await cancelEmergencyAndDispatch({
      emergencyId: payload.emergencyId || payload.sosId || null,
      sosId: payload.sosId || null,
      cancelledBy: {
        role: 'citizen',
        userId: payload.citizenId || payload.userId || null,
        name: payload.citizenName || payload.requesterName || '',
        phone: payload.citizenPhone || payload.requesterPhone || '',
        socketId: socket.id
      }
    });

    if (!result.success) {
      socket.emit('sos-cancel-failed', {
        sosId: payload.sosId || null,
        emergencyId: payload.emergencyId || null,
        message: result.message || 'Unable to cancel SOS'
      });
      return;
    }

    socket.emit('sos-cancelled', {
      sosId: result.sosId,
      emergencyId: result.emergencyId,
      message: 'SOS request cancelled'
    });
  });

  socket.on('driver-accept-dispatch', async (payload = {}) => {
    const dispatch = activeDispatches.get(payload.sosId);
    if (!dispatch) return;

    if (dispatch.status !== 'assigned') {
      socket.emit('dispatch-accept-ignored', {
        sosId: payload.sosId,
        reason: `Dispatch already ${dispatch.status || 'updated'}`
      });
      return;
    }

    const assignedKeys = [
      dispatch.payload?.driverMongoId,
      dispatch.payload?.driverId,
      dispatch.payload?.driverLoginId,
      dispatch.payload?.driverAmbulanceId
    ].map(normalizeDriverKey).filter(Boolean);

    const socketDriver = onlineDrivers.get(socket.id) || {};
    const socketDriverKeys = [
      socketDriver.driverId,
      socketDriver.loginId,
      socketDriver.ambulanceId
    ].map(normalizeDriverKey).filter(Boolean);

    const requestKeys = [
      payload.driverId,
      payload.vehicle
    ].map(normalizeDriverKey).filter(Boolean);

    if (!dispatch.driverSocketId || dispatch.driverSocketId !== socket.id) {
      const canRebindByIdentity = assignedKeys.length
        && (
          (socketDriverKeys.length && socketDriverKeys.some((key) => assignedKeys.includes(key)))
          || (requestKeys.length && requestKeys.some((key) => assignedKeys.includes(key)))
        );

      if (canRebindByIdentity) {
        dispatch.driverSocketId = socket.id;
        activeDispatches.set(payload.sosId, dispatch);
      } else {
        socket.emit('dispatch-accept-ignored', {
          sosId: payload.sosId,
          reason: 'Only assigned driver socket can accept this mission'
        });
        return;
      }
    }

    if (assignedKeys.length && socketDriverKeys.length && !socketDriverKeys.some((key) => assignedKeys.includes(key))) {
      socket.emit('dispatch-accept-ignored', {
        sosId: payload.sosId,
        reason: 'Driver identity mismatch for this mission'
      });
      return;
    }

    if (assignedKeys.length && requestKeys.length && !requestKeys.some((key) => assignedKeys.includes(key))) {
      socket.emit('dispatch-accept-ignored', {
        sosId: payload.sosId,
        reason: 'Only assigned driver can accept this mission'
      });
      return;
    }

    dispatch.status = 'enroute';
    dispatch.payload.status = 'enroute';
    activeDispatches.set(payload.sosId, dispatch);

    if (dispatch.driverSocketId) {
      const liveDriver = onlineDrivers.get(dispatch.driverSocketId);
      if (liveDriver) {
        onlineDrivers.set(dispatch.driverSocketId, { ...liveDriver, isAvailable: false });
      }
    }

    if (dispatch.payload.driverMongoId && mongoose.Types.ObjectId.isValid(String(dispatch.payload.driverMongoId))) {
      await Driver.findByIdAndUpdate(dispatch.payload.driverMongoId, { status: 'busy', isOnline: true }).catch(() => {});
    }

    if (dispatch.payload.emergencyId && mongoose.Types.ObjectId.isValid(dispatch.payload.emergencyId)) {
      const assignedDriverMongoId = await resolveDriverMongoId(
        dispatch.payload.driverMongoId,
        dispatch.payload.driverId,
        dispatch.payload.driverLoginId,
        dispatch.payload.driverAmbulanceId,
        payload.driverId,
        payload.driverName,
        payload.vehicle
      );

      Emergency.findByIdAndUpdate(dispatch.payload.emergencyId, {
        status: 'enroute',
        assignedDriver: assignedDriverMongoId || null
      }).catch(() => {});
    }

    io.to(dispatch.citizenSocketId).emit('driver-accepted', {
      sosId: payload.sosId,
      driverId: dispatch.payload.driverId || payload.driverId || null,
      driverName: payload.driverName || dispatch.payload.driverName || 'Assigned Driver',
      vehicle: payload.vehicle || dispatch.payload.vehicle || 'Ambulance Unit',
      driverPhone: dispatch.payload.driverPhone || '',
      driverLocation: dispatch.payload.driverLocation || null,
      acceptedAt: Date.now()
    });
  });

  socket.on('driver-decline-dispatch', async (payload = {}) => {
    const dispatch = activeDispatches.get(payload.sosId);
    if (!dispatch) return;

    const declinedKeys = new Set((dispatch.payload.declinedDriverKeys || []).map(normalizeDriverKey));
    [
      dispatch.payload.driverMongoId,
      dispatch.payload.driverId,
      dispatch.payload.driverLoginId,
      dispatch.payload.driverAmbulanceId,
      dispatch.payload.driverName,
      payload.driverId,
      payload.driverName,
      payload.vehicle
    ].map(normalizeDriverKey).filter(Boolean).forEach((key) => declinedKeys.add(key));

    dispatch.payload.declinedDriverKeys = Array.from(declinedKeys);
    dispatch.payload.declineCount = Number(dispatch.payload.declineCount || 0) + 1;
    dispatch.status = 'pending';
    dispatch.payload.status = 'pending';
    dispatch.driverSocketId = null;
    activeDispatches.set(payload.sosId, dispatch);

    if (dispatch.payload.driverMongoId && mongoose.Types.ObjectId.isValid(String(dispatch.payload.driverMongoId))) {
      await Driver.findByIdAndUpdate(dispatch.payload.driverMongoId, { status: 'available', isOnline: true }).catch(() => {});
    }

    const candidates = await getAvailableAmbulanceCandidates({ excludeDriverKeys: dispatch.payload.declinedDriverKeys });
    const selection = pickNearestAmbulance(dispatch.payload.patientLocation || dispatch.payload.location, candidates);
    const selected = selection.selected;

    if (!selected) {
      io.to(dispatch.citizenSocketId).emit('sos-no-driver', {
        sosId: payload.sosId,
        message: 'Assigned driver declined and no other available ambulance found.'
      });
      return;
    }

    const { socketId: driverSocketId, mongoId, driverId: selectedDriverId, loginId, ambulanceId, name: driverName, vehicle, source, distanceKm, phone } = selected;

    dispatch.status = 'assigned';
    dispatch.driverSocketId = driverSocketId || null;
    dispatch.payload.status = 'assigned';
    dispatch.payload.driverId = selectedDriverId || mongoId || null;
    dispatch.payload.driverMongoId = mongoId || null;
    dispatch.payload.driverLoginId = loginId || null;
    dispatch.payload.driverAmbulanceId = ambulanceId || vehicle;
    dispatch.payload.driverName = driverName;
    dispatch.payload.vehicle = vehicle;
    dispatch.payload.driverPhone = phone || '';
    dispatch.payload.driverSource = source;
    dispatch.payload.driverDistanceKm = normalizeDistanceKm(distanceKm);
    dispatch.payload.driverLocation = selected.location || null;
    const reassignedHospital = dispatch.payload.assignedHospital || await selectBestHospitalForEmergency(
      dispatch.payload.emergencyType || 'Emergency',
      dispatch.payload.patientLocation || dispatch.payload.location || null
    );
    if (reassignedHospital) {
      dispatch.payload.assignedHospital = reassignedHospital;
    }
    dispatch.payload.assignmentBasis = {
      method: 'haversine-nearest',
      reason: 'previous-driver-declined',
      selectedDistanceKm: normalizeDistanceKm(distanceKm),
      selectedDriverId: selectedDriverId || mongoId || null,
      selectedDriverName: driverName,
      selectedDriverVehicle: ambulanceId || vehicle,
      rankedCandidates: selection.ranked.slice(0, 5).map((candidate, index) => ({
        rank: index + 1,
        driverId: candidate.driverId || candidate.mongoId || null,
        driverName: candidate.name,
        ambulanceId: candidate.ambulanceId || candidate.vehicle,
        distanceKm: normalizeDistanceKm(candidate.distanceKm),
        online: Boolean(candidate.socketId)
      }))
    };
    activeDispatches.set(payload.sosId, dispatch);

    if (mongoId && mongoose.Types.ObjectId.isValid(String(mongoId))) {
      await Driver.findByIdAndUpdate(mongoId, { status: 'available', isOnline: Boolean(driverSocketId) }).catch(() => {});
    }

    if (dispatch.payload.emergencyId && mongoose.Types.ObjectId.isValid(dispatch.payload.emergencyId)) {
      await Emergency.findByIdAndUpdate(dispatch.payload.emergencyId, {
        status: 'assigned',
        assignedDriver: mongoId && mongoose.Types.ObjectId.isValid(String(mongoId)) ? mongoId : null,
        assignedHospital: reassignedHospital?.hospitalId || null,
        assignedDriverSnapshot: {
          driverId: selectedDriverId || null,
          loginId: loginId || null,
          ambulanceId: ambulanceId || vehicle || null,
          name: driverName || 'Ambulance Driver',
          vehicle: vehicle || ambulanceId || 'Ambulance Unit',
          phone: phone || '',
          source: source || 'dispatch-reassign',
          distanceKm: normalizeDistanceKm(distanceKm),
          location: selected.location || null
        }
      }).catch(() => {});
    }

    io.to(dispatch.citizenSocketId).emit('sos-assigned', {
      sosId: payload.sosId,
      emergencyId: dispatch.payload.emergencyId,
      driverId: dispatch.payload.driverId,
      driverName,
      vehicle,
      driverPhone: phone || '',
      driverDistanceKm: distanceKm,
      driverLocation: selected.location || null,
      etaMinutes: Math.max(3, Math.ceil((distanceKm || 1) * 2)),
      patientLocation: dispatch.payload.patientLocation || dispatch.payload.location || null,
      assignedHospital: dispatch.payload.assignedHospital || null,
      emergencyType: dispatch.payload.emergencyType || 'Emergency',
      priority: dispatch.payload.priority || 'high',
      assignmentBasis: dispatch.payload.assignmentBasis
    });

    if (driverSocketId) {
      io.to(driverSocketId).emit('dispatch-call', {
        ...dispatch.payload,
        status: 'ASSIGNED',
        patientLocation: dispatch.payload.patientLocation || dispatch.payload.location || null,
        emergencyId: dispatch.payload.emergencyId,
        routeStage: 'to_patient'
      });
    }
  });

  socket.on('driver-patient-picked', async (payload = {}) => {
    const dispatch = activeDispatches.get(payload.sosId);
    if (!dispatch) return;

    const hospital = await selectBestHospitalForEmergency(
      payload.emergencyType || dispatch.payload.emergencyType,
      payload.patientLocation || dispatch.payload.patientLocation || dispatch.payload.location
    );

    if (!hospital) {
      io.to(dispatch.citizenSocketId).emit('hospital-selection-failed', {
        sosId: payload.sosId,
        message: 'No suitable hospital found'
      });
      return;
    }

    dispatch.status = 'hospital_assigned';
    dispatch.payload.status = 'hospital_assigned';
    dispatch.payload.assignedHospital = hospital;
    activeDispatches.set(payload.sosId, dispatch);

    if (dispatch.payload.emergencyId && mongoose.Types.ObjectId.isValid(dispatch.payload.emergencyId)) {
      await Emergency.findByIdAndUpdate(dispatch.payload.emergencyId, {
        status: 'arrived',
        assignedHospital: hospital.hospitalId,
        hospitalAssignedAt: new Date(),
        ambulancePickedAt: new Date()
      }).catch(() => {});
    }

    io.to(dispatch.citizenSocketId).emit('hospital-assigned', {
      sosId: payload.sosId,
      hospital,
      patientLocation: payload.patientLocation || dispatch.payload.patientLocation || dispatch.payload.location,
      emergencyType: payload.emergencyType || dispatch.payload.emergencyType
    });

    if (dispatch.driverSocketId) {
      io.to(dispatch.driverSocketId).emit('hospital-assigned', {
        sosId: payload.sosId,
        hospital,
        patientLocation: payload.patientLocation || dispatch.payload.patientLocation || dispatch.payload.location,
        emergencyType: payload.emergencyType || dispatch.payload.emergencyType
      });
    }
  });

  socket.on('driver-emergency-completed', async (payload = {}) => {
    const dispatch = activeDispatches.get(payload.sosId);
    if (!dispatch) return;

    dispatch.status = 'completed';
    dispatch.payload.status = 'completed';
    activeDispatches.set(payload.sosId, dispatch);

    if (dispatch.payload.emergencyId && mongoose.Types.ObjectId.isValid(dispatch.payload.emergencyId)) {
      const completionDriverMongoId = await resolveDriverMongoId(
        dispatch.payload.driverMongoId,
        dispatch.payload.driverId,
        dispatch.payload.driverLoginId,
        dispatch.payload.driverAmbulanceId,
        payload.driverId
      );

      await Emergency.findByIdAndUpdate(dispatch.payload.emergencyId, {
        status: 'completed',
        completedAt: new Date(),
        assignedDriver: completionDriverMongoId || null,
        assignedHospital: dispatch.payload.assignedHospital?.hospitalId || null
      }).catch(() => {});
    }

    if (dispatch.driverSocketId) {
      const liveDriver = onlineDrivers.get(dispatch.driverSocketId);
      if (liveDriver) {
        onlineDrivers.set(dispatch.driverSocketId, {
          ...liveDriver,
          isAvailable: true
        });
      }
    }

    const completionDriverId = dispatch.payload.driverMongoId || payload.driverId;
    if (completionDriverId && mongoose.Types.ObjectId.isValid(String(completionDriverId))) {
      await Driver.findByIdAndUpdate(completionDriverId, { status: 'available', isOnline: true }).catch(() => {});
    }

    io.to(dispatch.citizenSocketId).emit('emergency-completed', {
      sosId: payload.sosId,
      completedAt: Date.now()
    });

    if (dispatch.driverSocketId) {
      io.to(dispatch.driverSocketId).emit('emergency-completed', {
        sosId: payload.sosId,
        completedAt: Date.now()
      });
    }
  });

  // Emergency assignment
  socket.on('assign-emergency', async (data) => {
    const { emergencyId, driverId, hospitalId } = data;
    const assignedDriverMongoId = await resolveDriverMongoId(driverId);

    await Emergency.findByIdAndUpdate(emergencyId, {
      status: 'assigned',
      assignedDriver: assignedDriverMongoId || null,
      assignedHospital: hospitalId || null,
      ambulancePickedAt: new Date()
    });

    const emergency = await Emergency.findById(emergencyId).populate('citizenId');
    io.to(socket.id).emit('emergency-assigned', emergency);
  });

  socket.on('disconnect', () => {
    onlineDrivers.delete(socket.id);
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing process or change PORT in backend/.env.`);
    process.exit(1);
  }
  console.error('Server startup error:', error.message || error);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
