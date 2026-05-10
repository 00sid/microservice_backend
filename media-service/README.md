# Media Service

## Overview

The Media Service handles **file uploads**, **media retrieval**, and **media cleanup** in the microservices architecture. It accepts files from authenticated clients (via the API Gateway), uploads them to **Cloudinary** for CDN-backed storage, and persists metadata to **MongoDB**. It also listens to **RabbitMQ** events from the Post Service to automatically delete orphaned media when a post is removed.

---

## Architecture

```
API Gateway (/v1/media/*)
        │
        │  x-user-id header injected by gateway
        │  multipart/form-data passed through (parseReqBody: false)
        ▼
┌──────────────────────────────────────────────────────┐
│                   Media Service                      │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  Helmet  │  │   CORS   │  │  Request Logger   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │              Route Handlers                   │   │
│  │  POST   /api/media/upload                     │   │
│  │  GET    /api/media/:id                        │   │
│  │  GET    /api/media/                           │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │         RabbitMQ Event Consumer               │   │
│  │  Exchange : facebook-post (topic)             │   │
│  │  Listens  : post-delete routing key           │   │
│  │  Handler  : handlePostDelete                  │   │
│  └───────────────────────────────────────────────┘   │
└───────────┬───────────────────────┬──────────────────┘
            │                       │
            ▼                       ▼
        MongoDB                Cloudinary
    (Media metadata)         (File storage/CDN)
```

---

## Startup Sequence

The server does **not** start listening until RabbitMQ is connected and event consumers are registered. If RabbitMQ fails, the process exits.

```
startServer()
     │
     ▼
[1] connectTORabbitMq()
     │  Assert exchange "facebook-post" (topic, non-durable)
     │  ✗ Failure → logger.error → process.exit(1)
     │
     ▼
[2] consumeEvent("post-delete", handlePostDelete)
     │  Creates exclusive, auto-delete queue
     │  Binds queue to exchange with routing key "post-delete"
     │
     ▼
[3] app.listen(PORT)
     │
     ▼
[4] MongoDB connects (parallel, non-blocking)
```

---

## Request Lifecycle (File Upload)

```
Client (multipart/form-data)
     │
     ▼
API Gateway
  └─ Validates JWT
  └─ Injects x-user-id header
  └─ Streams body unchanged (parseReqBody: false)
     │
     ▼
Media Service
     │
     ▼
[1] Helmet / CORS / Request Logger
     │
     ▼
[2] Multer (memory storage)     ← parses multipart, populates req.file
     │
     ▼
[3] uploadMedia controller
     │
     ├─ Check req.file exists        → 400 if missing
     │
     ├─ uploadMediaToCloudinary()    → streams buffer to Cloudinary
     │     └─ returns { public_id, secure_url }
     │
     ├─ new Media({ publicId, originalName, mimeType, userId, url })
     │     └─ Media.save() → MongoDB
     │
     └─ 201 { mediaId, url }
```

---

## RabbitMQ Integration

### Exchange Configuration

| Property | Value |
|---|---|
| Exchange name | `facebook-post` |
| Type | `topic` |
| Durable | `false` (non-persistent, lost on broker restart) |

### Event: `post-delete`

When the Post Service deletes a post, it publishes a `post-delete` event. The Media Service subscribes to this event and cleans up any associated media.

```
Post Service                RabbitMQ                 Media Service
     │                          │                          │
     │── publish("post-delete", │                          │
     │    { postId, mediaIds }) ──────────────────────────►│
     │                          │                          │
     │                          │    handlePostDelete()    │
     │                          │  └─ delete media from    │
     │                          │     Cloudinary           │
     │                          │  └─ delete Media docs    │
     │                          │     from MongoDB         │
```

### Consumer Pattern

```
consumeEvent(routingKey, callback)
  │
  ├─ assertQueue("", { exclusive: true })   ← anonymous, auto-deleted queue
  ├─ bindQueue(queue, "facebook-post", routingKey)
  └─ channel.consume(queue, (msg) => {
         content = JSON.parse(msg.content)
         callback(content)
         channel.ack(msg)          ← explicit acknowledgement
     })
```

Exclusive queues are auto-deleted when the connection closes — appropriate for event-driven cleanup consumers that don't need message durability.

---

## API Endpoints

### `POST /api/media/upload`

Uploads a file to Cloudinary and saves metadata to MongoDB.

**Headers** (injected by API Gateway)
```
x-user-id: <userId>
Content-Type: multipart/form-data
```

**Body** — `multipart/form-data` with a `file` field

