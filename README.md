# Jeevan Connect

Jeevan Connect is a real-time emergency response platform for citizens, ambulance drivers, hospitals, and dispatch administrators. A citizen can create an SOS request with live GPS coordinates, medical information, emergency type, hospital preference, and a detailed patient address. The backend assigns the nearest available ambulance and streams mission updates through Socket.IO.

## Project status and completeness

This is a working academic/demo application with a complete end-to-end SOS path when MongoDB is available: citizen authentication -> SOS creation -> ambulance selection -> driver response -> hospital selection -> pickup -> completion. The REST API, MongoDB persistence, Socket.IO dispatch events, driver console, citizen tracking, hospital login/facility update path, and admin fleet views are implemented.

The following parts are intentionally demo or simulation features rather than integrations with a real emergency-control system:

- Driver locations can be seeded and normalized to named Mumbai reference locations. They are not a live GPS feed unless a driver browser sends location updates.
- The hospital dashboard contains several illustrative resource, staff, vitals, and preparedness cards. Bed values and hospital facilities are the persisted hospital data; many other dashboard figures are static presentation values.
- Google Maps, Google Places, Twilio SMS, and a custom OTP service are optional. Without them, maps/hospital discovery may fall back to local data and OTP may use the development demo code.
- Admin migration and bootstrap endpoints are operational tools, not a separate admin authentication system.

For a production release, add durable dispatch recovery/queues, role-based admin authentication, encrypted/hashed driver passwords, real hospital capacity feeds, audit logging, automated tests, and a real SMS/OTP provider. Do not treat the demo OTP, seeded credentials, estimated bed counts, or fallback hospital data as operational emergency data.

## What the project includes

- Citizen OTP authentication and medical profile management.
- Citizen SOS creation, cancellation, status tracking, and live ambulance location.
- Driver registration/login, online status, live location, dispatch acceptance, decline, pickup, and completion.
- Nearest-available-driver selection using the Haversine distance formula.
- Automatic reassignment to another available driver after the configured no-response window without acceptance (currently five minutes).
- Immediate reassignment when a driver explicitly declines.
- Emergency-type-aware hospital matching for eye, cancer, cardiac, respiratory, trauma, pediatric, and women's health cases.
- Auto hospital preference and specialty preference captured from the SOS form.
- Patient address details including building, room/flat, landmark, area, city, state, and full address.
- Hospital login, JWT-protected hospital profile access, and bed/facility updates.
- Admin fleet views, driver seeding, location-clustering utilities, and emergency migration helpers.
- Hospital discovery through Google Places, MongoDB-imported data, local XLSX data, OpenStreetMap, and a hardcoded fallback.

## Repository structure

```text
FINAL_MAJOR/
|-- README.md
|-- .gitignore
|-- frontend/
|   |-- index.html
|   |-- citizen-dashboard.html
|   |-- ambulance-driver-dashboard.html
|   |-- hospital-dashboard.html
|   `-- admin-dashboard.html
`-- backend/
    |-- server.js
    |-- package.json
    |-- package-lock.json
    |-- .env.example
    |-- mumbai-hospitals-all.xlsx
    `-- scripts/
        |-- build-mumbai-hospitals-stationwise.js
        `-- import-hospitals-to-mongodb.js
```

`backend/server.js` contains the Express API, MongoDB/Mongoose models, JWT authentication, hospital matching, dispatch state, and Socket.IO event handlers. The frontend is a set of static HTML/CSS/vanilla-JavaScript dashboards that use the backend REST API and Socket.IO server.

## Technology stack

- **Frontend:** HTML5, CSS3, vanilla JavaScript, Socket.IO client, Google Maps JavaScript API.
- **Backend:** Node.js, Express, Socket.IO, Mongoose, MongoDB.
- **Authentication/security:** JWT, bcryptjs, Helmet, CORS, express-rate-limit.
- **External services:** optional Twilio Verify/SMS, optional custom OTP service, optional Google Maps/Places.
- **Data tooling:** XLSX for the Mumbai hospital dataset and MongoDB import.

## System flow

