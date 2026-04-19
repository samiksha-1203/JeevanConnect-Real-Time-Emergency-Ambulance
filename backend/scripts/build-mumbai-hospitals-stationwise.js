const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const XLSX = require('xlsx');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const OUTPUT_XLSX = path.join(__dirname, '..', 'mumbai-hospitals-all.xlsx');
const OUTPUT_REPORT = path.join(__dirname, '..', 'mumbai-hospitals-stationwise-report.json');
const CHECKPOINT_FILE = path.join(__dirname, '..', '.mumbai-hospitals-checkpoint.json');
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const STATIONS = [
  { name: 'Churchgate', lat: 18.935, lng: 72.827 },
  { name: 'CSMT', lat: 18.9398, lng: 72.8354 },
  { name: 'Marine Lines', lat: 18.9449, lng: 72.8231 },
  { name: 'Charni Road', lat: 18.9515, lng: 72.8194 },
  { name: 'Grant Road', lat: 18.9663, lng: 72.8134 },
  { name: 'Mumbai Central', lat: 18.9696, lng: 72.8193 },
  { name: 'Mahalaxmi', lat: 18.9823, lng: 72.8186 },
  { name: 'Lower Parel', lat: 18.9952, lng: 72.83 },
  { name: 'Dadar', lat: 19.0187, lng: 72.8429 },
  { name: 'Matunga', lat: 19.0274, lng: 72.8503 },
  { name: 'Sion', lat: 19.0469, lng: 72.8649 },
  { name: 'Kurla', lat: 19.0717, lng: 72.8781 },
  { name: 'Chembur', lat: 19.0522, lng: 72.8945 },
  { name: 'Govandi', lat: 19.0552, lng: 72.9158 },
  { name: 'Mankhurd', lat: 19.0504, lng: 72.9313 },
  { name: 'Wadala Road', lat: 19.0179, lng: 72.8564 },
  { name: 'Prabhadevi (Elphinstone Road)', lat: 19.0164, lng: 72.8305 },
  { name: 'Matunga Road', lat: 19.0279, lng: 72.8449 },
  { name: 'Mahim', lat: 19.0422, lng: 72.8398 },
  { name: 'Bandra', lat: 19.0544, lng: 72.8402 },
  { name: 'Khar Road', lat: 19.0694, lng: 72.8464 },
  { name: 'Santacruz', lat: 19.0816, lng: 72.8412 },
  { name: 'Vile Parle', lat: 19.1004, lng: 72.8455 },
  { name: 'Andheri', lat: 19.1197, lng: 72.8464 },
  { name: 'Jogeshwari', lat: 19.1348, lng: 72.8481 },
  { name: 'Ram Mandir', lat: 19.1519, lng: 72.8501 },
  { name: 'Goregaon', lat: 19.1646, lng: 72.8493 },
  { name: 'Malad', lat: 19.1861, lng: 72.8486 },
  { name: 'Kandivali', lat: 19.2058, lng: 72.8515 },
  { name: 'Borivali', lat: 19.229, lng: 72.8573 },
  { name: 'Dahisar', lat: 19.2519, lng: 72.8598 },
  { name: 'Mira Road', lat: 19.2813, lng: 72.8577 },
  { name: 'Bhayandar', lat: 19.3072, lng: 72.8515 },
  { name: 'Masjid', lat: 18.9485, lng: 72.8389 },
  { name: 'Sandhurst Road', lat: 18.9603, lng: 72.8417 },
  { name: 'Byculla', lat: 18.9769, lng: 72.8338 },
  { name: 'Chinchpokli', lat: 18.9877, lng: 72.8332 },
  { name: 'Currey Road', lat: 18.9947, lng: 72.8339 },
  { name: 'Parel', lat: 18.9983, lng: 72.8401 },
  { name: 'Dockyard Road', lat: 18.9659, lng: 72.8447 },
  { name: 'Reay Road', lat: 18.9763, lng: 72.8486 },
  { name: 'Cotton Green', lat: 18.9868, lng: 72.8429 },
  { name: 'Sewri', lat: 18.9986, lng: 72.8546 },
  { name: 'Guru Tegh Bahadur Nagar', lat: 19.0401, lng: 72.8641 },
  { name: 'Chunabhatti', lat: 19.0628, lng: 72.8781 },
  { name: 'Mulund', lat: 19.1726, lng: 72.9561 },
  { name: 'Nahur', lat: 19.1533, lng: 72.9484 },
  { name: 'Bhandup', lat: 19.1444, lng: 72.9375 },
  { name: 'Kanjurmarg', lat: 19.1302, lng: 72.9281 },
  { name: 'Vikhroli', lat: 19.1107, lng: 72.926 },
  { name: 'Ghatkopar', lat: 19.0857, lng: 72.908 },
  { name: 'Vidyavihar', lat: 19.0803, lng: 72.8964 },
  { name: 'Thane', lat: 19.186, lng: 72.9754 },
  { name: 'Airoli', lat: 19.1586, lng: 72.9986 },
  { name: 'Vashi', lat: 19.063, lng: 72.9987 },
  { name: 'Belapur', lat: 19.018, lng: 73.0399 },
  { name: 'Panvel', lat: 18.9894, lng: 73.1175 }
];

