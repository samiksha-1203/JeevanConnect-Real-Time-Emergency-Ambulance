# Jeevan Connect

Jeevan Connect is a real-time emergency response platform that connects citizens, ambulance drivers, hospitals, and dispatch/admin operations.

It includes:
- OTP-based citizen authentication
- Real-time SOS creation and dispatch assignment
- Nearest-driver matching using live locations
- Hospital discovery (Google Places, OSM, and local fallback)
- Hospital-specific login and bed-capacity updates
- Live Socket.IO mission lifecycle updates

## Repository Structure

```text
FINAL_MAJOR/
|-- README.md
|-- .gitignore
|-- frontend/
|   |-- index.html                      # Landing page
|   |-- citizen-dashboard.html          # Citizen app UI
|   |-- ambulance-driver-dashboard.html # Driver app UI + map route rendering
|   |-- hospital-dashboard.html         # Hospital login + bed management UI
|   `-- admin-dashboard.html            # Admin/dispatch UI
`-- backend/
    |-- server.js                       # Main Express + Socket.IO + Mongo runtime
    |-- package.json                    # Backend scripts/dependencies
    |-- .env.example                    # Environment template
    |-- mumbai-hospitals-all.xlsx       # Local fallback hospital dataset
    `-- scripts/
        |-- build-mumbai-hospitals-stationwise.js  # Dataset builder utility
        `-- import-hospitals-to-mongodb.js         # XLSX -> Mongo import utility
```

### Backend Folder Responsibilities
- `server.js` holds API routes, Mongoose schemas, JWT auth logic, hospital credential flows, and Socket.IO dispatch lifecycle.
- `scripts/build-mumbai-hospitals-stationwise.js` is used to regenerate/prepare structured Mumbai hospital XLSX data.
- `scripts/import-hospitals-to-mongodb.js` imports hospital rows into MongoDB with import source tagging.

### Frontend Folder Responsibilities
- `index.html`: entry and role-based navigation UI.
- `citizen-dashboard.html`: emergency request, profile/medical info, and dispatch status tracking.
- `ambulance-driver-dashboard.html`: driver login, live location, dispatch actions, and route visualization.
- `hospital-dashboard.html`: hospital login, authenticated session, and facilities/bed capacity updates.
- `admin-dashboard.html`: admin operations and migration/cluster action triggers.

## System Architecture (How It Works End-to-End)

1. Citizen verifies phone (OTP) and creates SOS with location.
2. Backend stores emergency and computes nearest available driver using Haversine distance.
3. Driver receives live dispatch event via Socket.IO.
4. Driver accepts mission; citizen receives acceptance and live ambulance location.
5. When patient is picked, system assigns nearby hospital and updates both parties.
6. Hospital can independently log in and maintain current bed capacities.
7. Emergency is marked complete; statuses and timestamps are persisted for audit.

### Runtime Components
- API layer: Express REST endpoints for auth, emergency, hospital, and admin functions.
- Real-time layer: Socket.IO for dispatch, acceptance, location streaming, and completion events.
- Data layer: MongoDB + Mongoose schemas (`User`, `Driver`, `Emergency`, `Hospital`).
- Mapping layer:
  - Backend assignment: Haversine nearest-driver ranking.
  - Frontend navigation: Google Directions path rendering in driver dashboard.
  - Hospital discovery: Google Places -> local XLSX/DB -> OSM -> mock fallback chain.

## Database Design (MongoDB Collections)

All core models are defined in `backend/server.js` using Mongoose.

### 1) `users` Collection
Stores citizen accounts and medical profile data.

Main fields:
- `phone` (unique, required)
- `name`, `email`, `bloodGroup`
- `medicalProfile.organDonor`, `allergies`, `conditions`, `medications`, `emergencyNote`
- `role` (`citizen` or `driver`)
- `isVerified`, `lastLoginAt`, `createdAt`

### 2) `drivers` Collection
Stores ambulance driver identity, login, and live operational state.

