# Search Service

## Overview

The Search Service provides **full-text search** over posts. Rather than querying the Post Service directly, it maintains its own **search-optimized index** in MongoDB, kept in sync via **RabbitMQ events**. When a post is created or deleted in the Post Service, the Search Service reacts to those events and updates its index — a classic **event-driven read model** (CQRS-lite) pattern.

---

## Architecture

```
API Gateway (/v1/search/*)
        │
        │  x-user-id header injected by gateway
        │  JWT validated by gateway
        ▼
┌────────────────────────────────────────────────────────┐
│                   Search Service                       │
│                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐ │
│  │  Helmet  │  │   CORS   │  │   Request Logger     │ │
│  └──────────┘  └──────────┘  └──────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Route Handler                       │  │
│  │  GET  /api/search?query=...                      │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │         RabbitMQ Event Consumers                 │  │
│  │  post-created → handlePostCreate                 │  │
│  │  post-delete  → handlePostDelete                 │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
                       MongoDB
                  (Search index collection)
```

---

## How the Search Index Works

The Search Service does **not** query the Post Service's database. It owns a separate `Search` collection that mirrors post content optimized for text search. This index is kept in sync entirely through events:

```
Post Service                                Search Service
     │                                            │
     │  [User creates post]                       │
     │── publish("post-created", { postId,        │
     │    userId, content, createdAt }) ──────────►│
     │                                  handlePostCreate()
     │                                  Search.save({ postId, content, ... })
     │                                            │
     │  [User deletes post]                       │
     │── publish("post-delete", { postId }) ──────►│
     │                                  handlePostDelete()
     │                                  Search.findOneAndDelete({ postId })
```

This approach means:
- Search queries never touch the Post Service or its DB
- The search index can be scaled, tuned, or rebuilt independently
- Post Service and Search Service are fully decoupled

---

## Startup Sequence

The server registers **two** RabbitMQ consumers before accepting HTTP traffic.

```
startServer()
     │
     ▼
[1] connectTORabbitMq()
     │  Assert exchange "facebook-post" (topic, non-durable)
     │  ✗ Failure → logger.error → process.exit(1)
     │
     ▼
[2] consumeEvent("post-created", handlePostCreate)
     │  Exclusive queue bound to routing key "post-created"
     │
     ▼
[3] consumeEvent("post-delete", handlePostDelete)
     │  Exclusive queue bound to routing key "post-delete"
     │
     ▼
[4] app.listen(PORT)
     │
     ▼
[5] MongoDB connects (parallel, non-blocking)
```

---

## Middleware Stack

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
[5] Route Handler       → searchPostController
      │
      ▼
[6] Error Handler       → Global catch-all → 500
```

> Note: Unlike the Post and Identity services, the Search Service has **no rate limiting** currently implemented. This is a natural place to add protection as the service grows.

---

## RabbitMQ Event Consumers

### Exchange Configuration

| Property | Value |
|---|---|
| Exchange name | `facebook-post` |
| Type | `topic` |
| Durable | `false` |

### Events Consumed

| Routing Key | Handler | Action |
|---|---|---|
| `post-created` | `handlePostCreate` | Insert new document into Search collection |
| `post-delete` | `handlePostDelete` | Delete document from Search collection by `postId` |

### Consumer Pattern

Each call to `consumeEvent` creates a separate **exclusive, auto-delete queue**:

```
consumeEvent(routingKey, callback)
  │
  ├─ assertQueue("", { exclusive: true })   ← anonymous queue, auto-deleted on disconnect
  ├─ bindQueue(queue, "facebook-post", routingKey)
  └─ channel.consume(queue, (msg) => {
         content = JSON.parse(msg.content)
         callback(content)                  ← handler runs async
         channel.ack(msg)                   ← explicit ack
     })
```

---

## Event Handlers

### `handlePostCreate(event)`

```
Event payload:
{
  postId    : string
  userId    : string
  content   : string
  createdAt : ISO date string
}

Steps:
  1. new Search({ postId, userId, content, createdAt })
  2. Search.save()
  3. Log: "Search post created: <postId>"
```

### `handlePostDelete(event)`

```
Event payload:
{
  postId  : string
  ...
}

Steps:
  1. Search.findOneAndDelete({ postId: event.postId })
  2. Log: "Search post deleted: <postId>"