1. The citizen opens the citizen dashboard, authenticates by OTP, and allows browser location access.
2. The citizen selects an emergency type, enters medical/address details, and chooses auto hospital assignment or a specialty preference.
3. The frontend emits `citizen-sos-request` over Socket.IO. The backend creates or updates an `Emergency` document and stores the request in the in-memory `activeDispatches` map.
4. After a short dispatch delay, available ambulance candidates are collected from online socket drivers and database drivers.
5. Candidates are filtered, ranked by Haversine distance, and sent a `dispatch-call` event.
6. The driver accepts, declines, or does not respond. A decline triggers immediate reassignment. A non-response timer runs for 120 seconds and then tries another candidate.
7. After the patient is picked up, the backend selects a hospital using the requested specialty plus distance, then emits `hospital-assigned`.
8. The driver completes the emergency. The backend persists the completed lifecycle and emits `emergency-completed`.

## Detailed implementation mechanics

### Emergency state machine

An emergency normally moves through `pending -> assigned -> enroute -> arrived -> completed`. A citizen or authorized flow can move a non-completed emergency to `cancelled`. If no driver is available, the dispatch remains pending and the server searches again. Assignment history records assigned, accepted, declined, timeout, and cancellation events, while driver and hospital snapshots preserve historical display data after related records change.

### Presence and dispatch data

Socket connections register as citizens or drivers. `onlineDrivers` tracks live socket presence and location in memory; MongoDB `Driver` records provide the durable fleet list and fallback candidates. Candidate identifiers are normalized across MongoDB IDs, driver IDs, login IDs, ambulance IDs, phone numbers, and names to avoid assigning the same driver twice. A driver is marked busy by the live dispatch flow and becomes available again after cancellation or completion.

### Driver location safeguards

Incoming coordinates are converted to numbers, matched to the nearest Mumbai reference locality, and suspicious water/outlier positions are snapped to a nearby land reference. This keeps seeded/demo markers visible on the city map. The returned location also includes a human-readable locality, city/state, simulated flag, and update timestamp.

### Hospital selection mechanics

The backend first queries Google nearby hospitals when configured, then local/imported Mumbai records, and finally the built-in fallback list. It normalizes the patient point, filters by an explicitly requested specialty when possible, calculates Haversine distance, and sorts by nearest distance. Hospitals within 0.15 km are resolved using specialty/capability score, trauma/cardiology/neuro signals, and ICU availability. The chosen result is upserted into MongoDB and stored as both a reference and a snapshot on the emergency.

### Timing and recovery behavior

Initial dispatch is delayed briefly to allow drivers to connect. The configured no-response reassignment timer is `300000` ms (five minutes); the persisted assignment history/message text should be treated as the source of operational truth until that wording is aligned. Active dispatches, socket presence, OTPs, and timers are process-memory state, so a server restart requires dispatch recovery work before production use. The admin dashboard caches recent assignments in browser storage when its live feed is temporarily unavailable.

### Frontend responsibilities

- `index.html` handles citizen/driver entry, OTP flow, registration, seeded driver demo login, and redirects to role dashboards.
- `citizen-dashboard.html` manages GPS permission, medical profile, emergency contacts, SOS form, first-aid content, hospital search/preferences, cancellation, and live ambulance tracking. Tracking is shown after driver acceptance/en-route state.
- `ambulance-driver-dashboard.html` handles driver login, availability, location updates, dispatch confirmation, decline, navigation display, pickup, and emergency completion. Google Directions is used for route rendering when configured.
- `hospital-dashboard.html` authenticates a hospital with JWT and persists ICU/general/low/total bed updates. Its alert, resource, staff, and preparedness widgets include static/demo presentation values.
- `admin-dashboard.html` loads MongoDB drivers, hospitals, assignment history, active SOS data, analytics, and an optional Google fleet map. It has a local visual fallback when Google Maps credentials are unavailable.

### Data processing and deduplication

The hospital builder queries station-centered Overpass/OpenStreetMap and optional Google Places data with retries, delays, pagination, checkpoint/resume support, coordinate/name deduplication, and XLSX output. The importer validates names and coordinates, removes duplicate rows, classifies ownership, estimates baseline facilities, and bulk-upserts hospitals by coordinates.

## Dispatch algorithms

### Driver availability

Driver candidates are assembled from the live `onlineDrivers` map and persisted `Driver` documents. A candidate must have a usable location and an available operational state. Previously declined or assigned driver identifiers are excluded using normalized driver keys.

### Haversine nearest-driver ranking