Main fields:
- `driverId` (unique, sparse)
- `loginId` (unique, sparse)
- `password` (default seeded value in current setup)
- `phone` (unique, required), `name`, `licenseNumber`
- `vehicleType`, `ambulanceId`
- `status` (`available`, `busy`, `offline`), `isOnline`, `lastLoginAt`
- `location.lat`, `location.lng`, `location.address`, `location.city`, `location.state`, `location.lastUpdated`
- `createdAt`

### 3) `emergencies` Collection
Stores complete emergency lifecycle from creation to completion/cancellation.

Main fields:
- Citizen identity snapshot: `citizenName`, `citizenPhone`, `citizenId`
- Request metadata: `requestChannel`, `initiatedBy`
- Emergency details: `emergencyType`, `description`, `priority`
- Incident location: `location.lat`, `location.lng`, `location.address`
- Lifecycle state: `status` (`pending`, `assigned`, `enroute`, `arrived`, `completed`, `cancelled`)
- Assignment data: `assignedDriver`, `assignedDriverSnapshot`, `assignedHospital`
- Timeline: `ambulancePickedAt`, `hospitalAssignedAt`, `completedAt`, `cancelledAt`
- Medical snapshot: `medicalSnapshot.*`
- `createdAt`

### 4) `hospitals` Collection
Stores hospital profile, location, service metadata, and bed capacities.

Main fields:
- Identity: `name`, `hospitalNo`, `loginId`, `passwordHash`, `lastLoginAt`
- Classification: `source`, `type`, `specialties`
- Geo: `location.lat`, `location.lng`, `location.address`, `location.city`, `location.state`
- Bed/facility capacity: `facilities.icuBeds`, `generalBeds`, `lowBeds`, `totalBeds`
- Service availability: `services.opd`, `lab`, `bloodBank`, `parking`, `trauma`, `cardiology`
- Optional info: `distance`, `driveTime`, `operatingHours`, `phoneNumber`, `rating`
- `createdAt`

### Important Data Conventions
- Hospital login IDs are maintained in `hosp0001` style for operator-friendly authentication.
- Hospital credentials API exposes these IDs as Hospital No values in admin-facing lists.
- Distance strategy for assignment is deterministic and auditable (`haversine-nearest`).

### Collection Relationships
- `emergencies.citizenId` references `users._id`.
- `emergencies.assignedDriver` references `drivers._id`.
- `emergencies.assignedHospital` references `hospitals._id`.
- `emergencies.assignedDriverSnapshot` stores immutable dispatch-time driver details for audit history.

### Index/Constraint Highlights
- Unique identifiers: `users.phone`, `drivers.phone`, `drivers.driverId`, `drivers.loginId`, `hospitals.loginId`.
- Sparse unique keys on optional IDs avoid collisions when fields are not yet assigned.
- Enum-based status constraints enforce controlled lifecycle transitions.

## Core Features Implemented

### 1) Citizen Authentication and Emergency Flow
- Citizen OTP flow via SMS providers (Twilio/custom verification service fallback).
- Citizen profile endpoints for fetch/update.
- Emergency creation endpoint with citizen identity support.
- Emergency cancel endpoint.
- Dispatch status tracking endpoint.

### 2) Driver System and Nearest Driver Assignment
- Driver register/login APIs.
- Real-time driver online/offline and location updates through Socket.IO.
- Nearest-driver selection based on geographic distance (Haversine distance logic in backend).
- Assignment lifecycle handling:
  - dispatch call sent
  - accept/decline
  - patient picked
  - emergency completed

### 3) Hospital Finder and Triage-Oriented Selection
- Nearby hospitals endpoint with multi-source fallback strategy:
  1. Google Places nearby hospitals
  2. Local Mumbai fallback list
  3. OpenStreetMap overpass fallback
  4. Mock fallback (last resort)
- Distance sorting and bed/availability-oriented metadata.
- Hospital search and hospital details endpoints.

### 4) Hospital Login and Bed Management
- Hospital login bootstrap endpoint (bulk credential setup for imported hospitals).
- Hospital login IDs in hosp0001 format.
- Hospital credentials listing endpoint for admin usage.
- Hospital auth endpoint that returns JWT.
- Protected hospital profile endpoint.
- Protected hospital facilities update endpoint:
  - ICU beds
  - General beds
  - Low-acuity beds
  - Total beds
