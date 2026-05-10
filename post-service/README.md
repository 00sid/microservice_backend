# Post Service

## Overview

The Post Service manages the **creation**, **retrieval**, and **deletion** of posts. It integrates with **Redis** for response caching and cache invalidation, **RabbitMQ** to publish domain events consumed by other services (Search, Media), and **MongoDB** for persistent post storage. All routes require authentication via a JWT passed from the API Gateway.

---

## Architecture

```
API Gateway (/v1/posts/*)
        │
        │  x-user-id header injected by gateway
        │  JWT in Authorization header
        ▼
┌────────────────────────────────────────────────────────┐
│                     Post Service                       │
│                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐ │
│  │  Helmet  │  │   CORS   │  │   Request Logger     │ │
│  └──────────┘  └──────────┘  └──────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │     DDoS Rate Limiter (RateLimiterRedis)         │  │
│  │     10 req / sec per IP                          │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Redis client attached to req.redisClient        │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │     Auth Middleware (JWT verification)           │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Route Handlers                      │  │
│  │  POST   /api/posts/create-post                   │  │
│  │  GET    /api/posts/all-posts                     │  │
│  │  GET    /api/posts/:id                           │  │
│  │  DELETE /api/posts/:id                           │  │
│  └──────────────────────────────────────────────────┘  │
└──────────┬──────────────────┬──────────────────────────┘
           │                  │
           ▼                  ▼
       MongoDB             Redis               RabbitMQ
    (Post documents)    (Response cache)   (Event publishing)
```

---

## Startup Sequence

Like the Media Service, the server waits for RabbitMQ before accepting traffic.

```
startServer()
     │
     ▼
[1] connectTORabbitMq()
     │  Assert exchange "facebook-post" (topic, non-durable)
     │  ✗ Failure → logger.error → process.exit(1)
     │
     ▼
[2] app.listen(PORT)
     │
     ▼
[3] MongoDB connects (parallel, non-blocking)
     │
     ▼
[4] Redis client ready (ioredis, non-blocking init)
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
[2] CORS
      │
      ▼
[3] express.json()      → Parse JSON body
      │
      ▼
[4] Request Logger      → Log method, URL, body
      │
      ▼
[5] DDoS Rate Limiter   → 10 req/sec per IP (RateLimiterRedis)
      │       ┌────────────────────────────────┐
      │       │ Exceeded → 429 Too Many Requests│
      │       └────────────────────────────────┘
      ▼
[6] req.redisClient     → Attach Redis client to request object
      │
      ▼
[7] authenticateRequest → Verify JWT (x-user-id → req.user)
      │       ┌──────────────────────────────┐
      │       │ Invalid/missing → 401         │
      │       └──────────────────────────────┘
      ▼
[8] Route Handler       → Controller logic
      │
      ▼
[9] Error Handler       → Global catch-all → 500
```

---

## Rate Limiting Strategy

| Layer | Library | Limit | Scope | Status |
|---|---|---|---|---|
| DDoS Protection | `rate-limiter-flexible` | 10 req / 1 sec | All routes, per IP | ✅ Active |
| Create Post Limiter | `express-rate-limit` | 15 req / 15 min | `/create-post` | ⚠️ Defined, commented out |
| Get Posts Limiter | `express-rate-limit` | 20 req / 15 min | `/all-posts` | ⚠️ Defined, commented out |

The per-endpoint limiters are implemented and ready to activate — uncomment to enable them.

---

## Caching Strategy (Redis)

Redis is used as a **read-through cache** for post queries and is **invalidated on write/delete**.

### Cache Keys

| Key Pattern | TTL | Content |
|---|---|---|
| `post:<postId>` | 3600s (1 hr) | Single post document |
| `posts:<page>:<limit>` | 300s (5 min) | Paginated post list + metadata |

### Cache Flow

```
GET /api/posts/:id
      │
      ├─ redisClient.get("post:<id>")
      │       ├─ HIT  → return cached JSON immediately
      │       └─ MISS → Post.findById(id)
      │                  └─ setex("post:<id>", 3600, result)
      │                  └─ return result

GET /api/posts/all-posts
      │
      ├─ redisClient.get("posts:<page>:<limit>")
      │       ├─ HIT  → return cached JSON immediately
      │       └─ MISS → Post.find().sort().skip().limit()
      │                  └─ setex("posts:<page>:<limit>", 300, result)
      │                  └─ return result
```

### Cache Invalidation (`invalidatePostCache`)

Called after **create** and **delete** operations:

```
invalidatePostCache(req, postId)
  │
  ├─ del("post:<postId>")            ← remove specific post cache
  └─ keys("posts:*") → del(all)      ← remove all paginated list caches
```

This ensures stale pagination results are never served after a write.

---

## RabbitMQ Events Published

The Post Service **publishes** events. It does not consume any.

| Event (Routing Key) | Trigger | Consumers |
|---|---|---|
| `post-created` | New post saved to DB | Search Service (index for search) |
| `post-delete` | Post deleted from DB | Media Service (cleanup media files) |

### `post-created` Payload

```json
{
  "postId": "<string>",
  "userId": "<string>",
  "content": "<string>",
  "createdAt": "<ISO date>"
}
```

### `post-delete` Payload

```json
{
  "postId": "<string>",
  "mediaIds": ["<mediaId>", ...],
  "userId": "<string>"
}
```

---

## API Endpoints

All routes require a valid JWT (`Authorization: Bearer <token>`).

### `POST /api/posts/create-post`