The backend calculates straight-line distance between the patient's coordinates and each driver's coordinates:

```text
a = sin²((lat2 - lat1) / 2)
  + cos(lat1) × cos(lat2) × sin²((lng2 - lng1) / 2)
c = 2 × atan2(√a, √(1 - a))
distanceKm = 6371 × c
```

The nearest candidate is selected and the dispatch stores an `assignmentBasis` object containing the method, selected distance, selected driver, and the top ranked candidates. This is deterministic and fast, but it is not road travel time. The driver dashboard uses Google route rendering separately for navigation.

### Driver reassignment

- Initial dispatch is sent after a short connection/dispatch delay.
- `scheduleDriverReassignment()` starts a 300,000 millisecond timer for an assigned driver.
- The timer stops when the driver accepts or when the dispatch reaches a terminal/mission state.
- If it expires while the dispatch is still assigned/pending, the current driver is added to the exclusion set and another nearest available driver is selected. The timeout history currently uses the explanatory text “within 2 minutes,” which should be aligned with the configured five-minute value before production deployment.
- A driver decline performs the same candidate exclusion and reassignment immediately.
- Dispatch state and reassignment timers are in process memory. Restarting the Node process clears active dispatches and timers.

### Hospital matching

`selectBestHospitalForEmergency()` first obtains nearby hospitals, then applies specialty hints from the emergency type or the requested specialty. Supported specialty hints include:

| Preference | Example matching terms |
|---|---|
| `eye` | eye, vision, ophthalmology, retina, cornea |
| `cancer` | cancer, oncology, tumor, radiology |
| `heart` | heart, cardiac, cardiology, stroke |
| `lung` | lung, respiratory, pulmonary, asthma |
| `trauma` | trauma, injury, fracture, orthopedic, accident |
| `child` | pediatric, paediatric, child, newborn |
| `women` | women, maternity, gynecology, obstetric |

Matching hospitals are distance-ranked. If no specialty match is available, the nearest hospital is used as a fallback. The current citizen UI stores `hospitalPreference.mode` as `auto` or `manual` and stores a specialty value; it does not yet submit a specific hospital ID for manual selection. Therefore, “Select hospital” currently means selecting a preferred specialty/matching mode, while the backend still chooses the best matching hospital.

## MongoDB models

All four models are defined in `backend/server.js`.

### User

Collection: `users`

- Identity: `phone` (required and unique), `name`, `email`.
- Medical profile: `bloodGroup`, `medicalProfile.organDonor`, `allergies`, `conditions`, `medications`, `emergencyNote`.
- Account: `role` (`citizen` or `driver`), `isVerified`, `lastLoginAt`, `createdAt`.

### Driver

Collection: `drivers`

- Identity/login: `driverId`, `loginId`, `password`, `phone`, `name`, `licenseNumber`.
- Vehicle: `vehicleType`, `ambulanceId`.
- Availability: `status` (`available`, `busy`, `offline`), `isOnline`, `lastLoginAt`.
- Location: `lat`, `lng`, `address`, `city`, `state`, `simulated`, `lastUpdated`.

### Emergency

Collection: `emergencies`

- Citizen/requester: `citizenName`, `citizenPhone`, `citizenId`, `requestChannel`, `initiatedBy`.
- Incident: `emergencyType`, `description`, `priority`, `location`.
- Patient address: `addressDetails.building`, `roomNo`, `landmark`, `area`, `city`, `state`, `fullAddress`.
- Hospital request: `hospitalPreference.mode` (`auto` or `manual`) and `hospitalPreference.specialty`.
- Lifecycle: `status` (`pending`, `assigned`, `enroute`, `arrived`, `completed`, `cancelled`).
- Assignment: `assignedDriver`, `assignedDriverSnapshot`, `assignedHospital`.
- Timeline: `ambulancePickedAt`, `hospitalAssignedAt`, `completedAt`, `cancelledAt`, `cancelledBy`.
- Medical snapshot: blood group, organ donor status, allergies, conditions, medications, emergency note.

### Hospital

Collection: `hospitals`

