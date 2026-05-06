# Social Media Platform — System Documentation

## Overview

This is a **microservices-based social media platform** built with Node.js. Clients interact with a single **API Gateway**, which routes requests to four independent backend services: **Identity**, **Post**, **Media**, and **Search**. Services communicate asynchronously via **RabbitMQ** events, use **Redis** for caching and rate limiting, and persist data in **MongoDB**.

---

## System Architecture

```
                          ┌────────────────┐
                          │    Clients     │
                          │ (Web / Mobile) │
                          └───────┬────────┘
                                  │ HTTPS
                                  ▼
                    ┌─────────────────────────┐
                    │       API Gateway       │
                    │   :3000                 │
                    │  • JWT verification     │
                    │  • Rate limiting        │
                    │  • Request proxying     │
                    └──┬──────┬──────┬──────┬─┘
                       │      │      │      │
              /v1/auth  │  /v1/posts  │  /v1/media  │  /v1/search
                       │      │      │      │
               ┌───────▼┐ ┌───▼────┐ ┌▼───────┐ ┌──▼──────┐
               │Identity│ │  Post  │ │ Media  │ │ Search  │
               │ :3001  │ │ :3002  │ │ :3003  │ │ :3004   │
               └───┬────┘ └───┬────┘ └───┬────┘ └────┬────┘
                   │          │          │            │
               ┌───▼──────────▼──────────▼────────────▼───┐
               │                MongoDB                    │
               └───────────────────────────────────────────┘
                   │          │
               ┌───▼──────────▼───┐
               │      Redis       │
               └──────────────────┘
                         │
               ┌─────────▼────────┐
               │    RabbitMQ      │
               │  Exchange:       │
               │  facebook-post   │
               └──────────────────┘
                         │
               ┌─────────▼────────┐
               │   Cloudinary     │
               │  (Media CDN)     │
               └──────────────────┘
```

---

## Services at a Glance

| Service | Port | Responsibility | DB | Events |
|---|---|---|---|---|
| API Gateway | 3000 | Auth, rate limiting, proxy | — | — |
| Identity Service | 3001 | Register, login, tokens | MongoDB | — |
| Post Service | 3002 | CRUD posts, caching | MongoDB + Redis | Publishes |
| Media Service | 3003 | File uploads, CDN | MongoDB | Consumes |
| Search Service | 3004 | Full-text search index | MongoDB | Consumes |

---

## Infrastructure Components

| Component | Purpose | Used By |
|---|---|---|
| MongoDB | Primary data store | Identity, Post, Media, Search |
| Redis | Rate limiting + response cache | Gateway, Identity, Post |
| RabbitMQ | Async event bus | Post (publish), Media & Search (consume) |
| Cloudinary | File storage and CDN delivery | Media Service |

---

## API Routes

All routes are accessed through the API Gateway at port `3000` with the `/v1` prefix.

### Identity (no auth required)

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/auth/register` | Register new user, returns token pair |
| `POST` | `/v1/auth/login` | Login, returns token pair + userId |
| `POST` | `/v1/auth/refresh-token` | Rotate refresh token, returns new pair |
| `POST` | `/v1/auth/logout` | Invalidate refresh token |

### Posts (JWT required)

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/posts/create-post` | Create a new post |
| `GET` | `/v1/posts/all-posts` | Get paginated posts (cached) |
| `GET` | `/v1/posts/:id` | Get single post by ID (cached) |
| `DELETE` | `/v1/posts/:id` | Delete own post |

### Media (JWT required)

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/media/upload` | Upload file to Cloudinary |
| `GET` | `/v1/media/:id` | Get media metadata by ID |
| `GET` | `/v1/media/` | Get all media |

### Search (JWT required)

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/search?query=...` | Full-text search over posts |

---

## Authentication & Authorization Flow

The platform uses a **dual-token strategy**:

```
ACCESS TOKEN                    REFRESH TOKEN
─────────────────────────────   ─────────────────────────────────
JWT, signed with JWT_SECRET     Opaque 40-byte random hex string
Expires in 60 minutes           Expires in 7 days
Stateless — verified anywhere   Stateful — stored in MongoDB
Carries: userId, username       Used only to get a new token pair
Verified by: API Gateway        Rotated on every use
```

### Token Lifecycle

```
Register/Login
      │
      ▼
Identity Service
  ├─ jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: "60m" })
  └─ crypto.randomBytes(40) → store in RefreshToken collection
      │
      ▼
Client stores both tokens
      │
      │  Every API request
      ▼
Authorization: Bearer <accessToken>
      │
      ▼
API Gateway validateToken middleware
  ├─ jwt.verify(token, JWT_SECRET)
  ├─ Attach decoded user to req.user
  └─ Inject x-user-id header into proxied request
      │
      │  When access token expires
      ▼
POST /v1/auth/refresh-token { refreshToken }
  ├─ Lookup token in MongoDB
  ├─ Verify not expired
  ├─ Generate new token pair
  ├─ Delete old refresh token
  └─ Return new { accessToken, refreshToken }
```

### Security Notes

