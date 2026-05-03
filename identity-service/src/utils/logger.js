// Import the Winston logging library
const winston = require("winston");

// Create a logger instance
const logger = winston.createLogger({
  // Set log level depending on environment
  // - "info" in production (less verbose)
  // - "debug" in development (more detailed logs)
  level: process.env.NODE_ENV == "production" ? "info" : "debug",

  // Define how logs should be formatted
  format: winston.format.combine(
    winston.format.timestamp(), // Add timestamp to each log
    winston.format.errors({ stack: true }), // Include stack trace for errors
    winston.format.splat(), // Support string interpolation
    winston.format.json(), // Output logs in JSON format
  ),

  // Default metadata added to every log
  defaultMeta: { service: "identity-service" },

  // Define where logs should be sent (transports)
  transports: [
    // 1. Console transport (prints logs to terminal)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(), // Colorize output (for readability)
        winston.format.simple(), // Simple text format
      ),
    }),

    // 2. File transport for errors only
    new winston.transports.File({
      filename: "error-log", // File to store error logs
      level: "error", // Only logs with level "error"
    }),

    // 3. File transport for all logs
    new winston.transports.File({
      filename: "combined.log", // File to store all logs
    }),
  ],
});

// Export logger so it can be used in other files
module.exports = logger;
