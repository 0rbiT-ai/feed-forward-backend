# Feed-forward Backend

This is the backend for the Feed-forward application, built with Node.js, Express, Prisma, Socket.io, and more.

## Features

- RESTful API with Express
- Real-time communication with Socket.io
- Database ORM with Prisma (PostgreSQL)
- Authentication:
  - JWT (access token and refresh token stored in HTTP-only cookies)
  - OTP-based login (via email/SMS, simulated with Redis)
  - Google OAuth
- Redis for caching and temporary storage (OTP)
- Firebase Admin for FCM push notifications (configured via service account)
- Basic structure for location-based services (to be extended with PostGIS and Redis Geo)

## Prerequisites

- Node.js (>=18)
- PostgreSQL with PostGIS extension enabled
- Redis server
- Firebase project (for FCM, optional)
- Google OAuth credentials (for Google login)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up environment variables:
   Copy the `.env` example below and fill in the values.

   ```env
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/feedforward?schema=public"

   # JWT: use two different random secrets; both tokens use HS256
   JWT_SECRET="<random-access-token-secret>"
   JWT_REFRESH_SECRET="<different-random-refresh-token-secret>"
   JWT_ACCESS_EXPIRES_IN="15m"
   JWT_REFRESH_EXPIRES_IN="30d"

   # Port
   PORT=5000

   # Redis
   REDIS_URL="redis://localhost:6379"

   # Firebase Admin (for FCM), optional
   # Download a service account JSON from Firebase Console > Project settings > Service accounts.
   # Keep this file outside git and point to it from the backend directory:
   FCM_SERVICE_ACCOUNT="./firebase-service-account.json"
   # Or provide the complete JSON object as one environment variable.

   # Google OAuth for app sign-in
   GOOGLE_OAUTH_CLIENT_ID="your_google_client_id"
   GOOGLE_OAUTH_CLIENT_SECRET="your_google_client_secret"
   GOOGLE_OAUTH_CALLBACK_URL="http://localhost:5003/auth/google/callback"

   # Cloudinary signed uploads for restaurant listing photos
   CLOUDINARY_CLOUD_NAME="your_cloud_name"
   CLOUDINARY_API_KEY="your_api_key"
   CLOUDINARY_API_SECRET="your_api_secret"

   # Gmail SMTP for OTP email delivery (use a Google App Password, not an API key)
   SMTP_HOST="smtp.gmail.com"
   SMTP_PORT="465"
   SMTP_SECURE="true"
   SMTP_USER="your-gmail-address@gmail.com"
   SMTP_PASS="your-16-character-google-app-password"
   SMTP_FROM="FeedForward <your-gmail-address@gmail.com>"

   # Frontend URL (for CORS and redirect)
   FRONTEND_URL="http://localhost:3000"
   ```

   JWT access and refresh tokens are signed with HS256 and must use separate secrets.
   FCM Admin is initialized when `FCM_SERVICE_ACCOUNT` is set; push delivery still requires
   registering device tokens and calling the Firebase Admin messaging API from a notification route.

### Gmail SMTP OTP setup

1. Enable 2-Step Verification on the Gmail account.
2. Create a Google **App Password** for FeedForward.
3. Set `SMTP_USER` to that Gmail address and `SMTP_PASS` to the generated 16-character App Password. Keep it in `.env`; do not commit or share it.
4. The defaults above use Gmail's SMTP server over implicit TLS on port 465. For port 587, set `SMTP_PORT="587"` and `SMTP_SECURE="false"`.

Gmail SMTP uses an App Password here; Google Cloud API keys and OAuth client ID/secret are not SMTP passwords. Google OAuth sign-in continues to use the separate `GOOGLE_OAUTH_*` settings. Phone OTPs still use Twilio when its variables are configured; otherwise development OTPs are printed in the backend log.

3. Set up the database:
   - Ensure PostgreSQL is running and the `feedforward` database exists.
   - Enable the PostGIS extension in the database:
     ```sql
     CREATE EXTENSION IF NOT EXISTS postgis;
     ```
   - Run Prisma migrations to create the tables:
     ```bash
     npx prisma migrate dev --name init
     ```

4. Start the server:
   ```bash
   npm start
   ```
   For development with auto-reload:
   ```bash
   npm run dev
   ```

## API Routes

### Authentication
- `POST /auth/send-otp` - Send OTP to email (body: `{ email }`)
- `POST /auth/verify-otp` - Verify OTP and log in (body: `{ email, otp }`)
- `GET /auth/google` - Redirect to Google OAuth
- `GET /auth/google/callback` - Google OAuth callback
- `POST /token/refresh` - Refresh access token (requires refresh token cookie)
- `POST /auth/logout` - Logout (clears cookies)

### Protected Routes
- `GET /profile` - Get current user profile (requires access token cookie)

### Socket.io
- Connect to the Socket.io server for real-time updates.
- Use `authenticate` event with a JWT to join user-specific rooms.

## Extending the Backend

### Location-based Services
To implement location-based search for restaurants and NGOs:

1. Extend the Prisma schema in `prisma/schema.prisma` to add models for Restaurant and NGO with location fields.
   Example using PostGIS:
   ```prisma
   model Restaurant {
     id        Int      @id @default(autoincrement())
     name      String
     location  String   @db.Point
     // or store latitude and longitude as separate floats and use raw queries for distance
     lat       Float
     lng       Float
     createdAt DateTime @default(now())
     updatedAt DateTime @updatedAt
   }
   ```

2. Implement endpoints to search for nearby locations using PostGIS functions (e.g., `ST_Distance`) or Redis Geo.

### Real-time Feed
Use Socket.io to emit events when new feed items are created, and have clients subscribe to relevant channels.

### Push Notifications
Use Firebase Admin to send push notifications via FCM when certain events occur (e.g., new feed item, new message).

### Caching
Use Redis to cache expensive operations like nearby search results.

## Project Structure

- `server.js` - Main Express server with Socket.io
- `prisma/` - Prisma schema and migrations
- `.env` - Environment variables
- `package.json` - Dependencies and scripts

## Note

This backend is a starting point. You will need to implement the specific business logic for your application, such as:
- Creating, reading, updating, and deleting feed items.
- Managing restaurant and NGO profiles.
- Implementing the live feed functionality.
- Adding any additional features required by your frontend.

## Troubleshooting

- If you encounter Prisma client generation errors, ensure you have the correct Prisma ORM CLI version installed (matching the `@prisma/client` version).
- Make sure PostgreSQL, Redis, and any other services are running and accessible.
- Check the console for error messages during startup.

## License

ISC
