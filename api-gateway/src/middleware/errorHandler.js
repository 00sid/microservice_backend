const logger = require("../utils/logger");

const errorHandler = (error, req, res, next) => {
  logger.error(error.stack);

  res.status(error.status || 500).json({
    message: error.message || "Internal Server Error",
  });
};

module.exports = errorHandler;