- Identity/login: `name`, `hospitalNo`, `loginId`, `passwordHash`, `lastLoginAt`.
- Classification: `source`, `type` (`Government`, `Private`, `Trust`), `specialties`.
- Location: latitude, longitude, address, city, state.
- Discovery metadata: `distance`, `driveTime`, `operatingHours`, `phoneNumber`, `rating`.
- Facilities: `icuBeds`, `generalBeds`, `lowBeds`, `totalBeds`.
- Services: OPD state, laboratory, blood bank, parking, trauma, cardiology.

Relationships are represented by `Emergency.citizenId -> User`, `Emergency.assignedDriver -> Driver`, and `Emergency.assignedHospital -> Hospital`. The emergency also stores an assignment snapshot so historical dispatch details remain available even if a driver's profile changes.

## Hospital discovery sources

Nearby results are merged from multiple sources rather than stopping at the first non-empty provider:

1. MongoDB hospitals imported with `source: 'xlsx-import'`.
2. The bundled local Mumbai hospital dataset.
3. Google Places, when `GOOGLE_MAPS_API_KEY` or `GOOGLE_PLACES_API_KEY` is configured.
4. OpenStreetMap/Overpass results where that route is used.
5. A small hardcoded emergency fallback list when all other sources are empty.

Duplicate names are collapsed and the combined result is sorted by calculated distance. Ownership uses explicit source/operator metadata where available. If Google or OpenStreetMap does not provide ownership evidence, the UI shows `Unknown` instead of incorrectly labeling the hospital as Private. Imported/local records can enrich a live result when they contain a verified ownership label.

The application can run without Google credentials, but map rendering and Google Places results will be unavailable or fall back to local data.

## REST API

### Health/configuration

- `GET /` - backend service information.
- `GET /health` - health response and uptime.
- `GET /api/config` - public runtime Google Maps key configuration.

### Citizen authentication/profile

- `POST /api/auth/send-otp`
- `POST /api/auth/verify-otp`
- `POST /api/auth/check-phone`
- `POST /api/auth/register`
- `GET /api/auth/me`
- `GET /api/auth/profile`
- `PUT /api/auth/profile`

### Driver

- `POST /api/driver/register`
- `POST /api/driver/login`
- `GET /api/drivers`

### Emergency

- `POST /api/emergency`
- `POST /api/emergency/:id/cancel`
- `GET /api/emergency/:id/dispatch-status`

### Hospitals

- `GET /api/hospitals/all`
- `GET /api/hospitals/nearby`
- `GET /api/hospitals/search`
- `GET /api/hospitals/:id`
- `GET /api/hospitals/map/:id`

### Hospital accounts

- `POST /api/hospital/bootstrap-logins`
- `POST /api/hospital/migrate-login-ids`
- `GET /api/hospital/credentials`
- `POST /api/hospital/login`
- `GET /api/hospital/me` (hospital JWT required)
- `PUT /api/hospital/me/facilities` (hospital JWT required)

### Admin and migration operations

Some operations require the `x-admin-key` header or `adminKey` request field when `ADMIN_MIGRATION_KEY` is configured.

- `POST /api/admin/seed/mumbai-drivers`
- `GET /api/admin/ambulance-assignments`
- `POST /api/admin/migrations/force-drivers-available-with-location`
- `POST /api/admin/migrations/cluster-drivers-nearby`
- `POST /api/admin/migrations/randomize-drivers-mumbai`
- `POST /api/admin/migrations/smart-cluster-drivers-mumbai`
- `POST /api/admin/migrations/backfill-emergency-assigned-driver`
- `POST /api/admin/migrations/emergency-citizen-identity`

## Socket.IO events

### Registration and presence

`citizen-register`, `driver-register`, `driver-online`, `driver-status-update`, `dispatch-driver-count`

### Location

`location-update`, `driver-location-update`

### SOS/dispatch

`citizen-sos-request`, `sos-pending`, `dispatch-call`, `sos-assigned`, `sos-no-driver`, `new-emergency`

### Driver decisions and mission stages

`driver-accept-dispatch`, `driver-decline-dispatch`, `driver-accepted`, `driver-patient-picked`, `hospital-assigned`, `driver-emergency-completed`, `emergency-completed`

### Cancellation/failure

`citizen-cancel-sos`, `sos-cancelled`, `sos-cancel-failed`, `hospital-selection-failed`, `dispatch-accept-ignored`

## Environment variables

Copy `backend/.env.example` to `backend/.env` and adjust the values:

