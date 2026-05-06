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
    logger.error(
      "Error occurred during creation of search from event handler ",
    );
  }
}
async function handlePostDelete(event) {
  try {
    const newSearchPost = new Search.findOneAndDelete({ postId: event.postId });
    logger.info(`Search post deleted:${event.postId} }`);
  } catch (error) {
    logger.error(
      "Error occurred during deletion of search from event handler ",
    );
  }
}

module.exports = { handlePostCreate, handlePostDelete };
