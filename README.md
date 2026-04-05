# Jeevan Connect

Jeevan Connect is a real-time emergency ambulance dispatch system with a citizen flow, driver flow, live dispatch coordination, and Google Maps routing.

## What the project does

The app lets a citizen register or log in with OTP, submit an emergency SOS, and get assigned to an available ambulance driver. The driver can log in with a dummy test account or a real backend account, accept the mission, and see the route to the patient on Google Maps.

## Main parts of the system

### Frontend

#### `frontend/login-light.html`
This is the entry page for both citizens and drivers.

What each part is used for:
- `Citizen login/register` section: handles phone-based OTP login and registration.
- `Driver login/register` section: lets ambulance drivers log in or create an account.
- `Dummy credentials` button: autofills the test driver login for quick demo use.
- `OTP boxes`: accept the 6-digit verification code.
- `Status note` area: shows login and validation messages.
- `Socket.IO client loading`: connects the browser to the backend for real-time events after login.

#### `frontend/ambulance-driver-dashboard.html`
This is the ambulance driver mission console.

What each part is used for:
- `Mission summary`: shows the active SOS ID, patient type, and priority.
- `Accept mission modal`: confirms the dispatch before navigation starts.
- `Best Route Navigation panel`: shows the live Google Maps route.
- `Route summary cards`: display distance, ETA, and estimated speed.
- `OPEN MAP` button: opens turn-by-turn Google Maps navigation in a new tab.
- `A* path arrows`: show direction guidance along the route.
- `Traffic-aware routing`: changes route color based on traffic severity.
- `Socket.IO connection`: receives dispatch calls from the backend in real time.

### Backend

#### `backend/server.js`
This is the Express + Socket.IO API server.

What each part is used for:
- `Express app`: serves API endpoints.
- `Socket.IO server`: pushes live dispatch events to drivers and citizens.
- `MongoDB connection`: stores user and emergency data.
- `OTP helpers`: send and verify OTPs using Twilio or a fallback service.
- `Dispatch matching`: selects the nearest available driver.
- `Real-time events`: handle driver registration, emergency assignment, and acceptance.
- `/api/config`: exposes runtime configuration such as the Google Maps API key.

## Environment variables

Keep secrets in `backend/.env`. Do not hardcode them in HTML.

Example:

```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/jeevanconnect
JWT_SECRET=your_jwt_secret
GOOGLE_MAPS_API_KEY=your_google_maps_api_key

# Optional SMS / OTP config
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=+1234567890
TWILIO_VERIFY_SERVICE_SID=your_verify_service_sid

# Optional custom OTP service
VERIFY_SERVICE_URL=https://your-otp-service.example/api/send-otp
VERIFY_SERVICE_API_KEY=your_service_key
VERIFY_SERVICE_AUTH_HEADER=Authorization
```

## Setup locally

### 1. Backend

```bash
cd backend
npm install
npm start
```

The backend runs on `http://localhost:5000`.

### 2. Frontend

Open the HTML files directly in the browser or serve the `frontend` folder with a local server.

If you want the frontend to point to a different backend URL, set:

```html
<script>
  window.__API_BASE_URL__ = 'http://localhost:5000';
</script>
```

before the app scripts in the HTML files.

## API endpoints

### Auth
- `POST /api/auth/send-otp` - send OTP
- `POST /api/auth/verify-otp` - verify OTP
- `POST /api/auth/register` - register citizen

### Driver
- `POST /api/driver/register` - register driver
- `POST /api/driver/login` - driver login

### Emergency
- `POST /api/emergency` - create emergency request

### Config
- `GET /api/config` - returns runtime config used by the frontend, including `GOOGLE_MAPS_API_KEY`

## Real-time events

- `driver-online` - driver connected and available
- `driver-register` - driver presence and location update
- `dispatch-call` - new SOS sent to a driver
- `driver-accept-dispatch` - driver accepted the mission
- `new-emergency` - emergency broadcast

## Easiest free deployment

Use this if you want the fastest setup with the least manual work:

- GitHub for source control
- Render free web service for the backend
- Netlify free site for the frontend
- MongoDB Atlas free cluster for the database

### 1. Push the code to GitHub

Run these commands from the project root:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

If the repo already exists locally, you only need `git add`, `git commit`, and `git push`.

### 2. Deploy the backend on Render

1. Sign in to Render with GitHub.
2. Create a new **Web Service** from your GitHub repo.
3. Set the root directory to `backend`.
4. Use these settings:
  - Build command: `npm install`
  - Start command: `npm start`
5. Add environment variables in Render:
  - `PORT=5000`
  - `MONGODB_URI=your_mongodb_atlas_connection_string`
  - `JWT_SECRET=your_secret`
  - `GOOGLE_MAPS_API_KEY=your_google_maps_key`
  - any Twilio or OTP values you use
6. Deploy and copy the Render backend URL.

### 3. Deploy the frontend on Netlify

1. Sign in to Netlify with GitHub.
2. Create a new site from the same repo.
3. Set the publish directory to `frontend`.
4. Add this environment variable in Netlify:

```env
API_BASE_URL=https://your-render-backend-url.onrender.com
```

5. Deploy the site.

### 4. Connect frontend to backend

The HTML files already read `window.__API_BASE_URL__` when it is available. For Netlify or any static host, inject the backend URL before the app scripts, or set the variable through your hosting platform if supported.

Example:

```html
<script>
  window.__API_BASE_URL__ = 'https://your-render-backend-url.onrender.com';
</script>
```

### 5. Check the app

1. Open the frontend URL.
2. Log in with OTP or dummy driver credentials.
3. Trigger a test SOS.
4. Confirm the driver dashboard loads the map and route.

## Notes on Google Maps

- The Google Maps key is no longer stored in the HTML.
- The frontend fetches it from the backend config endpoint.
- If the map stays on loading, check that `GOOGLE_MAPS_API_KEY` is valid, billing is enabled, and the Maps JavaScript API is enabled in Google Cloud.

## Quick GitHub workflow

When you change code later, repeat this workflow:

```bash
git add .
git commit -m "Describe your change"
git push
```

If you add new environment variables, update both `backend/.env` locally and the environment settings on your hosting platform.

## Technology stack

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js, Express, Socket.IO
- Database: MongoDB, Mongoose
- Authentication: JWT, OTP verification
- Maps: Google Maps JavaScript API
- Realtime: Socket.IO

## What is already implemented

- Citizen OTP login and registration
- Driver login with dummy test credentials
- Real-time SOS dispatching
- Driver acceptance flow
- Live route display with Google Maps
- Traffic-aware route coloring
- Direction arrows on the route
- Config endpoint for runtime secrets

## Future improvements

- Persist dispatch history in MongoDB
- Add live ambulance GPS tracking
- Add SMS delivery status
- Add admin dashboard and audit logs

## License

This project is for educational and demo purposes.