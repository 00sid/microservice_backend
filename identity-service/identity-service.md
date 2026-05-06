# Identity Service

## Overview

The Identity Service is the authentication microservice responsible for **user registration**, **login**, **token issuance**, **token refresh**, and **logout**. It is the only service in the architecture that clients interact with **without a JWT** — all other services require a valid token issued here.

It uses **MongoDB** for persistent user and refresh token storage, **Redis** for distributed rate limiting, and a **dual-token strategy** (short-lived JWT access token + long-lived opaque refresh token) for session management.

---

## Architecture

```
API Gateway (/v1/auth/*)
        │
        ▼
┌────────────────────────────────────────────────┐
│               Identity Service                 │
│                                                │
│  ┌──────────┐  ┌──────────────────────────┐   │
│  │  Helmet  │  │  DDoS Rate Limiter       │   │
│  │  CORS    │  │  (RateLimiterRedis)      │   │
│  └──────────┘  │  10 req/sec per IP       │   │
│                └──────────────────────────┘   │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │  Sensitive Endpoint Limiter              │  │
│  │  (express-rate-limit + Redis)            │  │
│  │  50 req / 15 min on /api/auth/register   │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │            Route Handlers                │  │
│  │  POST /api/auth/register                 │  │
│  │  POST /api/auth/login                    │  │
│  │  POST /api/auth/refresh-token            │  │
│  │  POST /api/auth/logout                   │  │
│  └──────────────────────────────────────────┘  │
└──────┬─────────────────────────┬───────────────┘
       │                         │
       ▼                         ▼
   MongoDB                    Redis
(Users, RefreshTokens)     (Rate limiting)
```

---

## Middleware Stack (Request Order)

```
Incoming Request
      │
      ▼
[1] Helmet              → Security headers
      │
      ▼
[2] CORS                → Cross-origin policy
      │
      ▼
[3] express.json()      → Parse JSON body
      │
      ▼
[4] Request Logger      → Log method, URL, body
      │
      ▼
[5] DDoS Limiter        → 10 req/sec per IP (RateLimiterRedis)
      │       ┌──────────────────────────────┐
      │       │ Exceeded → 429 Too Many Requests │
      │       └──────────────────────────────┘
      ▼
[6] Sensitive Limiter   → 50 req/15 min on /register only
      │
      ▼
[7] Routes              → Controller logic
      │
      ▼
[8] Error Handler       → Global catch-all → 500
```

---

## Rate Limiting Strategy

Two independent layers protect the service:

| Layer | Library | Limit | Scope | Purpose |
|---|---|---|---|---|
| DDoS Protection | `rate-limiter-flexible` | 10 req / 1 sec | All routes, per IP | Block burst/flood attacks |
| Endpoint Protection | `express-rate-limit` | 50 req / 15 min | `/register` only | Prevent brute-force account creation |

Both stores are backed by Redis, ensuring limits hold correctly across multiple service instances.

---

## Token Strategy

The service issues two tokens on successful register or login:

```
┌─────────────────────────────────────────────────────┐
│                   Token Types                       │
├──────────────────┬──────────────────────────────────┤
│  Access Token    │  Refresh Token                   │
├──────────────────┼──────────────────────────────────┤
│  JWT (signed)    │  Random opaque hex string        │
│  Expires: 60 min │  Expires: 7 days                 │
│  Payload:        │  Stored in MongoDB               │
│   - userId       │  (RefreshToken collection)       │
│   - username     │                                  │
│  Verified by     │  Exchanged for a new token pair  │
│  API Gateway     │  (token rotation on use)         │
└──────────────────┴──────────────────────────────────┘
```

**Token rotation** is enforced: when a refresh token is used, the old one is deleted and a brand-new pair is issued. This limits the blast radius of a stolen refresh token.

---

## API Endpoints

### `POST /api/auth/register`

Registers a new user and returns a token pair.

**Request**
```json
{
  "username": "john_doe",
  "email": "john@example.com",
  "password": "securepassword"
}
```

**Response `201`**
```json
{
  "success": true,
  "message": "User registered successfully!",
  "accessToken": "<jwt>",
  "refreshToken": "<hex_string>"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400` | Validation failure (Joi) |
| `400` | Email or username already taken |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

### `POST /api/auth/login`

Authenticates an existing user and returns a token pair.

**Request**
```json
{
  "email": "john@example.com",
  "password": "securepassword"
}
```

**Response `200`**
```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<hex_string>",
  "userId": "<mongo_object_id>"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400` | Validation failure |
| `400` | User not found or wrong password (same message — prevents user enumeration) |
| `500` | Internal server error |

---

### `POST /api/auth/refresh-token`

Exchanges a valid refresh token for a new access + refresh token pair. Old token is deleted (rotation).

**Request**
```json
{
  "refreshToken": "<hex_string>"
}
```

