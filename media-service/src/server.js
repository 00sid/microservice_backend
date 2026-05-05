require("dotenv").config();

// Import required dependencies
const mongoose = require("mongoose"); // MongoDB ORM
const logger = require("./utils/logger"); // Custom logger
const express = require("express"); // Web framework
const helmet = require("helmet"); // Security headers
const cors = require("cors"); // Cross-origin requests
const mediaRoutes = require("./routes/media-routes"); // Media-related routes
const errorHandler = require("./middleware/errorHandler"); // Global error handler

// Initialize Express app
const app = express();

// Set server port
const PORT = process.env.PORT || 3003;

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

// use protection like ratelimiting

//use routes

app.use("/api/media", mediaRoutes);

// ----------------------
// Global Error Handler
// ----------------------
app.use(errorHandler);

// ----------------------
// Start Server
// ----------------------
app.listen(PORT, () => {
  logger.info(`Media service running on port ${PORT}`);
});

// ----------------------
// Handle Unhandled Promise Rejections
// ----------------------
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled rejection at:", promise, "reason:", reason);
});
