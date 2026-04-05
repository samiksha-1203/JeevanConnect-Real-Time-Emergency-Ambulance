const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey
  });
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/jeevanconnect', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.log(err));

// Models
const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  name: String,
  email: String,
  bloodGroup: String,
  role: { type: String, enum: ['citizen', 'driver'], default: 'citizen' },
  isVerified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const DriverSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  licenseNumber: String,
  vehicleType: { type: String, default: 'Basic Life Support' },
  ambulanceId: String,
  isOnline: { type: Boolean, default: false },
  location: {
    lat: Number,
    lng: Number,
    lastUpdated: Date
  },
  createdAt: { type: Date, default: Date.now }
});

const EmergencySchema = new mongoose.Schema({
  citizenId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  location: {
    lat: Number,
    lng: Number,
    address: String
  },
  status: { type: String, enum: ['pending', 'assigned', 'enroute', 'arrived', 'completed'], default: 'pending' },
  assignedDriver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'high' },
  description: String,
  createdAt: { type: Date, default: Date.now }
});

const HospitalSchema = new mongoose.Schema({
  name: { type: String, required: true },
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

    if (smsStatus !== 'sent' && twilioClient && twilioFromNumber) {
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
      demoOtp: smsStatus !== 'sent' ? otp : undefined
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

    // Generate JWT token
    const token = require('jsonwebtoken').sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET || 'jeevanconnect_secret',
      { expiresIn: '7d' }
    );

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

app.post('/api/driver/register', async (req, res) => {
  try {
    const { phone, name, licenseNumber, vehicleType } = req.body;

    const existingDriver = await Driver.findOne({ phone });
    if (existingDriver) {
      return res.status(400).json({ success: false, message: 'Driver already exists' });
    }

    const driver = new Driver({
      phone,
      name,
      licenseNumber,
      vehicleType: vehicleType || 'Basic Life Support'
    });

    await driver.save();
    res.json({ success: true, message: 'Driver registration successful' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Driver registration failed' });
  }
});

app.post('/api/driver/login', async (req, res) => {
  try {
    const { ambulanceId, phone } = req.body;

    const driver = await Driver.findOne({ phone });
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    // Generate token
    const token = require('jsonwebtoken').sign(
      { driverId: driver._id, role: 'driver' },
      process.env.JWT_SECRET || 'jeevanconnect_secret',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      driver: {
        id: driver._id,
        name: driver.name,
        vehicleType: driver.vehicleType,
        ambulanceId: driver.ambulanceId
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

app.post('/api/emergency', async (req, res) => {
  try {
    const { citizenId, location, description, priority } = req.body;

    const emergency = new Emergency({
      citizenId,
      location,
      description,
      priority: priority || 'high'
    });

    await emergency.save();

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
    res.status(500).json({ success: false, message: 'Failed to create emergency request' });
  }
});

// ═══════════════════════════════════════════
// HOSPITAL ROUTES
// ═══════════════════════════════════════════

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

// Get nearby hospitals based on user location
app.get('/api/hospitals/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 10 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'Latitude and longitude required' });
    }

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);

    // Use mock data with distance calculation
    const hospitalsWithDistance = mockHospitals.map(hospital => {
      const distance = calculateDistance(userLat, userLng, hospital.location.lat, hospital.location.lng);
      const driveTime = Math.ceil(distance * 1.5); // Approximate 1.5 min per km
      
      return {
        ...hospital,
        distance: parseFloat(distance.toFixed(1)),
        driveTime: `${driveTime} min drive`
      };
    });

    // Filter by radius
    const nearby = hospitalsWithDistance.filter(h => h.distance <= parseFloat(radius));

    // Sort by distance
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
        full: fullHospitals.length
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

    const searchLower = query.toLowerCase();
    const filtered = mockHospitals.filter(h => 
      h.name.toLowerCase().includes(searchLower) ||
      h.specialties.some(s => s.toLowerCase().includes(searchLower)) ||
      h.location.city.toLowerCase().includes(searchLower)
    );

    // Add distance if coordinates provided
    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      
      filtered.forEach(h => {
        const distance = calculateDistance(userLat, userLng, h.location.lat, h.location.lng);
        h.distance = parseFloat(distance.toFixed(1));
        h.driveTime = `${Math.ceil(distance * 1.5)} min drive`;
      });

      filtered.sort((a, b) => a.distance - b.distance);
    }

    res.json({
      success: true,
      hospitals: filtered
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Search failed' });
  }
});

// Get hospital details
app.get('/api/hospitals/:id', async (req, res) => {
  try {
    const hospital = mockHospitals.find(h => h.name === decodeURIComponent(req.params.id));
    
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
    const hospital = mockHospitals.find(h => h.name === decodeURIComponent(req.params.id));
    
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
    const driverProfile = {
      driverId: payload.driverId || socket.id,
      name: payload.name || 'Ambulance Driver',
      vehicle: payload.vehicle || 'Ambulance Unit',
      location: payload.location || null,
      isAvailable: payload.isAvailable !== false
    };

    onlineDrivers.set(socket.id, driverProfile);
    socket.join('drivers');
    io.emit('dispatch-driver-count', { onlineDrivers: onlineDrivers.size });
  });

  // Driver goes online
  socket.on('driver-online', async (data) => {
    const { driverId } = data;
    await Driver.findByIdAndUpdate(driverId, { isOnline: true });
    socket.join('drivers');
    io.emit('driver-status-update', { driverId, isOnline: true });
  });

  // Driver location update
  socket.on('location-update', async (data) => {
    const { driverId, lat, lng } = data;
    await Driver.findByIdAndUpdate(driverId, {
      location: { lat, lng, lastUpdated: new Date() }
    });
    socket.to('drivers').emit('driver-location-update', { driverId, lat, lng });

    if (onlineDrivers.has(socket.id)) {
      const driver = onlineDrivers.get(socket.id);
      driver.location = { lat, lng };
      onlineDrivers.set(socket.id, driver);
    }
  });

  socket.on('citizen-sos-request', (payload = {}) => {
    const sosId = payload.sosId || `SOS-${Date.now()}`;
    const dispatchPayload = {
      ...payload,
      sosId,
      status: 'pending',
      createdAt: payload.createdAt || Date.now()
    };

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

    setTimeout(() => {
      const dispatch = activeDispatches.get(sosId);
      if (!dispatch || dispatch.status !== 'pending') return;

      const selected = pickNearestAvailableDriver(payload.location);
      if (!selected) {
        socket.emit('sos-no-driver', {
          sosId,
          message: 'No available ambulance at the moment. Escalating to control room.'
        });
        return;
      }

      const { socketId: driverSocketId, driver } = selected;
      dispatch.status = 'assigned';
      dispatch.driverSocketId = driverSocketId;
      dispatch.payload.status = 'assigned';
      dispatch.payload.driverName = driver.name;
      dispatch.payload.vehicle = driver.vehicle;
      activeDispatches.set(sosId, dispatch);

      onlineDrivers.set(driverSocketId, {
        ...driver,
        isAvailable: false
      });

      io.to(dispatch.citizenSocketId).emit('sos-assigned', {
        sosId,
        driverName: driver.name,
        vehicle: driver.vehicle,
        etaMinutes: payload.etaMinutes || 7
      });

      io.to(driverSocketId).emit('dispatch-call', {
        ...dispatch.payload,
        status: 'ASSIGNED'
      });
    }, 1500 + Math.floor(Math.random() * 2500));
  });

  socket.on('driver-accept-dispatch', (payload = {}) => {
    const dispatch = activeDispatches.get(payload.sosId);
    if (!dispatch) return;

    dispatch.status = 'enroute';
    dispatch.payload.status = 'enroute';
    activeDispatches.set(payload.sosId, dispatch);

    io.to(dispatch.citizenSocketId).emit('driver-accepted', {
      sosId: payload.sosId,
      driverName: payload.driverName || dispatch.payload.driverName || 'Assigned Driver',
      vehicle: payload.vehicle || dispatch.payload.vehicle || 'Ambulance Unit',
      acceptedAt: Date.now()
    });
  });

  // Emergency assignment
  socket.on('assign-emergency', async (data) => {
    const { emergencyId, driverId } = data;
    await Emergency.findByIdAndUpdate(emergencyId, {
      status: 'assigned',
      assignedDriver: driverId
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