Creates a new post, publishes a `post-created` event, and invalidates post list caches.

**Request**
```json
{
  "content": "Hello world!",
  "mediaIds": ["<mediaId>"]
}
```

**Response `201`**
```json
{
  "success": true,
  "message": "Post Created Successfully!"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400` | Validation failure (Joi) |
| `500` | DB save or event publish failed |

---

### `GET /api/posts/all-posts`

Returns a paginated list of all posts, newest first. Served from Redis cache when available.

**Query Params**

| Param | Default | Description |
|---|---|---|
| `page` | `1` | Page number |
| `limit` | `10` | Results per page |

**Response `200`**
```json
{
  "posts": [...],
  "currentPage": 1,
  "totalPages": 5,
  "totalPosts": 47
}
```

---

### `GET /api/posts/:id`

Returns a single post by ID. Served from Redis cache when available (TTL: 1 hour).

**Response `200`**
```json
{
  "_id": "<postId>",
  "user": "<userId>",
  "content": "Hello world!",
  "mediaIds": [],
  "createdAt": "...",
  "updatedAt": "..."
}
```

**Errors**

| Status | Reason |
|---|---|
| `404` | Post not found |
| `500` | DB or cache error |

---

### `DELETE /api/posts/:id`

Deletes a post **owned by the requesting user**, publishes a `post-delete` event, and invalidates caches.

**Response `200`**
```json
{
  "success": true,
  "message": "Post deleted successfully!"
}
```

**Note:** Uses `findOneAndDelete({ _id, user: req.user.userId })` — a user cannot delete another user's post.

---

## Sequence Diagrams

### Create Post

```
Client       API Gateway      Post Service      MongoDB      RabbitMQ        Redis
  │               │                 │               │             │              │
  │─ POST /posts ─►                 │               │             │              │
  │               │─ validate JWT   │               │             │              │
  │               │─ inject userId ─►               │             │              │
  │               │            validate body        │             │              │
  │               │                 │── save() ─────►             │              │
  │               │                 │◄── saved ──────             │              │
  │               │                 │─ publish("post-created") ───►              │
  │               │                 │─ invalidatePostCache() ────────────────────►
  │               │                 │  del("post:<id>")                          │
  │               │                 │  del("posts:*")                            │
  │◄──────────── 201 ───────────────│               │             │              │
```

---

### Get All Posts (Cache Miss → Cache Fill)

```
Client       Post Service        Redis          MongoDB
  │                │               │               │
  │─ GET /all-posts ►              │               │
  │                │─ get("posts:1:10") ──────────►│
  │                │◄── null (miss) ───────────────│
  │                │                │               │
  │                │── Post.find().sort().skip() ───►
  │                │◄── posts ──────────────────────│
  │                │                │               │
  │                │── setex("posts:1:10", 300) ───►│
  │                │                │               │
  │◄── 200 result ─│               │               │
```

---

### Get All Posts (Cache Hit)

```
Client       Post Service        Redis
  │                │               │
  │─ GET /all-posts ►              │
  │                │─ get("posts:1:10") ──►
  │                │◄── cached JSON ───────
  │◄── 200 result ─│
```

---

### Delete Post

```
Client       API Gateway      Post Service      MongoDB      RabbitMQ        Redis
  │               │                 │               │             │              │
  │─ DELETE /:id ─►                 │               │             │              │
  │               │─ validate JWT ──►               │             │              │
  │               │           findOneAndDelete       │             │              │
  │               │           ({ _id, user }) ───────►            │              │
  │               │                 │◄── deleted ───              │              │
  │               │                 │─ publish("post-delete") ────►              │
  │               │                 │─ invalidatePostCache() ────────────────────►
  │◄──────────── 200 ───────────────│               │             │              │
```

---

## Data Model

### Post

```
{
  _id       : ObjectId
  user      : ObjectId   (ref: User — from JWT payload via x-user-id)
  content   : String     (post text, validated by Joi)
  mediaIds  : [String]   (optional array of Media service IDs)
  createdAt : Date       (via timestamps)
  updatedAt : Date       (via timestamps)
}
```

---

## Redis Client Injection Pattern

Rather than importing Redis globally into every controller, the service attaches the client to the request object in a middleware:

```javascript
app.use("/api/posts", (req, res, next) => {
  req.redisClient = redisClient;
  next();
}, postRoutes);
```

Controllers then access it via `req.redisClient`. This makes controllers easier to test (the client can be mocked via the request object) and keeps Redis as an infrastructure concern outside the controller layer.

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Service port (default: `3002`) |
| `MONGODB_URL` | MongoDB connection string |
| `REDIS_URL` | Redis connection string |
| `RABBITMQ_URL` | RabbitMQ connection string (AMQP) |
| `JWT_SECRET` | Secret for JWT verification (must match Identity Service) |
| `NODE_ENV` | `production` or `development` |

---

## File Structure

```
post-service/
├── server.js                          # Entry point + startup sequence
├── routes/
│   └── post-routes.js                 # Route definitions + auth middleware
├── controllers/
│   └── post-controller.js             # createPost, getAllPost, getPost, deletePost
├── middleware/
│   ├── authMiddleware.js              # JWT verification
│   └── errorHandler.js               # Global error handler
├── models/
│   └── Post.js                        # Post schema
├── utils/
│   ├── logger.js                      # Winston logger
│   ├── rabbitmq.js                    # connectTORabbitMq, publishEvent
│   └── validation.js                  # Joi validation schemas
└── .env
```
