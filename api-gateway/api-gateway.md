# API Gateway Service

## Overview

The API Gateway is the single entry point for all client requests in this microservices architecture. It handles **rate limiting**, **JWT authentication**, **request proxying**, and **centralized logging** — offloading cross-cutting concerns from individual services.

---

## Architecture

```
Client
  │
  ▼
┌─────────────────────────────────────────────────┐
│                  API Gateway                    │
│                                                 │
│  ┌──────────┐  ┌────────────┐  ┌─────────────┐ │
│  │ Helmet   │  │ Rate Limit │  │   CORS      │ │
│  │ Security │  │ (Redis)    │  │             │ │
│  └──────────┘  └────────────┘  └─────────────┘ │
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │             Auth Middleware              │   │
│  │         (JWT Verification)               │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ │
│  │  /auth   │ │ /posts   │ │/media  │ │/search│ │
│  └────┬─────┘ └────┬─────┘ └───┬────┘ └──┬───┘ │
└───────┼────────────┼───────────┼──────────┼─────┘
        │            │           │          │
        ▼            ▼           ▼          ▼
  Identity Svc   Post Svc   Media Svc  Search Svc
```

---

## Request Lifecycle

```
┌────────────────────────────────────────────────────────┐
│                     Request Flow                       │
└────────────────────────────────────────────────────────┘

Client Request
     │
     ▼
[1] Helmet Middleware      → Sets security headers (XSS, HSTS, etc.)
     │
     ▼
[2] CORS Middleware        → Validates cross-origin policies
     │
     ▼
[3] express.json()         → Parses JSON request body
     │
     ▼
[4] Rate Limiter           → Max 50 req / 15 min per IP (backed by Redis)
     │            ┌──────────────────────────────────┐
     │            │ If exceeded → 429 Too Many Requests│
     │            └──────────────────────────────────┘
     ▼
[5] Request Logger         → Logs method, URL, body (Winston)
     │
     ▼
[6] Route Matching
     │
     ├──/v1/auth/*  ──────────────────────────────────────────┐
     │   └─ No auth required                                  │
     │   └─ Proxy → Identity Service                          │
     │                                                        │
     ├──/v1/posts/*                                           │
     │   └─ validateToken ──→ [JWT invalid? → 401]            │
     │   └─ Attach x-user-id header                          │
     │   └─ Proxy → Post Service                              │
     │                                                        │
     ├──/v1/media/*                                           │
     │   └─ validateToken ──→ [JWT invalid? → 401]            │
     │   └─ Attach x-user-id header                          │
     │   └─ Preserve Content-Type for multipart/form-data    │
     │   └─ Proxy → Media Service (parseReqBody: false)       │
     │                                                        │
     └──/v1/search/*                                          │
         └─ validateToken ──→ [JWT invalid? → 401]            │
         └─ Attach x-user-id header                          │
         └─ Proxy → Search Service                           │
                                                             │
     ◄───────────────────────────────────────────────────────┘
     │
     ▼
[7] Upstream Response      → Logged with status code
     │
     ▼
[8] Error Handler          → Catches any unhandled errors → 500
     │
     ▼
Client Response
```

---

## Route Configuration

| Route Prefix | Auth Required | Target Service | Notes |
|---|---|---|---|
| `POST /v1/auth/*` | ❌ No | Identity Service | Login, Register, Token refresh |
| `* /v1/posts/*` | ✅ JWT | Post Service | Injects `x-user-id` header |
| `* /v1/media/*` | ✅ JWT | Media Service | Preserves `multipart/form-data`, `parseReqBody: false` |
| `* /v1/search/*` | ✅ JWT | Search Service | Injects `x-user-id` header |

### Path Rewriting

All incoming `/v1/*` paths are rewritten to `/api/*` before reaching upstream services:

```
/v1/posts/123  →  /api/posts/123
/v1/auth/login →  /api/auth/login
```

---

## Middleware Details

### 1. Rate Limiter

Uses `express-rate-limit` with a **Redis-backed store** (`rate-limit-redis`) to ensure limits are shared across multiple gateway instances.

```
Window : 15 minutes
Max    : 50 requests per IP
Store  : Redis (distributed, consistent across instances)
On Hit : 429 JSON response + warn log
```

Redis is the store of choice here (over in-memory) because it survives restarts and works correctly in horizontally scaled deployments.

