# Jeevan Connect

Jeevan Connect is a browser-based emergency-response demonstration for citizens, ambulance drivers, hospitals, and dispatch administrators. It combines a static HTML/JavaScript frontend, an Express and Socket.IO backend, and MongoDB persistence to demonstrate citizen authentication, ambulance assignment, emergency tracking, and hospital discovery.

> **Important:** This project is an academic/demo application, not an emergency-dispatch service. It is not connected to verified ambulance operators or live hospital capacity systems. For a real emergency, contact local emergency services directly. Do not rely on this application for emergency response or medical decisions.

## Contents

- [Project structure](#project-structure)
- [Technology and architecture](#technology-and-architecture)
- [User journeys](#user-journeys)
- [Data model](#data-model)
- [Algorithms and methodology](#algorithms-and-methodology)
- [Hospital data and discovery](#hospital-data-and-discovery)
- [REST API](#rest-api)
- [Socket.IO events](#socketio-events)
- [Configuration](#configuration)
- [Run locally](#run-locally)
- [Deploy](#deploy)
- [Hospital dataset tools](#hospital-dataset-tools)
- [Verification and troubleshooting](#verification-and-troubleshooting)
- [Limitations and security](#limitations-and-security)

## Project structure

```text
FINAL_MAJOR/
|-- README.md
|-- .gitignore
|-- frontend/
|   |-- index.html
|   |-- citizen-dashboard.html
|   |-- ambulance-driver-dashboard.html
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

The frontend consists of four standalone HTML pages with inline CSS and JavaScript; it has no bundler or frontend package manifest. `backend/server.js` contains the Express routes, Mongoose schemas, Socket.IO handlers, dispatch logic, and hospital lookup logic. The two backend scripts collect and import hospital data. The XLSX is a bundled dataset. There is no repository-level `package.json`, Netlify configuration file, or Render manifest.

## Technology and architecture

- **Frontend:** HTML, CSS, browser JavaScript, Fetch API, Socket.IO client, browser geolocation and local storage.
- **Backend:** Node.js, Express, Socket.IO, Mongoose.
- **Database:** MongoDB (local MongoDB or a hosted MongoDB-compatible service).
- **Other backend packages:** `bcryptjs`, `cors`, `dotenv`, `express-rate-limit`, `helmet`, `jsonwebtoken`, `twilio`, and `xlsx`.
- **Optional integrations:** Twilio Verify/SMS, custom OTP service, Google Maps/Places, OpenStreetMap/Overpass, and Nominatim.
- **Typical hosting arrangement:** frontend static site on Netlify; API and Socket.IO server on Render; MongoDB hosted separately.

The Express server does not serve the static frontend. The browser calls the configured API URL directly. On a local page (`file:`, `localhost`, or `127.0.0.1`), dashboards default to `http://localhost:5000`. On hosted pages, they default to `https://jeevanconnect-real-time-emergency.onrender.com`. `window.__API_BASE_URL__` and, on most pages, the browser's `apiBaseUrl` local-storage value can override the default. If a dashboard is unexpectedly calling the wrong backend, clear the stale `apiBaseUrl` entry in that site's browser storage and reload.

## User journeys

### Citizen

1. Register or log in with a phone number; citizen authentication uses a six-digit OTP.
2. Complete or update a medical profile with blood group, allergies, conditions, medications, organ-donor preference, and an emergency note.
3. Allow location access and create an SOS with emergency type, patient location/address, medical snapshot, and hospital preference.
4. Follow assignment and driver location updates, and cancel an eligible request.
5. Use the hospital finder, first-aid guide, and locally stored emergency contacts.

### Ambulance driver

1. Register or log in with driver credentials.
2. Set availability and share location through the browser.
3. Receive a dispatch, accept or decline it, and report patient pickup and emergency completion.
4. View patient/hospital details and map/navigation helpers in the driver dashboard.

### Hospital data

Hospital matching, discovery, and stored facility data remain part of the backend and citizen experience. The standalone hospital staff dashboard has been removed; there is no hospital-facing frontend for login or facility updates.

### Administrator

The admin dashboard presents hospital and fleet maps, driver lists, SOS/assignment information, and daily analytics. Daily SOS totals and the Active SOS Tracker use records created on the current India Standard Time day; older unresolved records appear separately and are not treated as today's activity. Response-time metrics use recorded SOS-to-pickup durations and remain blank when there are no pickup records. No SOS records for the day are shown as zero, not sample activity. Fleet map markers use saved driver coordinates; simulated or seeded locations are visibly marked as demo locations and are not live GPS. Map fallback does not plot guessed marker locations. The backend also exposes driver seeding and database migration utilities, so database records and locations may still be demo data. This is not a separate, fully authenticated admin application; protect the service and its operational endpoints before any non-demo use.

## Data model

The following Mongoose schemas are defined in `backend/server.js`.

### `User` (`users`)

Phone identity, name/email, `citizen` or `driver` role, verification and login timestamps, blood group, and a medical profile (organ-donor preference, allergies, conditions, medications, emergency note).

### `Driver` (`drivers`)

Driver/login IDs, phone, name, license number, vehicle type, ambulance ID, password, online and availability state, last login, and location metadata (coordinates, address, city/state, whether simulated, update timestamp).

### `Emergency` (`emergencies`)

Requester identity and channel; incident type, description, priority, coordinates and address; hospital preference; lifecycle status; assigned driver and hospital references plus display snapshots; assignment history; medical snapshot; and stage timestamps (pickup, hospital assignment, completion, cancellation).

Normal statuses are `pending`, `assigned`, `enroute`, `arrived`, `completed`, and `cancelled`. The emergency stores snapshots of driver/hospital display details so that a record remains readable if a related profile later changes.

### `Hospital` (`hospitals`)

Name, hospital/login number, login ID and password hash, source, ownership classification, specialties, coordinates/address, facilities, services, hours, phone, and rating.

Relationships use MongoDB ObjectId references for the citizen, assigned driver, and assigned hospital where available. Live presence and dispatch state are not MongoDB models; they are held in process memory.

## Algorithms and methodology

### SOS creation and dispatch

The citizen dashboard normally creates an emergency through `POST /api/emergency`, which saves the emergency and attempts an initial assignment. The dashboard also uses Socket.IO to attach the request to the citizen connection for live progress. A socket-only SOS path is also implemented. The REST creation path can attempt dispatch immediately; the socket-only path includes a short delay to allow drivers to connect.

### Ambulance candidate selection

1. Candidate collection queries available driver records in MongoDB and requires usable coordinates.
2. Driver identifiers (MongoDB ID, driver ID, login ID, ambulance ID, phone/name where applicable) are normalized to avoid duplicate identities and exclude already assigned or declined candidates.
3. A matching live socket is associated with a database driver when one is connected. Database availability/location is the candidate source; a live socket provides real-time communication and presence, not a separate durable fleet.
4. Candidates are ranked by straight-line Haversine distance from the incident. Ties are ordered by normalized driver name.
5. The selected driver, assignment basis, distance, and a short ranked-candidate list are stored/emitted where supported.

Haversine distance uses an Earth radius of approximately 6,371 km. It measures geographic distance, not road distance, travel time, traffic, or ambulance suitability.

### Reassignment

An explicit driver decline triggers a new selection excluding that driver. A no-response timer is set to **300,000 ms (five minutes)** in the current code, after which the assigned driver is excluded and another candidate is sought. If no candidate is available, the dispatch remains pending and is retried. Some persisted history/message text still says “2 minutes”; it is stale and does not match the five-minute timer.

The in-memory `onlineDrivers`, `activeDispatches`, and timer maps are process-local. They are lost on a backend restart; persisted emergency records remain in MongoDB, but there is no durable queue or complete live-dispatch recovery mechanism.

### Driver mission status updates

The driver dashboard sends accept, pickup, and completion actions to `POST /api/driver/emergencies/:id/action` using the driver's JWT. The backend verifies the authenticated driver owns the assignment and writes each lifecycle change to MongoDB before confirming it to the dashboard. This makes those actions survive a Render process restart even though Socket.IO dispatch state itself remains process-local. Socket.IO is still used for immediate citizen notifications when the corresponding live dispatch is present; persisted status remains the source of truth for dashboard polling.

### Driver coordinates

Incoming driver coordinates are converted and compared with named Mumbai reference points to infer a locality. Suspected outliers or coordinates considered far from the reference set can be snapped to a reference land point. This is a demo safeguard to keep markers in the target region; it is not a GPS validation or safety system. Seeded/sample coordinates are simulated, not live.

### Hospital matching for an emergency

Emergency hospital selection is distinct from the hospital-discovery API:

1. It looks for nearby Google Places results when a Google Places key is available.
2. It falls back to the bundled local Mumbai hospital dataset and then a small built-in fallback list.
3. It filters by the requested specialty when a match exists; if none match, it can fall back to the broader candidates.
4. It ranks by Haversine distance. Candidates within about 0.15 km may be ordered using specialty/capability signals such as trauma, cardiology, neuro, and ICU information.
5. The chosen hospital is associated with the emergency and a snapshot is stored.

Emergency-type keyword groups include eye/vision, cancer/oncology, cardiac/heart/brain, respiratory/lung, trauma/injury, child/pediatric, and women's health. A specialty explicitly chosen in the UI can take precedence over inferred emergency-type hints. The UI may send a selected hospital object as a preference, but it does not send a stable hospital ID for a fully enforced manual selection.

### Nearby and all-hospital APIs

These are separate flows from emergency matching:

- `/api/hospitals/nearby` uses a first-nonempty fallback sequence: Google Places (when configured), bundled local dataset, OpenStreetMap/Nominatim, then built-in emergency fallback data. It does **not** combine every provider result into one authoritative, deduplicated inventory.
- `/api/hospitals/all` prefers MongoDB-imported data, then the local XLSX data, then built-in fallback entries.
- Ownership and specialties may be inferred from provider metadata or name keywords. Missing data can be filled with demo defaults.
- Nearby/route time figures are estimates derived from distance, not live traffic or verified drive-time calculations.

### Hospital dataset builder/importer

The builder queries OpenStreetMap Overpass around a predefined list of Mumbai-area stations (3.8 km radius). It retries/falls back between Overpass endpoints and can use Google Text Search when an Overpass station query fails and a Google key is configured. It normalizes and deduplicates by hospital name and rounded coordinates, checkpoints progress, and writes an XLSX plus a JSON report.

The importer reads the first XLSX sheet, removes invalid/duplicate rows, infers ownership using name keywords, assigns baseline facilities and default specialties/services, and bulk-upserts MongoDB hospital records with `source: 'xlsx-import'`. Ownership classifications and bed counts are estimates, not authoritative data.

## REST API

Routes are implemented in `backend/server.js`. Unless noted, requests/responses use JSON.

### Health and configuration

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Basic backend/service information |
| `GET` | `/health` | Process health and uptime; this does not prove MongoDB or SMS-provider health |
| `GET` | `/api/config` | Public frontend configuration, including the Google Maps key when configured |

### Citizen identity and profile

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/check-phone` | Check phone registration for login/registration flow |
| `POST` | `/api/auth/send-otp` | Request OTP through configured provider or demo fallback |
| `POST` | `/api/auth/verify-otp` | Verify OTP and issue a JWT |
| `POST` | `/api/auth/register` | Create/register a citizen profile |
| `GET` | `/api/auth/me` | Resolve the token's user |
| `GET` | `/api/auth/profile` | Read citizen profile (Bearer token) |
| `PUT` | `/api/auth/profile` | Update citizen medical/profile data (Bearer token) |

### Driver and emergency

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/driver/register` | Register a driver |
| `POST` | `/api/driver/login` | Driver login |
| `POST` | `/api/driver/emergencies/:id/action` | Authenticated driver accepts, records pickup/hospital assignment, or completes an assigned emergency |
| `GET` | `/api/drivers` | List driver records for dashboards |
| `POST` | `/api/emergency` | Persist an emergency and attempt initial dispatch |
| `POST` | `/api/emergency/:id/cancel` | Cancel an eligible emergency |
| `GET` | `/api/emergency/:id/dispatch-status` | Read persisted and available live assignment status |

### Hospitals

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/hospitals/all` | Get hospital list |
| `GET` | `/api/hospitals/nearby?lat=...&lng=...&radius=...` | Find nearby hospitals |
| `GET` | `/api/hospitals/search?...` | Search hospital data |
| `GET` | `/api/hospitals/:id` | Get a hospital record |
| `GET` | `/api/hospitals/map/:id` | Get map/navigation information for a hospital |

### Hospital accounts and administration

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/hospital/bootstrap-logins` | Provision hospital login IDs |
| `POST` | `/api/hospital/migrate-login-ids` | Migrate hospital login IDs |
| `GET` | `/api/hospital/credentials` | Return hospital credential/login information |
| `POST` | `/api/hospital/login` | Hospital login |
| `GET` | `/api/hospital/me` | Read authenticated hospital profile (hospital JWT) |
| `PUT` | `/api/hospital/me/facilities` | Update authenticated hospital facilities (hospital JWT) |
| `POST` | `/api/admin/seed/mumbai-drivers` | Seed sample Mumbai drivers |
| `GET` | `/api/admin/ambulance-assignments` | List assignment/dashboard data |
| `GET` | `/api/admin/analytics/today` | Today's SOS counts and recorded pickup-time metrics (Asia/Kolkata) |
| `POST` | `/api/admin/migrations/force-drivers-available-with-location` | Migration/repair utility |
| `POST` | `/api/admin/migrations/cluster-drivers-nearby` | Migration/demo driver clustering |
| `POST` | `/api/admin/migrations/randomize-drivers-mumbai` | Migration/demo location utility |
| `POST` | `/api/admin/migrations/smart-cluster-drivers-mumbai` | Migration/demo clustering utility |
| `POST` | `/api/admin/migrations/backfill-emergency-assigned-driver` | Backfill assignment references |
| `POST` | `/api/admin/migrations/emergency-citizen-identity` | Repair/backfill emergency requester identity |

The admin routes use the optional `ADMIN_MIGRATION_KEY` check; when that variable is unset, the code allows requests without a key. Several operational/account routes are therefore unsafe on a public deployment unless guarded externally and the application is hardened.

## Socket.IO events

Socket.IO carries live presence, dispatch, mission, and location updates. Event handlers are in `backend/server.js`; client emit/listen behavior is in the dashboards.

| Area | Events |
|---|---|
| Presence | `citizen-register`, `driver-register`, `driver-online`, `driver-status-update`, `dispatch-driver-count` |
| Location | `location-update`, `driver-location-update` |
| SOS/dispatch | `citizen-sos-request`, `new-emergency`, `sos-pending`, `dispatch-call`, `sos-assigned`, `sos-no-driver` |
| Driver actions/stages | `driver-accept-dispatch`, `driver-decline-dispatch`, `driver-accepted`, `driver-patient-picked`, `hospital-assigned`, `driver-emergency-completed`, `emergency-completed` |
| Cancellation/failure | `citizen-cancel-sos`, `sos-cancelled`, `sos-cancel-failed`, `sos-save-failed`, `hospital-selection-failed`, `dispatch-accept-ignored` |
| Legacy/operational | `assign-emergency`, `emergency-assigned`, `emergency-contact-alert-status` |

## Configuration

Copy `backend/.env.example` to `backend/.env` for local development. Never commit or share `.env` files or their values. Set production values in the backend host's secret/environment-variable settings, not only in the local file.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP/Socket.IO listen port; defaults to `5000` |
| `MONGODB_URI` | MongoDB connection; defaults to local `mongodb://localhost:27017/jeevanconnect` |
| `JWT_SECRET` | JWT signing key; the code has an insecure development fallback if unset |
| `FRONTEND_URL` | Additional allowed Socket.IO frontend origin; use the exact deployed origin |
| `GOOGLE_MAPS_API_KEY` | Google Maps configuration and fallback key for Places |
| `GOOGLE_PLACES_API_KEY` | Optional dedicated Places API key; takes precedence for backend Places lookup |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_VERIFY_SERVICE_SID` | Twilio Verify service used for OTP |
| `TWILIO_PHONE_NUMBER` | Sender number for direct Twilio SMS fallback/other SMS alerts |
| `VERIFY_SERVICE_URL` | Optional custom OTP delivery endpoint |
| `VERIFY_SERVICE_API_KEY` | Optional key sent to the custom verification service |
| `VERIFY_SERVICE_AUTH_HEADER` | Custom-service auth header name; defaults to `Authorization` |
| `DEMO_OTP_ENABLED` | Allows demo OTP fallback when real delivery is unavailable; code defaults to `true` |
| `ADMIN_MIGRATION_KEY` | Optional key expected by migration/admin routes; unset means no key check |
| `RATE_LIMIT_WINDOW_MS` | Express rate-limit window; default 15 minutes |
| `RATE_LIMIT_MAX` | Request limit per window; default 1200 |

Twilio Verify is called directly when its service SID is configured; there is no application-managed recipient allowlist. Twilio's account, Verify service, destination formatting, regulatory policy, and trial-account restrictions still determine whether a message can be delivered. A `success` response with a demo code means no SMS was sent. Do not enable demo OTP in production.

Express REST CORS is currently permissive. Socket.IO uses an origin allowlist that includes local development origins and `https://jeevanconnect1.netlify.app`, with `FRONTEND_URL` available for another deployment domain.

## Run locally

### Prerequisites

- Node.js 18 or newer.
- MongoDB running locally or an accessible hosted MongoDB database.
- Optional: Twilio/custom OTP provider and Google Maps/Places key.

### Install and configure the backend (PowerShell)

```powershell
cd backend
npm ci
Copy-Item .env.example .env
```

Edit `backend/.env` with local values. At minimum, set `MONGODB_URI` to a reachable database and use a private `JWT_SECRET`. Keep `.env` untracked.

### Start the API and Socket.IO server

From `backend`:

```powershell
npm start
```

Development auto-reload:

```powershell
npm run dev
```

The server listens on `http://localhost:5000` unless `PORT` is set. Check it from another PowerShell window:

```powershell
Invoke-WebRequest http://localhost:5000/health
Invoke-WebRequest http://localhost:5000/api/config
```

### Serve the frontend

Open `frontend/index.html` directly or serve the `frontend` directory with a static development server such as VS Code Live Server. Local pages choose `http://localhost:5000` as the backend default. Use HTTPS or localhost for browser geolocation; the browser may restrict location permissions on non-secure origins.

## Deploy

This repository has no deployment manifests. Configure the hosts through their dashboards or add host-specific manifests separately.

### Render backend

1. Create a Node web service from the repository.
2. Set the **Root Directory** to `backend`.
3. Use `npm ci` as the build command and `npm start` as the start command.
4. Add production environment variables for MongoDB, a strong `JWT_SECRET`, and whichever OTP/maps integrations are required. Set `FRONTEND_URL` to the exact Netlify origin if it differs from the origin already allowed by the backend.
5. Deploy and verify `https://<your-render-service>/health`. A successful health response confirms the process is serving HTTP; it does not confirm that MongoDB or Twilio is configured correctly.

### Netlify frontend

1. Create a static site using the repository.
2. Publish the `frontend` directory. No frontend build command is required.
3. Deploy and verify that the login page loads.
4. Confirm the deployed page uses the expected backend URL. Clear a stale `apiBaseUrl` browser-storage override if it points to another host.

### After deployment

Test the REST API, OTP delivery, and Socket.IO connection separately. Check Render logs for MongoDB connection and Twilio Verify errors. Confirm `GET /health`, an authenticated flow, and driver/citizen real-time updates. A passing health check alone does not validate these dependencies.

## Hospital dataset tools

These commands run from `backend`:

```powershell
npm run build:hospitals:mumbai
npm run import:hospitals:mongodb
```

The builder writes `mumbai-hospitals-all.xlsx`, a station-wise JSON report, and a checkpoint file. It queries Overpass around the configured Mumbai rail-station points and may fall back to Google Text Search. It resumes from completed checkpoints by default. Supported flags include:

```powershell
node scripts/build-mumbai-hospitals-stationwise.js --reset
node scripts/build-mumbai-hospitals-stationwise.js --from="Dadar"
node scripts/build-mumbai-hospitals-stationwise.js --limit=5
```

The importer requires the XLSX and `MONGODB_URI`; it bulk-upserts records. Review generated data and estimates before importing or displaying it as factual capacity information.

## Verification and troubleshooting

There is no automated test script in `backend/package.json`. Available baseline checks:

```powershell
node --check backend/server.js
git diff --check
```

Useful diagnostics:

- **OTP screen says SMS unavailable/demo code:** the backend did not confirm SMS delivery. Check the JSON response's `smsStatus`, `provider`, and `error`, then inspect Render logs and Twilio Verify settings.
- **`/health` works but login or records fail:** the process may be serving without a working MongoDB connection. Inspect Render logs and `MONGODB_URI`.
- **Hosted page calls localhost:** clear `apiBaseUrl` in that site's browser local storage and hard-reload; check the page's deployment URL override.
- **REST works but live dispatch does not:** verify Socket.IO is reachable and the deployed frontend origin is allowed via `FRONTEND_URL`.
- **Map fails but core API works:** verify the Google key, API enablement, and browser/API-key restrictions. Map providers are optional for non-map backend features.
- **Location is unavailable:** grant browser permission and use HTTPS or localhost.
- **Login state appears stale:** clear the app's site storage and sign in again.

For a manual end-to-end demo, start MongoDB and the backend, serve the frontend, register a citizen and driver, grant driver location permission, mark the driver online, create an SOS, accept the dispatch, report pickup, and complete the mission. Verify the emergency record and event updates in the dashboards and backend logs.

## Limitations and security

- This project is a prototype and must not be relied on for actual emergency response.
- Dispatches, online socket presence, OTPs, and reassignment timers are stored in process memory and are not durable across restarts or multiple instances.
- The nearest-driver calculation is straight-line distance. ETA and route graphics are estimates or map-provider output, not emergency-grade routing.
- Driver location snapping and seeded locations are demo conveniences; they do not validate real GPS.
- Hospital ownership may be inferred; specialty coverage may be generic; bed counts, ratings, hours, services, and imported data may be estimated, stale, or incomplete. There is no authoritative real-time capacity feed.
- Admin daily analytics are based on persisted SOS records, but driver seeds and locations can be simulated demo data.
- Demo OTP is enabled by default in code, and the OTP is stored in process memory. Disable the fallback in production and use a real provider.
- The code has a fallback JWT secret, stores driver passwords without the same hashing used for hospital passwords, and exposes operational endpoints that need authorization. Set strong secrets and implement proper role-based authorization and password hashing before production.
- The optional admin/migration key is not a substitute for authenticated admin authorization; if unset, its checks are bypassed. Hospital credential/bootstrap endpoints also require production access controls.
- Restrict Google API keys and protect MongoDB/Twilio credentials. Never put secrets in frontend code, commit `.env`, or expose production credentials in logs/screenshots.
- REST CORS is permissive and Socket.IO origin policy is configured separately. Review both policies for your actual domains before production.
- Add automated tests, durable job/dispatch recovery, audit logging, rate-limit tuning, monitoring, and verified emergency-service integrations before considering production use.