**Response `200`**
```json
{
  "accessToken": "<new_jwt>",
  "refreshToken": "<new_hex_string>"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400` | Refresh token missing |
| `401` | Token not found in DB or expired |
| `401` | Associated user no longer exists |
| `500` | Internal server error |

---

### `POST /api/auth/logout`

Invalidates the user's session by deleting their refresh token from the database.

**Request**
```json
{
  "refreshToken": "<hex_string>"
}
```

**Response `200`**
```json
{
  "success": true,
  "message": "Logged out successfully!"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400` | Refresh token missing |
| `500` | Internal server error |

---

## Sequence Diagrams

### Register

```
Client          Identity Service         MongoDB
  │                    │                    │
  │── POST /register ──►                    │
  │                    │                    │
  │                    │── validate body    │
  │                    │                    │
  │                    │── findOne(email or username) ──►
  │                    │◄── null ───────────│
  │                    │                    │
  │                    │── new User().save() ────────────►
  │                    │◄── saved ──────────│
  │                    │                    │
  │                    │── RefreshToken.create() ────────►
  │                    │◄── stored ─────────│
  │                    │                    │
  │◄── 201 { accessToken, refreshToken } ──│
```

---

### Login

```
Client          Identity Service         MongoDB
  │                    │                    │
  │── POST /login ─────►                    │
  │                    │                    │
  │                    │── validate body    │
  │                    │── findOne(email) ──►
  │                    │◄── user ───────────│
  │                    │                    │
  │                    │── bcrypt.compare(password, hash)
  │                    │   (user.comparePassword)
  │                    │                    │
  │                    │── generateTokens() ►
  │                    │◄── tokens ─────────│
  │                    │                    │
  │◄── 200 { accessToken, refreshToken, userId }
```

---

### Token Refresh (Rotation)

```
Client          Identity Service         MongoDB
  │                    │                    │
  │── POST /refresh ───►                    │
  │                    │                    │
  │                    │── RefreshToken.findOne(token) ──►
  │                    │◄── storedToken ────│
  │                    │                    │
  │                    │── check expiresAt  │
  │                    │── User.findById(storedToken.user) ──►
  │                    │◄── user ───────────│
  │                    │                    │
  │                    │── generateTokens() (new pair) ──────►
  │                    │── RefreshToken.deleteOne(old) ──────►
  │                    │◄── done ───────────│
  │                    │                    │
  │◄── 200 { newAccessToken, newRefreshToken }
```

---

### Logout

```
Client          Identity Service         MongoDB
  │                    │                    │
  │── POST /logout ────►                    │
  │                    │                    │
  │                    │── RefreshToken.deleteOne(token) ──►
  │                    │◄── deleted ────────│
  │                    │                    │
  │◄── 200 { success: true } ──────────────│
```

---

## Data Models

### User

```
{
  _id        : ObjectId
  username   : String (unique)
  email      : String (unique)
  password   : String (bcrypt hashed — via pre-save hook)
}
```

`user.comparePassword(plaintext)` — async method on the model that bcrypt-compares the given password against the stored hash.

### RefreshToken

```
{
  _id        : ObjectId
  token      : String  (random 40-byte hex)
  user       : ObjectId (ref: User)
  expiresAt  : Date    (7 days from creation)
}
```

---

## Token Generation (`generateTokens`)

```
generateTokens(user)
  │
  ├─ jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: "60m" })
  │    └─ Returns signed JWT (access token)
  │
  ├─ crypto.randomBytes(40).toString("hex")
  │    └─ Returns opaque 80-char hex string (refresh token)
  │
  ├─ Calculates expiresAt = now + 7 days
  │
  ├─ RefreshToken.create({ token, user: user._id, expiresAt })
  │    └─ Persists refresh token to MongoDB
  │
  └─ Returns { accessToken, refreshToken }
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Service port (default: `3001`) |
| `MONGODB_URL` | MongoDB connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret key for signing JWTs (must match API Gateway) |
| `NODE_ENV` | `production` or `development` |

---

## Error Handling

- **Validation errors** — caught inline per controller, return `400` with Joi message
- **Business logic errors** — (duplicate user, bad credentials) return `400` with safe messages (no leaking whether email exists)
- **Unhandled promise rejections** — caught globally via `process.on("unhandledRejection")`, logged but not crashed
- **All other errors** — bubble to the global `errorHandler` middleware → `500`

---

## File Structure

```
identity-service/
├── server.js                        # Entry point
├── routes/
│   └── identity-service.js          # Route definitions
├── controllers/
│   └── authController.js            # register, login, refresh, logout
├── middleware/
│   └── errorHandler.js              # Global error handler
├── models/
│   ├── User.js                      # User schema + comparePassword method
│   └── RefreshToken.js              # RefreshToken schema
├── utils/
│   ├── logger.js                    # Winston logger
│   ├── generateToken.js             # JWT + refresh token generation
│   └── validation.js                # Joi validation schemas
└── .env
```