---

### 2. Auth Middleware (`validateToken`)

Applied to all routes **except** `/v1/auth`. Verifies the JWT from the `Authorization: Bearer <token>` header.

```
Sequence:
  1. Extract token from Authorization header
  2. If missing → 401 "Authentication required"
  3. jwt.verify(token, JWT_SECRET)
  4. If invalid/expired → 401 "Invalid token"
  5. If valid → attach decoded payload to req.user, call next()
```

The `req.user.userId` extracted from the token is forwarded downstream as `x-user-id` so services know which user is acting without needing to re-verify the token.

---

### 3. Proxy Configuration

Each service uses `express-http-proxy` with shared base options:

| Option | Behavior |
|---|---|
| `proxyReqPathResolver` | Rewrites `/v1/*` → `/api/*` |
| `proxyErrorHandler` | Catches upstream errors, returns 500 JSON |
| `proxyReqOptDecorator` | Adds `Content-Type` and `x-user-id` headers |
| `userResDecorator` | Logs upstream response status code |

**Media service special case:** `parseReqBody: false` is set so that binary/multipart bodies are streamed directly without being parsed by the gateway, preventing corruption of file uploads.

---

### 4. Logger (Winston)

Structured JSON logging with environment-aware log levels:

| Environment | Level | Output |
|---|---|---|
| `production` | `info` | Console + Files |
| `development` | `debug` | Console + Files |

**Transports:**
- **Console** — colorized, simple format for developer readability
- **error-log** file — error-level entries only
- **combined.log** file — all log entries

Every log entry automatically includes:
- `timestamp`
- `service: "api-gateway"`
- Stack trace for errors

---

### 5. Error Handler

Global Express error handler (`errorHandler`) catches any unhandled errors thrown in middleware or route handlers, logs the full stack trace, and returns a clean JSON response to the client.

```js
// Response shape
{
  "message": "Error description or Internal Server Error"
}
// Status: error.status || 500
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Gateway port (default: `3000`) |
| `REDIS_URL` | Redis connection string for rate limiter |
| `JWT_SECRET` | Secret key for JWT verification |
| `IDENTITY_SERVICE_URL` | Base URL of the Identity microservice |
| `POST_SERVICE_URL` | Base URL of the Post microservice |
| `MEDIA_SERVICE_URL` | Base URL of the Media microservice |
| `SEARCH_SERVICE_URL` | Base URL of the Search microservice |
| `NODE_ENV` | `production` or `development` (affects log level) |

---

## Security Measures

| Layer | Tool | Purpose |
|---|---|---|
| HTTP Headers | `helmet` | Prevents XSS, clickjacking, MIME sniffing |
| CORS | `cors` | Controls allowed origins |
| Auth | `jsonwebtoken` | Stateless identity verification |
| Rate Limiting | `express-rate-limit` + Redis | Prevents abuse / DoS |

---

## File Structure

```
api-gateway/
├── server.js                  # Main entry point
├── middleware/
│   ├── authMiddleware.js       # JWT validation
│   └── errorHandler.js        # Global error handler
├── utils/
│   └── logger.js              # Winston logger setup
├── .env                       # Environment variables
└── package.json
```

---

## Sequence Diagram: Authenticated Request (e.g. POST /v1/posts)

```
Client          API Gateway         Redis          Post Service
  │                  │                │                 │
  │─── POST /v1/posts ──────────────► │                 │
  │                  │                │                 │
  │                  │── rate check ──►                 │
  │                  │◄── OK ─────────│                 │
  │                  │                │                 │
  │                  │ validate JWT   │                 │
  │                  │ (local verify) │                 │
  │                  │                │                 │
  │                  │── rewrite path ─────────────────►│
  │                  │   add x-user-id header           │
  │                  │                │                 │
  │                  │◄─────────────── response ────────│
  │                  │                │                 │
  │◄── response ─────│                │                 │
```

---

## Sequence Diagram: Auth Request (e.g. POST /v1/auth/login)

```
Client          API Gateway       Identity Service
  │                  │                  │
  │─── POST /v1/auth/login ───────────► │
  │                  │                  │
  │                  │── no JWT check   │
  │                  │── rewrite path ──►
  │                  │                  │
  │                  │◄─── JWT token ───│
  │                  │                  │
  │◄── JWT token ────│                  │
```
