const Media = require("../models/Media");
const { deleteMediaFromCloudinary } = require("../utils/cloudinary");
const logger = require("../utils/logger");

const handlePostDelete = async (event) => {
  const { postId, mediaIds } = event;
  try {
    const mediaToDelete = await Media.find({ _id: { $in: mediaIds } });
    for (const media of mediaToDelete) {
      await deleteMediaFromCloudinary(media.publicId);
      await Media.findByIdAndDelete(media._id);
      logger.info(`Media deleted ${media._id} associated to post: ${postId}`);
    }
    logger.info(
      "Deletion of media associated with post:",
      postId,
      " completed",
    );
  } catch (error) {
    logger.error("Error occurred during deletion of media from event handler ");
  }
};

module.exports = { handlePostDelete };