const STATION_RADIUS_METERS = 3800;
const REQUEST_DELAY_MS = 2600;
const REQUEST_TIMEOUT_MS = 120000;
const REQUEST_MAX_RETRIES = 4;
const CHECKPOINT_SAVE_EVERY = 3;
const GOOGLE_NEXT_PAGE_DELAY_MS = 2200;
const GOOGLE_MAX_PAGES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeName(name) {
  return normalizeWhitespace(name).toLowerCase();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    from: null,
    limit: null,
    reset: false
  };

  for (const arg of args) {
    if (arg === '--reset') {
      parsed.reset = true;
      continue;
    }

    if (arg.startsWith('--from=')) {
      parsed.from = arg.slice('--from='.length).trim();
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (!Number.isNaN(n) && n > 0) parsed.limit = Math.floor(n);
      continue;
    }
  }

  return parsed;
}

function parseHospitalFromElement(el) {
  const tags = el.tags || {};
  const lat = typeof el.lat === 'number' ? el.lat : (el.center && typeof el.center.lat === 'number' ? el.center.lat : null);
  const lng = typeof el.lon === 'number' ? el.lon : (el.center && typeof el.center.lon === 'number' ? el.center.lon : null);
  const rawName = tags.name || tags['name:en'] || tags.official_name || '';

  if (!rawName || lat === null || lng === null) return null;

  const addressParts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'],
    tags['addr:city'],
    tags['addr:postcode']
  ].filter(Boolean);

  const address = normalizeWhitespace(addressParts.join(', ')) || normalizeWhitespace(tags['addr:full'] || tags.address || '');
  const city = normalizeWhitespace(tags['addr:city'] || tags['is_in:city'] || 'Mumbai') || 'Mumbai';
  const operator = normalizeWhitespace(tags.operator || tags['operator:type'] || '');
  const phone = normalizeWhitespace(tags.phone || tags['contact:phone'] || '');
  const type = normalizeWhitespace(tags.amenity || tags.healthcare || 'hospital') || 'hospital';

  return {
    HospitalName: normalizeWhitespace(rawName),
    Latitude: Number(lat.toFixed(7)),
    Longitude: Number(lng.toFixed(7)),
    City: city,
    Address: address,
    Operator: operator,
    Type: type,
    Phone: phone
  };
}