**Response `201`**
```json
{
  "success": true,
  "message": "Media uploaded successfully!",
  "mediaId": "<mongo_object_id>",
  "url": "https://res.cloudinary.com/..."
}
```

**Errors**

| Status | Reason |
|---|---|
| `400` | No file attached to request |
| `500` | Cloudinary upload failed or DB error |

---

### `GET /api/media/:id`

Retrieves metadata for a single media item by its MongoDB ID.

**Response `200`**
```json
{
  "success": true,
  "mediaUrl": "https://res.cloudinary.com/...",
  "createdBy": "<userId>"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400` | No `id` param provided |
| `404` | Media not found in DB |
| `500` | Internal server error |

---

### `GET /api/media/`

Returns all media records.

**Response `200`**
```json
{
  "success": true,
  "medias": [ { ...mediaDocument }, ... ]
}
```

---

## Sequence Diagrams

### Upload Media

```
Client       API Gateway      Media Service     Cloudinary      MongoDB
  │               │                 │                │              │
  │─ POST /upload ►                 │                │              │
  │               │─ validate JWT   │                │              │
  │               │─ inject x-user-id               │              │
  │               │─ stream body ──►                 │              │
  │               │                 │                │              │
  │               │          multer parses file       │              │
  │               │                 │── upload ──────►              │
  │               │                 │◄── { public_id, url } ────────│
  │               │                 │                │              │
  │               │                 │── Media.save() ───────────────►
  │               │                 │◄── saved ─────────────────────│
  │               │                 │                │              │
  │◄──────────── 201 { mediaId, url } ──────────────────────────────│
```

---

### Post Deleted → Media Cleanup

```
Post Service      RabbitMQ ("facebook-post")     Media Service     Cloudinary    MongoDB
     │                        │                        │                │            │
     │── publish("post-delete", { mediaIds }) ────────►│                │            │
     │                        │                        │                │            │
     │                        │          handlePostDelete(event)        │            │
     │                        │                        │── delete ──────►            │
     │                        │                        │── Media.deleteMany() ───────►
     │                        │                        │◄── done ───────────────────│
```

---

## Data Model

### Media

```
{
  _id          : ObjectId
  publicId     : String    (Cloudinary public_id — used for deletion)
  originalName : String    (original filename from client)
  mimeType     : String    (e.g. "image/jpeg", "video/mp4")
  userId       : String    (from x-user-id header, set by API Gateway)
  url          : String    (Cloudinary secure_url — CDN link)
  createdAt    : Date      (via timestamps)
  updatedAt    : Date      (via timestamps)
}
```

---

## Cloudinary Integration

The `uploadMediaToCloudinary(file)` utility receives the `req.file` object from Multer (buffer in memory) and streams it to Cloudinary. Returns `{ public_id, secure_url }` on success.

```
uploadMediaToCloudinary(req.file)
  │
  ├─ Read file buffer from Multer memory storage
  ├─ Upload to Cloudinary (upload_stream or buffer upload)
  └─ Return { public_id, secure_url }
```

The `public_id` is stored in MongoDB so that the `handlePostDelete` event handler can reference and delete the file from Cloudinary when a post is removed.

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Service port (default: `3003`) |
| `MONGODB_URL` | MongoDB connection string |
| `RABBITMQ_URL` | RabbitMQ connection string (AMQP) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |
| `NODE_ENV` | `production` or `development` |

---

## Error Handling

| Layer | Behavior |
|---|---|
| Missing file | Controller returns `400` immediately |
| Cloudinary failure | Caught in try/catch → `500` |
| MongoDB failure | Caught in try/catch → `500` |
| RabbitMQ startup failure | `process.exit(1)` — service won't start broken |
| Unhandled rejections | Caught globally via `process.on("unhandledRejection")`, logged |
| All other errors | Bubble to global `errorHandler` middleware → `500` |

---

## File Structure

```
media-service/
├── server.js                          # Entry point + startup sequence
├── routes/
│   └── media-routes.js                # Route definitions
├── controllers/
│   └── mediaController.js             # uploadMedia, getMedia, getAllMedia
├── eventHandlers/
│   └── media-event-handler.js         # handlePostDelete
├── middleware/
│   └── errorHandler.js                # Global error handler
├── models/
│   └── Media.js                       # Media schema
├── utils/
│   ├── logger.js                      # Winston logger
│   ├── cloudinary.js                  # Cloudinary upload helper
│   └── rabbitmq.js                    # connectTORabbitMq, publishEvent, consumeEvent
└── .env
```
