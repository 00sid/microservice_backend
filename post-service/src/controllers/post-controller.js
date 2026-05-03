const logger = require("../utils/logger");
const Post = require("../models/Post");
const { validateCreatePost } = require("../utils/validation");

const createPost = async (req, res) => {
  logger.info("Create Post endpoint hit!");
  try {
    const { content, mediaUrls } = req.body;
    // Validate incoming request body
    const { error } = validateCreatePost(req.body);
    if (error) {
      logger.warn("Validation error", error.details[0].message);
      return res.status(400).json({
        success: false,
        error: error.details[0].message,
      });
    }
    const newlyCreatedPost = new Post({
      user: req.user,
      content,
      mediaUrls: mediaUrls || [],
    });
    await newlyCreatedPost.save();
    res.status(201).json({
      success: true,
      message: "Post Created Successfully!",
    });
  } catch (error) {
    logger.info("Error Creating Post", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};
const getAllPost = async (req, res) => {
  logger.info("Get All Posts endpoint hit!");
  try {
  } catch (error) {
    logger.info("Error Getting ALl Posts", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};
const getPost = async (req, res) => {
  logger.info("Get Post endpoint hit!");
  try {
  } catch (error) {
    logger.info("Error Getting Post", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};
const deletePost = async (req, res) => {
  logger.info("Delete Post endpoint hit!");
  try {
  } catch (error) {
    logger.info("Error deleting Post", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

module.exports = { createPost };