function parseHospitalFromGooglePlace(place, station) {
  if (!place || !place.name || !place.geometry || !place.geometry.location) return null;

  const lat = Number(place.geometry.location.lat);
  const lng = Number(place.geometry.location.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const address = normalizeWhitespace(place.formatted_address || place.vicinity || '');
  let city = 'Mumbai';
  const lower = address.toLowerCase();
  if (lower.includes('navi mumbai')) city = 'Navi Mumbai';
  else if (lower.includes('thane')) city = 'Thane';

  return {
    HospitalName: normalizeWhitespace(place.name),
    Latitude: Number(lat.toFixed(7)),
    Longitude: Number(lng.toFixed(7)),
    City: city,
    Address: address,
    Operator: normalizeWhitespace(place.business_status || ''),
    Type: 'hospital',
    Phone: ''
  };
}

function sanitizeAndOrderRows(rows = []) {
  return rows.map((row) => ({
    HospitalName: normalizeWhitespace(row.HospitalName || ''),
    Latitude: Number(row.Latitude),
    Longitude: Number(row.Longitude),
    City: normalizeWhitespace(row.City || 'Mumbai') || 'Mumbai',
    Address: normalizeWhitespace(row.Address || ''),
    Operator: normalizeWhitespace(row.Operator || ''),
    Type: normalizeWhitespace(row.Type || 'hospital') || 'hospital',
    Phone: normalizeWhitespace(row.Phone || '')
  })).filter((row) => row.HospitalName && !Number.isNaN(row.Latitude) && !Number.isNaN(row.Longitude));
}

function dedupeHospitals(rows) {
  const byNameCoord = new Map();

  for (const row of rows) {
    const nameKey = normalizeName(row.HospitalName);
    const latKey = Math.round(Number(row.Latitude) * 10000) / 10000;
    const lngKey = Math.round(Number(row.Longitude) * 10000) / 10000;
    const key = `${nameKey}|${latKey}|${lngKey}`;

    const existing = byNameCoord.get(key);
    if (!existing) {
      byNameCoord.set(key, row);
      continue;
    }

    byNameCoord.set(key, {
      ...existing,
      Address: existing.Address || row.Address,
      Operator: existing.Operator || row.Operator,
      Phone: existing.Phone || row.Phone,
      City: existing.City || row.City,
      Type: existing.Type || row.Type
    });
  }

  return Array.from(byNameCoord.values()).sort((a, b) => {
    const cityCompare = String(a.City).localeCompare(String(b.City));
    if (cityCompare !== 0) return cityCompare;
    return String(a.HospitalName).localeCompare(String(b.HospitalName));
  });
}

function loadRowsFromXlsx(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  return sanitizeAndOrderRows(rows);
}

async function writeXlsxWithRetry(targetPath, rows, attempts = 5) {
  const tmpPath = `${targetPath}.tmp.xlsx`;
  let lastError = null;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(sanitizeAndOrderRows(rows), {
        header: ['HospitalName', 'Latitude', 'Longitude', 'City', 'Address', 'Operator', 'Type', 'Phone']
      });
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Hospitals');
      XLSX.writeFile(workbook, tmpPath, { bookType: 'xlsx' });

      try {
        fs.renameSync(tmpPath, targetPath);
      } catch (renameError) {
        if (renameError && (renameError.code === 'EPERM' || renameError.code === 'EBUSY')) {
          fs.copyFileSync(tmpPath, targetPath);
          try { fs.unlinkSync(tmpPath); } catch (_) {}
        } else {
          throw renameError;
        }
      }

      return;
    } catch (error) {
      lastError = error;
      const waitMs = 250 * i;
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
      await sleep(waitMs);
    }
  }

  throw lastError;
}

function stationQuery(station) {
  return `
[out:json][timeout:120];
(
  nwr["amenity"="hospital"](around:${STATION_RADIUS_METERS},${station.lat},${station.lng});
  nwr["healthcare"="hospital"](around:${STATION_RADIUS_METERS},${station.lat},${station.lng});
);
out center tags;
`;
}

async function queryOverpass(query) {
  let lastError = null;

  for (let attempt = 1; attempt <= REQUEST_MAX_RETRIES; attempt += 1) {
    for (const baseUrl of OVERPASS_URLS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const body = new URLSearchParams({ data: query });

        const response = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body,
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const retryAfter = Number(response.headers.get('retry-after') || 0);
          const isRateLimited = response.status === 429;
          const baseDelay = Math.min(20000, 1600 * (2 ** (attempt - 1)));
          const waitMs = Math.max(retryAfter * 1000, baseDelay + Math.floor(Math.random() * 500));

          if (isRateLimited && attempt < REQUEST_MAX_RETRIES) {
            console.warn(`Rate limited by ${baseUrl} (attempt ${attempt}/${REQUEST_MAX_RETRIES}), waiting ${waitMs}ms...`);
            await sleep(waitMs);
            continue;
          }

          throw new Error(`Overpass HTTP ${response.status} at ${baseUrl}`);
        }

        const data = await response.json();
        if (!data || !Array.isArray(data.elements)) {
          throw new Error(`Unexpected Overpass response shape from ${baseUrl}`);
        }

        return data;
      } catch (error) {
        lastError = error;
      }
    }

    if (attempt < REQUEST_MAX_RETRIES) {
      const cooldown = Math.min(24000, 2400 * (2 ** (attempt - 1)));
      console.warn(`Retry cycle ${attempt} failed, cooling down for ${cooldown}ms...`);
      await sleep(cooldown);
    }
  }

  throw lastError || new Error('All Overpass endpoints failed');
}