- Hospital dashboard integrated with login session storage and per-hospital updates.

### 5) Real-Time System (Socket.IO)
- Citizen and driver socket registration.
- Dispatch event propagation in real time.
- Location updates and mission state broadcasting.
- Disconnect handling and availability transitions.

#### Main Real-Time Events
- Registration/state: `citizen-register`, `driver-register`, `driver-online`, `driver-status-update`
- Location streaming: `location-update`, `driver-location-update`
- Dispatch: `citizen-sos-request`, `dispatch-call`, `sos-pending`, `sos-assigned`, `sos-no-driver`
- Driver decisions: `driver-accept-dispatch`, `driver-decline-dispatch`, `driver-accepted`
- Mission progression: `driver-patient-picked`, `hospital-assigned`, `driver-emergency-completed`, `emergency-completed`
- Cancellation/failure: `citizen-cancel-sos`, `sos-cancelled`, `hospital-selection-failed`

### 6) Admin and Data Operations
- Driver seeding endpoint.
- Migration endpoints for:
  - forcing availability/location
  - clustering/randomizing driver positions
  - smart Mumbai clustering
  - emergency backfill and identity migration helpers
- XLSX hospital build/import scripts for Mumbai data pipeline.

## What Is Haversine (And Why Used Here)

Haversine is a geographic formula used to compute the shortest straight-line distance between two points on Earth using latitude and longitude.

In this project, it is used to rank nearest ambulance drivers quickly at dispatch time.

Formula:

```text
a = sin^2((dLat)/2) + cos(lat1) * cos(lat2) * sin^2((dLon)/2)
c = 2 * atan2(sqrt(a), sqrt(1-a))
distance = R * c
```

Where:
- `R` = Earth radius (approximately 6371 km)
- `lat1`, `lon1` = incident coordinate
- `lat2`, `lon2` = driver coordinate

Why it is useful for dispatch:
- Very fast computation (good for real-time matching).
- Deterministic and easy to audit/debug.
- Works even when road/traffic APIs are rate-limited or temporarily unavailable.

Limitations to remember:
- It is straight-line distance, not exact road travel time.
- Final road route guidance still happens through map routing in the driver UI.

## How Matching Is Implemented

### Nearest Driver Logic
- Driver locations are read from live socket updates and persisted driver state.
- Distance between incident and driver is computed using Haversine formula.
- Candidate drivers are filtered for availability and ranked by nearest distance.
- Assignment metadata stores selection method (haversine-nearest) and timing details.

### Nearest Hospital Logic
- For user coordinates, backend requests nearby hospitals from Google Places first.
- If unavailable/empty, it falls back to local curated Mumbai data.
- If still empty, it uses OpenStreetMap query results.
- Final fallback uses bundled mock hospital data.
- Hospitals are normalized and sorted by nearest distance before response.

## Routing Strategy

### Dispatch-Level Routing (Who Gets Assigned)
- Ambulance assignment is distance-first and deterministic.
- Backend computes straight-line distance using Haversine formula between SOS point and available drivers.
- Driver choice is nearest-first, with tie-break logic only when candidates are almost equal.
- Assignment metadata stores method as haversine-nearest for audit/debug visibility.

### Driver Navigation Routing (How Driver Travels)
- Driver dashboard renders route using Google Directions APIs for map path visualization.
- Route phase is dynamic:
  - Ambulance -> Patient (pickup phase)
  - Patient -> Hospital (transfer phase)
- Traffic overlay in driver dashboard is intentionally disabled by default (stable emergency UI behavior).
- Route summary (distance, ETA, speed) is shown live in the driver dashboard.

### Why This Approach Is Useful for Emergency Dispatch
- Fast and predictable assignment: nearest ambulance is selected immediately without waiting on traffic-model fluctuations.
- Stable operations: assignment decisions stay consistent under frequent live updates.
- Better control for triage: dispatch logic is transparent (distance-based), while navigation still uses road-aware route rendering.
- In practice, this means the system prioritizes shortest-distance emergency pickup first, instead of continuously re-optimizing by traffic estimates.

