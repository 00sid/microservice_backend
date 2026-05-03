// require("dotenv").config();

// const mongoose = require("mongoose");
// const logger = require("./utils/logger");
// const express = require("express");
// const helmet = require("helmet");
// const cors = require("cors");
// const Redis = require("ioredis");
// const postRoutes = require("./routes/post-routes");
// const errorHandler = require("./middleware/errorHandler");
// const { RateLimiterRedis } = require("rate-limiter-flexible");
// const { rateLimit } = require("express-rate-limit");
// const { RedisStore } = require("rate-limit-redis");
// const app = express();

// const PORT = process.env.PORT || 3002;
// // connect to mongodb
// mongoose
//   .connect(process.env.MONGODB_URL)
//   .then(() => {
//     logger.info("Connected to MongoDB");
//   })
//   .catch((e) => {
//     logger.info("MongoDB connection error", e);
//   });

// const redisClient = new Redis(process.env.REDIS_URL);
// //   middlewares

// app.use(helmet());
// app.use(cors());
// app.use(express.json());

// app.use((req, res, next) => {
//   logger.info(`Received ${req.method} request to ${req.url}`);
//   logger.info(`Request body ${req.body}`);
//   next();
// });

// // / DDOS protection and rate limiter

// const rateLimiter = new RateLimiterRedis({
//   storeClient: redisClient,
//   keyPrefix: "middleware",
//   points: 10, //10 request in 1 sec
//   duration: 1,
// });

// app.use((req, res, next) => {
//   rateLimiter
//     .consume(req.ip)
//     .then(() => next())
//     .catch((e) => {
//       logger.warn(`Rate limit exceeded for IP: ${req.ip}`);

//       return res.status(429).json({
//         success: false,
//         message: "To many requests.",
//       });
//     });
// });

// // Ip based rate limiting for sensitive endpoints

// const sensitiveCreatePostEndpointsLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 15,
//   standardHeaders: true,
//   legacyHeaders: false,
//   handler: (req, res) => {
//     logger.warn(`Sensitive endpoint rate limit exceed for IP: ${req.ip}`);
//     res.status(429).json({
//       success: false,
//       message: "To many requests.",
//     });
//   },
//   store: new RedisStore({
//     sendCommand: (...args) => redisClient.call(...args),
//   }),
// });

// app.use(
//   "api/posts",
//   (req, res, next) => {
//     req.redisClient = redisClient;
//     next();
//   },
//   postRoutes,
// );
// const sensitiveGetPostsEndpointsLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 20,
//   standardHeaders: true,
//   legacyHeaders: false,
//   handler: (req, res) => {
//     logger.warn(`Sensitive endpoint rate limit exceed for IP: ${req.ip}`);
//     res.status(429).json({
//       success: false,
//       message: "To many requests.",
//     });
//   },
//   store: new RedisStore({
//     sendCommand: (...args) => redisClient.call(...args),
//   }),
// });

// app.use("/api/posts/create-post", sensitiveCreatePostEndpointsLimiter);
// app.use("/api/posts/get-all-posts", sensitiveGetPostsEndpointsLimiter);

// // routes

// app.use(
//   "/api/posts",
//   (req, res, next) => {
//     req.redisClient = redisClient;
//     next();
//   },
//   postRoutes,
// );

// app.use(errorHandler);

// app.listen(PORT, () => {
//   logger.info(`Post service running on port ${PORT}`);
// });

// // unhandled promise rejection

// process.on("unhandledRejection", (reason, promise) => {
//   logger.error("Unhandled rejection at", promise, "reason:", reason);
// });

// Load environment variables from .env file
require("dotenv").config();

// Import required dependencies
const mongoose = require("mongoose"); // MongoDB ORM
const logger = require("./utils/logger"); // Custom logger
const express = require("express"); // Web framework
const helmet = require("helmet"); // Security headers
const cors = require("cors"); // Cross-origin requests
const Redis = require("ioredis"); // Redis client
const postRoutes = require("./routes/post-routes"); // Post-related routes
const errorHandler = require("./middleware/errorHandler"); // Global error handler

// Rate limiting libraries
const { RateLimiterRedis } = require("rate-limiter-flexible");
const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");

// Initialize Express app
const app = express();

// Set server port
const PORT = process.env.PORT || 3002;

// ----------------------
// MongoDB Connection
// ----------------------
mongoose
  .connect(process.env.MONGODB_URL)
  .then(() => {
    logger.info("Connected to MongoDB");
  })
  .catch((e) => {
    logger.error("MongoDB connection error", e);
  });

// ----------------------
// Redis Connection
// ----------------------
const redisClient = new Redis(process.env.REDIS_URL);

// ----------------------
// Global Middlewares
// ----------------------
app.use(helmet()); // Adds security headers
app.use(cors()); // Enables CORS
app.use(express.json()); // Parses JSON request bodies

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`Received ${req.method} request to ${req.url}`);
  logger.info(`Request body: ${JSON.stringify(req.body)}`); // safer logging
  next();
});

// ----------------------
// Global Rate Limiter (DDoS Protection)
// ----------------------
const rateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: "middleware",
  points: 10, // Max 10 requests
  duration: 1, // Per second
});

app.use((req, res, next) => {
  rateLimiter
    .consume(req.ip) // Limit based on IP
    .then(() => next())
    .catch(() => {
      logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
      return res.status(429).json({
        success: false,
        message: "Too many requests.",
      });
    });
});

// ----------------------
// Rate Limiter for Creating Posts (Sensitive)
// ----------------------
const sensitiveCreatePostEndpointsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Max 15 requests
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Create post limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: "Too many requests.",
    });
  },
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  }),
});

// ----------------------
// Rate Limiter for Fetching Posts
// ----------------------
const sensitiveGetPostsEndpointsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Get posts limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: "Too many requests.",
    });
  },
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  }),
});

// Apply specific rate limiters to endpoints
// app.use("/api/posts/create-post", sensitiveCreatePostEndpointsLimiter);
app.use("/api/posts/get-all-posts", sensitiveGetPostsEndpointsLimiter);

// ----------------------
// Routes
// ----------------------

// Attach Redis client to request object for use in routes
app.use(
  "/api/posts",
  (req, res, next) => {
    req.redisClient = redisClient;
    next();
  },
  postRoutes,
);

// ----------------------
// Global Error Handler
// ----------------------
app.use(errorHandler);

// ----------------------
// Start Server
// ----------------------
app.listen(PORT, () => {
  logger.info(`Post service running on port ${PORT}`);
});

// ----------------------
// Handle Unhandled Promise Rejections
// ----------------------
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled rejection at:", promise, "reason:", reason);
});