async function queryGoogleTextSearch(query, pageToken = '') {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Google Maps API key missing');
  }

  const params = new URLSearchParams({
    key: GOOGLE_MAPS_API_KEY,
    query,
    language: 'en',
    region: 'in'
  });

  if (pageToken) {
    params.set('pagetoken', pageToken);
  }

  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google TextSearch HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.status !== 'OK' && payload.status !== 'ZERO_RESULTS') {
    throw new Error(`Google TextSearch status ${payload.status}`);
  }

  return payload;
}

async function queryGoogleFallbackForStation(station) {
  const query = `all hospitals in ${station.name} Mumbai`;
  const rows = [];
  let pageToken = '';

  for (let page = 1; page <= GOOGLE_MAX_PAGES; page += 1) {
    if (page > 1 && !pageToken) break;
    if (page > 1) await sleep(GOOGLE_NEXT_PAGE_DELAY_MS);

    const payload = await queryGoogleTextSearch(query, pageToken);
    const current = Array.isArray(payload.results)
      ? payload.results.map((place) => parseHospitalFromGooglePlace(place, station)).filter(Boolean)
      : [];

    rows.push(...current);
    pageToken = payload.next_page_token || '';
    if (!pageToken) break;
  }

  return rows;
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadExistingDatasetRows() {
  return loadRowsFromXlsx(OUTPUT_XLSX);
}

function checkpointTemplate() {
  return {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStations: [],
    stationCounts: [],
    rawRows: []
  };
}

function loadCheckpoint(reset) {
  if (reset) return checkpointTemplate();
  const loaded = safeReadJson(CHECKPOINT_FILE, null);
  if (!loaded || typeof loaded !== 'object') return checkpointTemplate();

  return {
    createdAt: loaded.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStations: Array.isArray(loaded.completedStations) ? loaded.completedStations : [],
    stationCounts: Array.isArray(loaded.stationCounts) ? loaded.stationCounts : [],
    rawRows: Array.isArray(loaded.rawRows) ? loaded.rawRows : []
  };
}

async function writeFileWithRetry(targetPath, content, attempts = 5) {
  const tmpPath = `${targetPath}.tmp`;
  let lastError = null;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      try {
        fs.renameSync(tmpPath, targetPath);
      } catch (renameError) {
        // Some Windows setups lock the target briefly; fallback to direct write.
        if (renameError && (renameError.code === 'EPERM' || renameError.code === 'EBUSY')) {
          fs.writeFileSync(targetPath, content, 'utf8');
          if (fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
          }
        } else {
          throw renameError;
        }
      }
      return;
    } catch (error) {
      lastError = error;
      const waitMs = 200 * i;
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
      await sleep(waitMs);
    }
  }

  throw lastError;
}

async function saveCheckpoint(state) {
  const payload = {
    ...state,
    updatedAt: new Date().toISOString()
  };
  await writeFileWithRetry(CHECKPOINT_FILE, JSON.stringify(payload, null, 2));
}

function pickStations(args, completedStations) {
  let items = STATIONS;

  if (args.from) {
    const idx = STATIONS.findIndex((s) => s.name.toLowerCase() === args.from.toLowerCase());
    if (idx >= 0) items = STATIONS.slice(idx);
  }

  items = items.filter((s) => !completedStations.includes(s.name));

  if (args.limit) {
    items = items.slice(0, args.limit);
  }

  return items;
}

