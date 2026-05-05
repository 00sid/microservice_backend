// Load environment variables from .env file
require("dotenv").config();
// Import required dependencies
const mongoose = require("mongoose"); // MongoDB ORM
const logger = require("./utils/logger"); // Custom logger
const express = require("express"); // Web framework
const helmet = require("helmet"); // Security headers
const cors = require("cors"); // Cross-origin requests
const Redis = require("ioredis"); // Redis client
const errorHandler = require("./middleware/errorHandler"); // Global error handler
const searchRoutes = require("./routes/search-routes");
const { handlePostCreate } = require("./handlers/search-event-handler");

// Initialize Express app
const app = express();

// Set server port
const PORT = process.env.PORT || 3004;

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

app.use("/api/search", searchRoutes);

app.use(errorHandler);

// ----------------------
// Start Server
// ----------------------
async function startServer() {
  try {
    await connectTORabbitMq();
    await consumeEvent("post-created", handlePostCreate);

    app.listen(PORT, () => {
      logger.info(`Search service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error("Error while connecting to server!");
    process.exit(1);
  }
}

startServer();