### Compared With Pure Google-Traffic Assignment
- Pure traffic-time assignment can be more dynamic but may fluctuate rapidly during peak congestion.
- This project currently prioritizes deterministic nearest-distance assignment for faster and more explainable dispatch.
- If needed later, you can add a configurable mode to choose between:
  - nearest-distance (current)
  - fastest-eta (traffic-aware)

## API Overview

### Health and Config
- GET /health
- GET /api/config

### Citizen/Auth
- POST /api/auth/send-otp
- POST /api/auth/verify-otp
- POST /api/auth/check-phone
- POST /api/auth/register
- GET /api/auth/me
- GET /api/auth/profile
- PUT /api/auth/profile

### Driver
- POST /api/driver/register
- POST /api/driver/login
- GET /api/drivers

### Emergency
- POST /api/emergency
- POST /api/emergency/:id/cancel
- GET /api/emergency/:id/dispatch-status

### Hospitals
- GET /api/hospitals/all
- GET /api/hospitals/nearby
- GET /api/hospitals/search
- GET /api/hospitals/:id
- GET /api/hospitals/map/:id

### Hospital Account Management
- POST /api/hospital/bootstrap-logins
- POST /api/hospital/migrate-login-ids
- GET /api/hospital/credentials
- POST /api/hospital/login
- GET /api/hospital/me
- PUT /api/hospital/me/facilities

### Admin/Migrations
- POST /api/admin/seed/mumbai-drivers
- GET /api/admin/ambulance-assignments
- POST /api/admin/migrations/force-drivers-available-with-location
- POST /api/admin/migrations/cluster-drivers-nearby
- POST /api/admin/migrations/randomize-drivers-mumbai
- POST /api/admin/migrations/smart-cluster-drivers-mumbai
- POST /api/admin/migrations/backfill-emergency-assigned-driver
- POST /api/admin/migrations/emergency-citizen-identity

## Technology Stack

### Frontend
- HTML5
- CSS3
- Vanilla JavaScript
- Socket.IO client
- Google Maps JavaScript integration

### Backend
- Node.js
- Express
- Socket.IO
- Mongoose
- MongoDB
- JWT (jsonwebtoken)
- bcryptjs
- helmet and express-rate-limit
- Twilio SDK
- xlsx for hospital data import

## Environment Variables

Create backend/.env from backend/.env.example and set values:

- PORT
- MONGODB_URI
- JWT_SECRET
- GOOGLE_MAPS_API_KEY
- GOOGLE_PLACES_API_KEY (optional override)
- ADMIN_MIGRATION_KEY
- RATE_LIMIT_WINDOW_MS
- RATE_LIMIT_MAX
- TWILIO_ACCOUNT_SID
- TWILIO_AUTH_TOKEN
- TWILIO_PHONE_NUMBER
- TWILIO_VERIFY_SERVICE_SID
- VERIFY_SERVICE_URL
- VERIFY_SERVICE_API_KEY
- VERIFY_SERVICE_AUTH_HEADER

## Local Setup

1. Install backend dependencies:

   cd backend
   npm install

2. Start backend:

   npm start

3. Open frontend pages from frontend folder in browser (or serve as static files).

Backend default URL: http://localhost:5000

## Data Scripts

From backend folder:

- npm run build:hospitals:mumbai
- npm run import:hospitals:mongodb

### Why These Scripts Are Kept
- `build:hospitals:mumbai` is for regenerating or updating structured Mumbai hospital datasets when source data changes.
- `import:hospitals:mongodb` is required to populate MongoDB hospital records used by hospital login/facilities management APIs.
- If MongoDB already has valid `source='xlsx-import'` hospital records, you do not need to run import on every startup.

## GitHub Push Checklist

1. Ensure backend/.env is not committed.
2. Ensure logs and temporary files are excluded by .gitignore.
3. Run:

   git add .
   git status
   git commit -m "Project cleanup and README update"
   git push

## Notes

- This repository now excludes one-off debug scripts and generated log artifacts used during local troubleshooting.
- Hospital login IDs are maintained in hosp0001 format and exposed as Hospital No in credentials responses.