async function main() {
  const args = parseArgs();
  const state = loadCheckpoint(args.reset);

  if (args.reset && fs.existsSync(CHECKPOINT_FILE)) {
    try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
  }

  const seeded = loadExistingDatasetRows();
  if (!Array.isArray(state.rawRows)) {
    state.rawRows = [];
  }
  if (seeded.length) {
    state.rawRows.push(...seeded);
    state.rawRows = dedupeHospitals(state.rawRows);
    console.log(`Merged existing dataset rows into checkpoint: +${seeded.length}`);
  }

  const completedSet = new Set(state.completedStations);
  const stationsToRun = pickStations(args, state.completedStations);

  if (!stationsToRun.length) {
    console.log('No remaining stations to process. Writing outputs from current checkpoint.');
  }

  let processedInRun = 0;
  let failureCount = 0;

  for (const station of stationsToRun) {
    try {
      const data = await queryOverpass(stationQuery(station));
      const parsed = data.elements.map(parseHospitalFromElement).filter(Boolean);

      state.rawRows.push(...parsed);
      state.stationCounts = state.stationCounts.filter((s) => s.station !== station.name);
      state.stationCounts.push({ station: station.name, rawCount: parsed.length, source: 'overpass' });
      completedSet.add(station.name);
      state.completedStations = Array.from(completedSet);
      processedInRun += 1;

      console.log(`Collected ${parsed.length} from ${station.name}`);

      if (processedInRun % CHECKPOINT_SAVE_EVERY === 0) {
        await saveCheckpoint(state);
      }
    } catch (error) {
      let fallbackRows = [];
      let fallbackError = null;

      try {
        fallbackRows = await queryGoogleFallbackForStation(station);
      } catch (googleError) {
        fallbackError = googleError;
      }

      state.stationCounts = state.stationCounts.filter((s) => s.station !== station.name);

      if (fallbackRows.length > 0) {
        state.rawRows.push(...fallbackRows);
        state.stationCounts.push({
          station: station.name,
          rawCount: fallbackRows.length,
          source: 'google-text-fallback',
          note: `Overpass failed: ${error.message || String(error)}`
        });
        completedSet.add(station.name);
        state.completedStations = Array.from(completedSet);
        processedInRun += 1;
        console.log(`Fallback Google collected ${fallbackRows.length} from ${station.name}`);
      } else {
        const combinedError = fallbackError
          ? `${error.message || String(error)} | Google fallback failed: ${fallbackError.message || String(fallbackError)}`
          : (error.message || String(error));

        state.stationCounts.push({ station: station.name, rawCount: 0, error: combinedError, source: 'none' });
        failureCount += 1;
        console.warn(`Skipping ${station.name} due to error: ${combinedError}`);
      }

      await saveCheckpoint(state);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await saveCheckpoint(state);

  const deduped = dedupeHospitals(state.rawRows);
  await writeXlsxWithRetry(OUTPUT_XLSX, deduped, 10);

  const report = {
    createdAt: new Date().toISOString(),
    source: 'OpenStreetMap Overpass with Google Text Search fallback (station-wise, resumable)',
    stationRadiusMeters: STATION_RADIUS_METERS,
    requestDelayMs: REQUEST_DELAY_MS,
    googleFallbackEnabled: Boolean(GOOGLE_MAPS_API_KEY),
    completedStations: state.completedStations,
    pendingStations: STATIONS.map((s) => s.name).filter((name) => !state.completedStations.includes(name)),
    totals: {
      stationRaw: state.rawRows.length,
      deduped: deduped.length,
      completedCount: state.completedStations.length,
      totalStations: STATIONS.length
    },
    stationCounts: state.stationCounts.sort((a, b) => a.station.localeCompare(b.station))
  };

  try {
    await writeFileWithRetry(OUTPUT_REPORT, JSON.stringify(report, null, 2), 10);
  } catch (reportError) {
    console.warn(`Report write skipped due to lock: ${reportError.message || reportError}`);
  }

  console.log(`Saved ${deduped.length} hospitals (${state.completedStations.length}/${STATIONS.length} stations completed, ${failureCount} failures in this run).`);
  console.log(`- ${OUTPUT_XLSX}`);
  console.log(`- ${OUTPUT_REPORT}`);
  console.log(`- ${CHECKPOINT_FILE}`);
}

main().catch((error) => {
  console.error('Dataset build failed:', error.message || error);
  process.exit(1);
});
