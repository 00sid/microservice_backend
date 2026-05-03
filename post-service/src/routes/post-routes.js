const express = require("express");
const { createPost, getAllPost } = require("../controllers/post-controller");
const authenticateRequest = require("../middleware/authMiddleware");

const router = express();

router.use(authenticateRequest);

router.post("/create-post", createPost);
router.get("/all-posts", getAllPost);

module.exports = router;