```

---

## API Endpoint

### `GET /api/search?query=<text>`

Performs a **MongoDB full-text search** across the `Search` collection, ranked by relevance score.

**Query Params**

| Param | Required | Description |
|---|---|---|
| `query` | ✅ | The search string |

**Response `200`**
```json
[
  {
    "_id": "<searchDocId>",
    "postId": "<postId>",
    "userId": "<userId>",
    "content": "Hello world this is a post",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "score": 1.5
  },
  ...
]
```

Results are limited to **10**, sorted by **text relevance score** (highest first).

**Errors**

| Status | Reason |
|---|---|
| `500` | DB query failed |

---

## Full-Text Search Implementation

MongoDB's `$text` operator is used with a text index on the `content` field:

```javascript
Search.find(
  { $text: { $search: query } },         // filter: full-text match
  { score: { $meta: "textScore" } }      // projection: include relevance score
)
.sort({ score: { $meta: "textScore" } }) // sort: best match first
.limit(10)                               // cap at 10 results
```

For this to work, the `Search` model requires a **text index** on the `content` field:

```javascript
// In Search model (models/Search.js)
SearchSchema.index({ content: "text" });
```

---

## Sequence Diagrams

### Search Request

```
Client       API Gateway      Search Service      MongoDB
  │               │                 │                 │
  │─ GET /search?query=hello ───────►                 │
  │               │─ validate JWT   │                 │
  │               │─ inject userId ─►                 │
  │               │                 │                 │
  │               │          $text search ────────────►
  │               │                 │◄── results ──────
  │               │                 │  sort by score   │
  │               │                 │  limit 10        │
  │◄──────────── 200 [results] ─────│                 │
```

---

### Post Created → Index Updated

```
Post Service      RabbitMQ ("facebook-post")     Search Service      MongoDB
     │                        │                        │                 │
     │── publish("post-created", {                     │                 │
     │    postId, userId,                              │                 │
     │    content, createdAt }) ──────────────────────►│                 │
     │                        │                        │                 │
     │                        │          handlePostCreate(event)         │
     │                        │                        │── Search.save() ►
     │                        │                        │◄── saved ────────
```

---

### Post Deleted → Index Cleaned

```
Post Service      RabbitMQ ("facebook-post")     Search Service      MongoDB
     │                        │                        │                 │
     │── publish("post-delete", { postId }) ──────────►│                 │
     │                        │                        │                 │
     │                        │          handlePostDelete(event)         │
     │                        │                        │── findOneAndDelete({ postId }) ──►
     │                        │                        │◄── deleted ──────────────────────
```

---

## Data Model

### Search

```
{
  _id       : ObjectId
  postId    : String     (reference to Post Service — not a DB foreign key)
  userId    : String     (owner of the post)
  content   : String     (indexed with MongoDB text index)
  createdAt : Date       (from original post creation time)
}
```

The `postId` field is a plain string reference (not a `ref:` ObjectId) since the Search Service has no direct DB relationship with the Post Service — it only knows about posts via events.

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Service port (default: `3004`) |
| `MONGODB_URL` | MongoDB connection string |
| `RABBITMQ_URL` | RabbitMQ connection string (AMQP) |
| `NODE_ENV` | `production` or `development` |

> No `JWT_SECRET` or `REDIS_URL` needed — JWT validation is done by the API Gateway, and this service has no caching layer.

---

## Comparison: Search Service vs Other Services

| Feature | Identity | Post | Media | Search |
|---|---|---|---|---|
| Own DB | ✅ | ✅ | ✅ | ✅ |
| Redis cache | ❌ | ✅ | ❌ | ❌ |
| Publishes events | ❌ | ✅ | ❌ | ❌ |
| Consumes events | ❌ | ❌ | ✅ (`post-delete`) | ✅ (`post-created`, `post-delete`) |
| Rate limiting | ✅ (2 layers) | ✅ (2 layers) | ❌ | ❌ |
| File storage | ❌ | ❌ | ✅ (Cloudinary) | ❌ |
| JWT verification | ✅ (issues) | ✅ (verifies) | ✅ (via gateway) | ✅ (via gateway) |

---

## File Structure

```
search-service/
├── server.js                          # Entry point + startup sequence
├── routes/
│   └── search-routes.js               # Route definitions
├── controllers/
│   └── search-controller.js           # searchPostController
├── handlers/
│   └── search-event-handler.js        # handlePostCreate, handlePostDelete
├── middleware/
│   └── errorHandler.js                # Global error handler
├── models/
│   └── Search.js                      # Search schema (with text index)
├── utils/
│   ├── logger.js                      # Winston logger
│   └── rabbitmq.js                    # connectTORabbitMq, consumeEvent
└── .env
```
