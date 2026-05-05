const logger = require("../utils/logger");
const Search = require("../models/Search");

const searchPostController = async (req, res) => {
  logger.info("Search endpoint hits!");
  try {
    const { query } = req.query;
    const results = await Search.find({
      $text: { $search: query },
      $score: { $meta: "textScore" },
    })
      .sort({ $score: { $meta: "textScore" } })
      .limit(10);
    res.json(results);
  } catch (error) {
    logger.info("Error Searching Post!", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

module.exports = { searchPostController };