- Login returns the same `"Invalid credentials"` for both user-not-found and wrong-password — prevents user enumeration
- `findOneAndDelete({ _id, user: req.user.userId })` on delete ensures users can only delete their own posts
- JWT secret is shared only between Identity Service and API Gateway — other services never verify tokens themselves

---

## Rate Limiting Architecture

Multiple layers of rate limiting protect the platform:

| Location | Library | Limit | Scope | Target |
|---|---|---|---|---|
| API Gateway | `express-rate-limit` + Redis | 50 req / 15 min | All routes | General abuse |
| Identity Service | `rate-limiter-flexible` | 10 req / 1 sec | All routes | DDoS / burst |
| Identity Service | `express-rate-limit` + Redis | 50 req / 15 min | `/register` only | Account farming |
| Post Service | `rate-limiter-flexible` | 10 req / 1 sec | All routes | DDoS / burst |
| Post Service | `express-rate-limit` + Redis | 15 req / 15 min | `/create-post` | Spam (defined, inactive) |
| Post Service | `express-rate-limit` + Redis | 20 req / 15 min | `/all-posts` | Scraping (defined, inactive) |

All Redis-backed limiters share counts across multiple service instances, making them safe for horizontal scaling.

---

## RabbitMQ Event Bus

### Exchange

```
Name     : facebook-post
Type     : topic
Durable  : false (events lost on broker restart)
```

### Events

| Routing Key | Published By | Consumed By | Payload |
|---|---|---|---|
| `post-created` | Post Service | Search Service | `{ postId, userId, content, createdAt }` |
| `post-delete` | Post Service | Media Service, Search Service | `{ postId, mediaIds, userId }` |

### Consumer Pattern

All consumers use exclusive, auto-delete queues — they are not durable and disappear when the service disconnects. This is appropriate for read-model sync (Search) and cleanup tasks (Media) where replaying old events on restart is not required.

---

## Caching Strategy (Redis)

The Post Service uses Redis as a **read-through cache** with explicit invalidation on writes.

| Cache Key | TTL | Set on | Invalidated on |
|---|---|---|---|
| `post:<postId>` | 3600s | `GET /posts/:id` (miss) | Post create / delete |
| `posts:<page>:<limit>` | 300s | `GET /all-posts` (miss) | Post create / delete |

Invalidation deletes the specific post key plus all `posts:*` paginated keys, ensuring list caches never serve stale data after a write.

---

## Event-Driven Data Flows

### Creating a Post

```
Client → API Gateway → Post Service
  1. Validate JWT (gateway)
  2. Validate request body (Joi)
  3. Post.save() → MongoDB
  4. publishEvent("post-created", { postId, userId, content, createdAt })
  5. invalidatePostCache() → Redis

RabbitMQ → Search Service
  6. handlePostCreate(event)
  7. Search.save({ postId, userId, content, createdAt }) → MongoDB
     (now queryable via full-text search)
```

### Deleting a Post

```
Client → API Gateway → Post Service
  1. Validate JWT (gateway)
  2. findOneAndDelete({ _id, user: req.user.userId }) → MongoDB
  3. publishEvent("post-delete", { postId, mediaIds, userId })
  4. invalidatePostCache() → Redis

RabbitMQ → Media Service
  5. handlePostDelete(event)
  6. Delete media files from Cloudinary (by publicId)
  7. Media.deleteMany({ postId }) → MongoDB

RabbitMQ → Search Service
  8. handlePostDelete(event)
  9. Search.findOneAndDelete({ postId }) → MongoDB
     (removed from search index)
```

### Uploading Media

```
Client → API Gateway → Media Service
  1. Validate JWT (gateway)
  2. Multer parses multipart/form-data (parseReqBody: false in gateway)
  3. uploadMediaToCloudinary(req.file) → Cloudinary
  4. Media.save({ publicId, url, userId, ... }) → MongoDB
  5. Return { mediaId, url }

Client uses mediaId when creating a post:
  POST /v1/posts/create-post { content, mediaIds: [mediaId] }
```

---

## Data Models

### User (Identity Service)

```
{
  _id        : ObjectId
  username   : String (unique)
  email      : String (unique)
  password   : String (bcrypt hashed)
}
```

### RefreshToken (Identity Service)

```
{
  _id        : ObjectId
  token      : String  (80-char hex)
  user       : ObjectId (ref: User)
  expiresAt  : Date    (7 days from issuance)
}
```

### Post (Post Service)

```
{
  _id       : ObjectId
  user      : ObjectId
  content   : String
  mediaIds  : [String]
  createdAt : Date
  updatedAt : Date
}
```

### Media (Media Service)

```
{
  _id          : ObjectId
  publicId     : String  (Cloudinary public_id — used for deletion)
  originalName : String
  mimeType     : String
  userId       : String
  url          : String  (Cloudinary CDN URL)
  createdAt    : Date
}
```

### Search (Search Service)

```
{
  _id       : ObjectId
  postId    : String  (plain string reference, not a DB foreign key)
  userId    : String
  content   : String  (text-indexed for MongoDB $text search)
  createdAt : Date
}
```

---

## Service Startup Dependencies

