const express = require("express");
const multer = require("multer");
const authenticateRequest = require("../middleware/authMiddleware");
const logger = require("../utils/logger");
const { uploadMedia, getMedia } = require("../controllers/media-controller");

const router = express.Router();

// configure multer for file upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
}).single("file");

router.post(
  "/upload",
  authenticateRequest,
  (req, res, next) => {
    upload(req, res, function (err) {
      if (err instanceof multer.MulterError) {
        logger.error("Multer error while uploading", err);
        res.status(400).json({
          success: false,
          message: "Multer error while uploading",
          error: err.message,
          stack: err.stack,
        });
      } else if (err) {
        logger.error("Unknown error while uploading", err);
        res.status(500).json({
          success: false,
          message: "Unknown error while uploading",
          error: err.message,
          stack: err.stack,
        });
      }
      if (!req.file) {
        res.status(404).json({
          success: false,
          message: "No file found!",
        });
      }
      next();
    });
  },
  uploadMedia,
);

router.get("/:id", authenticateRequest, getMedia);

module.exports = router;
