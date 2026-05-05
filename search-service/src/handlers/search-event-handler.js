const Search = require("../models/Search");
const logger = require("../utils/logger");

async function handlePostCreate(event) {
  try {
    const newSearchPost = new Search({
      postId: event.postId,
      userId: event.userId,
      content: event.content,
      createdAt: event.createdAt,
    });
    await newSearchPost.save();
    logger.info(
      `Search post created:${event.postId} searchId: ${newSearchPost._id.toString()}`,
    );
  } catch (error) {
    logger.error("Error occurred during deletion of media from event handler ");
  }
}

module.exports = { handlePostCreate };