Each service must establish certain connections before accepting traffic:

| Service | Required before listen | Fails if missing |
|---|---|---|
| API Gateway | Redis connection | Silent (rate limiter degraded) |
| Identity Service | RabbitMQ not required | — |
| Post Service | RabbitMQ | `process.exit(1)` |
| Media Service | RabbitMQ | `process.exit(1)` |
| Search Service | RabbitMQ | `process.exit(1)` |

MongoDB connects in parallel for all services and does not block startup.

---

## Logging (Winston)

All five services use an identical Winston logger configuration:

| Transport | Format | Level filter |
|---|---|---|
| Console | colorized, simple | All levels |
| `error-log` file | JSON + timestamp | `error` only |
| `combined.log` file | JSON + timestamp | All levels |

Log level is `info` in production, `debug` in development (via `NODE_ENV`).

Every log entry includes a `service` tag (e.g. `"service": "api-gateway"`) for easy filtering in aggregated log systems.

---

## Environment Variables

| Variable | Gateway | Identity | Post | Media | Search |
|---|---|---|---|---|---|
| `PORT` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `MONGODB_URL` | — | ✅ | ✅ | ✅ | ✅ |
| `REDIS_URL` | ✅ | ✅ | ✅ | — | — |
| `RABBITMQ_URL` | — | — | ✅ | ✅ | ✅ |
| `JWT_SECRET` | ✅ | ✅ | ✅ | — | — |
| `IDENTITY_SERVICE_URL` | ✅ | — | — | — | — |
| `POST_SERVICE_URL` | ✅ | — | — | — | — |
| `MEDIA_SERVICE_URL` | ✅ | — | — | — | — |
| `SEARCH_SERVICE_URL` | ✅ | — | — | — | — |
| `CLOUDINARY_*` | — | — | — | ✅ | — |
| `NODE_ENV` | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Security Summary

| Layer | Mechanism | Applied At |
|---|---|---|
| HTTP security headers | `helmet` | All services |
| CORS | `cors` | All services |
| DDoS / burst protection | `rate-limiter-flexible` (Redis) | Identity, Post |
| Endpoint rate limiting | `express-rate-limit` (Redis) | Gateway, Identity, Post |
| Authentication | JWT (RS/HS256, 60 min expiry) | Gateway (verifies), Identity (issues) |
| Session management | Rotating opaque refresh tokens (7 day) | Identity |
| Authorization | Ownership check via `req.user.userId` | Post (delete) |
| File passthrough | `parseReqBody: false` | Gateway → Media |
| Input validation | Joi schemas | Identity, Post |
| Error messages | Generic messages for sensitive paths | Identity (login) |

---

## Known Gaps / Future Improvements

| Area | Current State | Recommendation |
|---|---|---|
| Media rate limiting | None | Add `RateLimiterRedis` + `sensitiveEndpointsLimiter` |
| Search rate limiting | None | Add `RateLimiterRedis` |
| Post endpoint limiters | Defined but commented out | Enable `sensitiveCreatePostEndpointsLimiter` and `sensitiveGetPostsEndpointsLimiter` |
| RabbitMQ durability | Exchange is `durable: false` | Set `durable: true` and use durable queues for production |
| Search service auth | No JWT verification in service | Add `authenticateRequest` middleware (currently handled only at gateway) |
| Pagination on search | Hard-coded `limit(10)` | Add `page`/`limit` query params |
| Media deletion on logout | Refresh token deleted, media stays | No action needed — media tied to posts, cleaned on post delete |

---

## Repository Structure

```
/
├── api-gateway/
│   ├── server.js
│   ├── middleware/
│   │   ├── authMiddleware.js
│   │   └── errorHandler.js
│   └── utils/
│       └── logger.js
│
├── identity-service/
│   ├── server.js
│   ├── routes/identity-service.js
│   ├── controllers/authController.js
│   ├── middleware/errorHandler.js
│   ├── models/
│   │   ├── User.js
│   │   └── RefreshToken.js
│   └── utils/
│       ├── logger.js
│       ├── generateToken.js
│       └── validation.js
│
├── post-service/
│   ├── server.js
│   ├── routes/post-routes.js
│   ├── controllers/post-controller.js
│   ├── middleware/
│   │   ├── authMiddleware.js
│   │   └── errorHandler.js
│   ├── models/Post.js
│   └── utils/
│       ├── logger.js
│       ├── rabbitmq.js
│       └── validation.js
│
├── media-service/
│   ├── server.js
│   ├── routes/media-routes.js
│   ├── controllers/mediaController.js
│   ├── eventHandlers/media-event-handler.js
│   ├── middleware/errorHandler.js
│   ├── models/Media.js
│   └── utils/
│       ├── logger.js
│       ├── cloudinary.js
│       └── rabbitmq.js
│
└── search-service/
    ├── server.js
    ├── routes/search-routes.js
    ├── controllers/search-controller.js
    ├── handlers/search-event-handler.js
    ├── middleware/errorHandler.js
    ├── models/Search.js
    └── utils/
        ├── logger.js
        └── rabbitmq.js
```
