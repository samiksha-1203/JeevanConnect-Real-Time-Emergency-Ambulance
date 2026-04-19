const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const XLSX = require('xlsx');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/jeevanconnect';
const DATASET_PATH = path.join(__dirname, '..', 'mumbai-hospitals-all.xlsx');

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isValidHospitalName(name) {
  const normalized = normalizeWhitespace(name).toLowerCase();
  if (!normalized) return false;
  return !['unnamed', 'unnamed hospital', 'unknown', 'n/a', 'na'].includes(normalized);
}

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

function loadXlsxRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '' });
}

function sanitizeRows(rows) {
  const unique = new Map();

  for (const row of rows) {
    const name = normalizeWhitespace(row.HospitalName || row.name || '');
    const lat = Number(row.Latitude || row.lat);
    const lng = Number(row.Longitude || row.lng);
    if (!isValidHospitalName(name) || Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const key = `${name.toLowerCase()}|${Math.round(lat * 10000)}|${Math.round(lng * 10000)}`;
    if (!unique.has(key)) {
      unique.set(key, {
        name,
        lat: Number(lat.toFixed(7)),
        lng: Number(lng.toFixed(7)),
        city: normalizeWhitespace(row.City || row.city || 'Mumbai') || 'Mumbai',
        address: normalizeWhitespace(row.Address || row.address || ''),
        phone: normalizeWhitespace(row.Phone || row.phone || '')
      });
    }
  }

  return Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name));
}

const HospitalSchema = new mongoose.Schema({
  name: { type: String, required: true },
  hospitalNo: Number,
  source: { type: String, default: 'system' },
  type: { type: String, enum: ['Government', 'Private', 'Trust'], default: 'Government' },
  specialties: [String],
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
    lab: { type: String, default: 'Available' },
    bloodBank: { type: String, default: 'Unknown' },
    parking: { type: String, default: 'Unknown' },
    trauma: { type: Boolean, default: true },
    cardiology: { type: Boolean, default: false }
  },
  operatingHours: String,
  phoneNumber: String,
  rating: { type: Number, default: 4.0 }
});

const Hospital = mongoose.models.Hospital || mongoose.model('Hospital', HospitalSchema);

async function main() {
  if (!require('fs').existsSync(DATASET_PATH)) {
    throw new Error(`Dataset not found: ${DATASET_PATH}`);
  }

  const rows = sanitizeRows(loadXlsxRows(DATASET_PATH));
  if (!rows.length) {
    throw new Error('No valid hospitals found in XLSX file');
  }

  await mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  const ops = rows.map((row, index) => {
    const type = classifyHospitalOwnership(row.name);
    return {
      updateOne: {
        filter: {
          name: row.name,
          'location.lat': row.lat,
          'location.lng': row.lng
        },
        update: {
          $set: {
            hospitalNo: index + 1,
            source: 'xlsx-import',
            name: row.name,
            type,
            specialties: ['Emergency', 'General Care'],
            location: {
              lat: row.lat,
              lng: row.lng,
              address: row.address,
              city: row.city,
              state: 'Maharashtra'
            },
            facilities: estimateHospitalFacilitiesByType(type),
            services: {
              opd: 'Open',
              lab: 'Available',
              bloodBank: 'Unknown',
              parking: 'Unknown',
              trauma: true,
              cardiology: false
            },
            operatingHours: 'Hours unavailable',
            phoneNumber: row.phone,
            rating: 4.0
          }
        },
        upsert: true
      }
    };
  });

  const result = await Hospital.bulkWrite(ops, { ordered: false });

  const totalImported = await Hospital.countDocuments({ source: 'xlsx-import' });

  console.log('Hospital import complete');
  console.log(`Rows read: ${rows.length}`);
  console.log(`Upserted: ${result.upsertedCount || 0}`);
  console.log(`Modified: ${result.modifiedCount || 0}`);
  console.log(`Mongo source=xlsx-import count: ${totalImported}`);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('Hospital import failed:', error.message || error);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
