const logger = require("../utils/logger");
const Post = require("../models/Post");
const { validateCreatePost } = require("../utils/validation");
const { publishEvent } = require("../utils/rabbitmq");

async function invalidatePostCache(req, input) {
  try {
    const cachedKey = `post:${input}`;
    await req.redisClient.del(cachedKey);
    const keys = await req.redisClient.keys("posts:*");
    if (keys.length > 0) {
      await req.redisClient.del(keys);
    }
  } catch (error) {
    logger.info("Error In invalidate post cache", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
}

const createPost = async (req, res) => {
  logger.info("Create Post endpoint hit!");
  try {
    const { content, mediaIds } = req.body;
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
      user: req.user.userId,
      content,
      mediaIds: mediaIds || [],
    });
    await newlyCreatedPost.save();
    // Publish event for search service

    await publishEvent("post-created", {
      postId: newlyCreatedPost._id.toString(),
      userId: newlyCreatedPost.user.toString(),
      content: newlyCreatedPost.content,
      createdAt: newlyCreatedPost.createdAt,
    });
    await invalidatePostCache(req, newlyCreatedPost._id.toString());
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
    // pagination implemented
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const startIndex = (page - 1) * limit;

    const cacheKey = `posts:${page}:${limit}`;
    const cachedPosts = await req.redisClient.get(cacheKey);
    if (cachedPosts) {
      return res.json(JSON.parse(cachedPosts));
    }
    const posts = await Post.find({})
      .sort({ createdAt: -1 })
      .skip(startIndex)
      .limit(limit);
    const totalNoOfPosts = await Post.countDocuments();
    const result = {
      posts,
      currentPage: page,
      totalPages: Math.ceil(totalNoOfPosts / limit),
      totalPosts: totalNoOfPosts,
    };
    // save posts in redis cache
    await req.redisClient.setex(cacheKey, 300, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    logger.error("Error Getting ALl Posts", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};
const getPost = async (req, res) => {
  logger.info("Get Post endpoint hit!");
  try {
    const postId = req.params.id;
    const cacheKey = `post:${postId}`;
    const cachedPost = await req.redisClient.get(cacheKey);
    if (cachedPost) {
      return res.json(JSON.parse(cachedPost));
    }
    const postById = await Post.findById(postId);
    if (!postById) {
      res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }
    await req.redisClient.setex(cacheKey, 3600, JSON.stringify(postById));

    res.json(postById);
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
    const post = await Post.findOneAndDelete({
      _id: req.params.id,
      user: req.user.userId,
    });
    // publish post delete event
    await publishEvent("post-delete", {
      postId: post._id.toString(),
      mediaIds: post.mediaIds,
      userId: req.user.userId,
    });
    await invalidatePostCache(req, req.params.id);

    res.json({
      success: true,
      message: "Post deleted successfully!",
    });
  } catch (error) {
    logger.info("Error deleting Post", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

module.exports = { createPost, getAllPost, getPost, deletePost };
