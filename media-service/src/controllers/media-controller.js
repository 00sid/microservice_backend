const Media = require("../models/Media");
const { uploadMediaToCloudinary } = require("../utils/cloudinary");
const logger = require("../utils/logger");

const uploadMedia = async (req, res) => {
  logger.info("Starting media upload");
  try {
    if (!req.file) {
      logger.error("No file found. Please add a file and try again!");
      return res.status(400).json({
        success: false,
        message: "No file found. Please add a file and try again!",
      });
    }
    const { originalname, mimetype, buffer } = req.file;
    const userId = req.user.userId;

    logger.info(`File details: name= ${originalname}, type= ${mimetype}`);
    logger.info("Uploading to cloudinary started...");
    const cloudinaryUploadResult = await uploadMediaToCloudinary(req.file);
    logger.info(
      `Cloudinary upload successful. Public id:${cloudinaryUploadResult.public_id}`,
    );
    const newlyCreatedMedia = new Media({
      publicId: cloudinaryUploadResult.public_id,
      originalName: originalname,
      mimeType: mimetype,
      userId,
      url: cloudinaryUploadResult.secure_url,
    });
    await newlyCreatedMedia.save();
    res.status(201).json({
      success: true,
      message: "Media uploaded successfully!",
      mediaId: newlyCreatedMedia._id,
      url: newlyCreatedMedia.url,
    });
  } catch (error) {
    logger.info("Error Uploading Media!", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

module.exports = { uploadMedia };