```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/jeevanconnect
JWT_SECRET=replace_with_a_long_random_secret
GOOGLE_MAPS_API_KEY=replace_with_google_maps_key

# Optional Twilio Verify/SMS configuration
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1234567890
TWILIO_VERIFY_SERVICE_SID=...

# Optional custom verification service
VERIFY_SERVICE_URL=https://your-verify-service.com/api/send-otp
VERIFY_SERVICE_API_KEY=...
VERIFY_SERVICE_AUTH_HEADER=Authorization

# Optional admin protection and rate-limit tuning
ADMIN_MIGRATION_KEY=replace_with_admin_key
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=1200
```

If Twilio/custom verification is not configured, the backend uses its local demo OTP behavior and logs the OTP in the backend console. Do not use that fallback for production. Keep `backend/.env` private and never commit it.

## How to run on Windows

### Prerequisites

- Node.js 18 or newer recommended.
- MongoDB running locally, or a reachable MongoDB Atlas connection string.
- Optional: Google Maps/Places key for maps and Google hospital discovery.
- Optional: Twilio or a custom OTP provider for real SMS verification.

### 1. Install backend dependencies

Open PowerShell in the repository root:

```powershell
cd backend
npm install
```

Create `backend/.env` from `backend/.env.example`, then make sure MongoDB is running. With a local MongoDB service, the default database is `jeevanconnect`.

### 2. Start the backend

From the `backend` directory:

```powershell
npm start
```

The backend listens on `http://localhost:5000` by default. Verify it with:

```powershell
Invoke-WebRequest http://localhost:5000/health
```

For development auto-restart:

```powershell
npm run dev
```

Run `npm start` from `backend`, not from the repository root. If it exits with code 1, inspect the console message first; common causes are an already-used port, missing backend dependencies, malformed `.env`, or MongoDB being unavailable.

### 3. Open the frontend

Open the HTML pages directly from the `frontend` folder, or use the VS Code Live Server extension:

- `frontend/index.html`
- `frontend/citizen-dashboard.html`
- `frontend/ambulance-driver-dashboard.html`
- `frontend/hospital-dashboard.html`
- `frontend/admin-dashboard.html`

The frontend connects to the backend at `http://localhost:5000`.

### 4. Optional hospital dataset import

From `backend`:

```powershell
npm run build:hospitals:mumbai
npm run import:hospitals:mongodb
```

The build script queries station-area sources and writes `mumbai-hospitals-all.xlsx`. It supports checkpoint/resume flags such as `--reset`, `--from=<station>`, and `--limit=<number>`. The import script reads the XLSX file, removes invalid/duplicate rows, classifies hospitals, estimates initial facilities, and upserts records with `source: 'xlsx-import'`.

After importing, bootstrap hospital credentials through the protected admin endpoint. The default generated login format is `hosp0001`, `hosp0002`, and so on. The default bootstrap password is `Hosp@123` unless another password is supplied. Change it before any real deployment.

## Verification commands

From the repository root:

```powershell
node --check backend/server.js
```

With the backend running:

```powershell
Invoke-WebRequest http://localhost:5000/health
Invoke-WebRequest http://localhost:5000/api/config
```

For a functional test, open the citizen and driver dashboards in separate browser windows, register/login a driver, allow location access, create a citizen SOS, and verify `dispatch-call`, driver acceptance, hospital assignment, live location, and completion events.

## Operational limitations

- Active dispatches, online drivers, and the two-minute reassignment timers are held in Node process memory. A process restart loses active dispatch state; MongoDB retains persisted emergency records.
- Haversine distance is not driving distance or traffic-aware ETA.
- The current UI does not send a specific hospital ID for manual selection; it sends mode and specialty preference.
- Google Maps/Places features require a valid, appropriately restricted API key. Local hospital fallback and non-map dispatch logic can work without it.
- The bundled hospital import assigns baseline facility estimates; bed counts should be verified and updated by hospital operators.
- Demo OTP fallback and seeded/default credentials are development conveniences and must be replaced or protected in production.

## Security notes

- Use a strong `JWT_SECRET`, `ADMIN_MIGRATION_KEY`, and MongoDB credentials.
- Restrict Google API keys by application and API.
- Do not expose hospital credential lists or admin migration endpoints publicly without access controls.
- Do not commit `.env`, OTP logs, generated checkpoints, or production credentials.
