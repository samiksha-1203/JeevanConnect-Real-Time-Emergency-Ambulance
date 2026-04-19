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

- frontend
  - index.html
  - citizen-dashboard.html
  - ambulance-driver-dashboard.html
  - hospital-dashboard.html
  - admin-dashboard.html
- backend
  - server.js
  - package.json
  - scripts
    - build-mumbai-hospitals-stationwise.js
    - import-hospitals-to-mongodb.js

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

### 6) Admin and Data Operations
- Driver seeding endpoint.
- Migration endpoints for:
  - forcing availability/location
  - clustering/randomizing driver positions
  - smart Mumbai clustering
  - emergency backfill and identity migration helpers
- XLSX hospital build/import scripts for Mumbai data pipeline.

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