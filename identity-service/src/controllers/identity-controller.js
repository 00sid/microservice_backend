// Import required modules and utilities
const logger = require("../utils/logger"); // Custom logger for logging info/warnings/errors
const { validateRegistration, validateLogin } = require("../utils/validation"); // Validation schemas
const User = require("../models/User"); // User model (MongoDB)
const generateTokens = require("../utils/generateToken"); // Function to generate access & refresh tokens
const RefreshToken = require("../models/RefreshToken"); // Refresh token model

// ========================= REGISTER USER =========================
const registerUser = async (req, res) => {
  logger.info("Registration endpoint hit..");

  try {
    // Validate incoming request body
    const { error } = validateRegistration(req.body);
    if (error) {
      logger.warn("Validation error", error.details[0].message);
      return res.status(400).json({
        success: false,
        error: error.details[0].message,
      });
    }

    // Extract user data from request
    const { email, password, username } = req.body;

    // Check if user already exists (by email or username)
    let user = await User.findOne({ $or: [{ email }, { username }] });
    if (user) {
      logger.warn("User already exists");
      return res.status(400).json({
        success: false,
        error: "User already exists",
      });
    }

    // Create new user instance
    user = new User({ email, username, password });

    // Save user to database
    await user.save();
    logger.warn("User saved successfully.", user._id);

    // Generate access and refresh tokens for the new user
    const { accessToken, refreshToken } = await generateTokens(user);

    // Send success response with tokens
    res.status(201).json({
      success: true,
      message: "User registered successfully!",
      accessToken,
      refreshToken,
    });
  } catch (error) {
    logger.error("Registration error occurred", error);

    // Handle unexpected errors
    res.status(500).json({
      success: false,
      message: "Internal Server Error!",
    });
  }
};

// ========================= LOGIN USER =========================
const loginUser = async (req, res) => {
  logger.info("Login endpoint hit..");

  try {
    // Validate login request
    const { error } = validateLogin(req.body);
    if (error) {
      logger.warn("Validation error", error.details[0].message);
      return res.status(400).json({
        success: false,
        error: error.details[0].message,
      });
    }

    // Extract credentials
    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      logger.warn("Invalid user");
      return res.status(400).json({
        success: false,
        error: "Invalid credentials!",
      });
    }

    // Compare entered password with stored hashed password
    const isValidPassword = await user.comparePassword(password);
    if (!isValidPassword) {
      logger.warn("Invalid password");
      return res.status(400).json({
        success: false,
        error: "Invalid credentials!",
      });
    }

    // Generate new tokens after successful login
    const { accessToken, refreshToken } = await generateTokens(user);

    // Return tokens and user ID
    res.json({
      accessToken,
      refreshToken,
      userId: user._id,
    });
  } catch (error) {
    logger.error("Login error occurred", error);

    res.status(500).json({
      success: false,
      message: "Internal Server Error!",
    });
  }
};

// ========================= REFRESH TOKEN =========================
const refreshTokenUser = async (req, res) => {
  logger.info("Refresh token endpoint hit..");

  try {
    // Get refresh token from request body
    const { refreshToken } = req.body;

    // Check if token is provided
    if (!refreshToken) {
      logger.warn("Refresh token missing");
      return res.status(400).json({
        success: false,
        error: "Refresh token missing",
      });
    }

    // Find token in database
    const storedToken = await RefreshToken.findOne({ token: refreshToken });

    // Validate token existence and expiration
    if (!storedToken || storedToken.expiresAt < new Date()) {
      logger.warn("Invalid or expired refresh token");
      return res.status(401).json({
        success: false,
        error: "Invalid or expired refresh token",
      });
    }

    // Find associated user
    const user = await User.findById(storedToken.user);

    // If user does not exist, invalidate token
    if (!user) {
      logger.warn("Invalid or expired refresh token");
      return res.status(401).json({
        success: false,
        error: "Invalid or expired refresh token",
      });
    }

    // Generate new tokens (token rotation)
    const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
      await generateTokens(user);

    // Delete old refresh token from DB
    await RefreshToken.deleteOne({ _id: storedToken._id });

    // Send new tokens
    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    logger.error("Refresh token error occurred", error);

    res.status(500).json({
      success: false,
      message: "Internal Server Error!",
    });
  }
};

// ========================= LOGOUT USER =========================
const logoutUser = async (req, res) => {
  logger.info("Logout user endpoint hit..");

  try {
    // Get refresh token from request
    const { refreshToken } = req.body;

    // Ensure token exists
    if (!refreshToken) {
      logger.warn("Refresh token missing");
      return res.status(400).json({
        success: false,
        error: "Refresh token missing",
      });
    }

    // Delete refresh token from DB (invalidate session)
    await RefreshToken.deleteOne({ token: refreshToken });

    logger.info("Refresh token deleted for logout!");

    // Send success response
    res.json({
      success: true,
      error: "Logged out successfully!",
    });
  } catch (error) {
    logger.error("Logout user error occurred", error);

    res.status(500).json({
      success: false,
      message: "Internal Server Error!",
    });
  }
};

// Export all controller functions
module.exports = { registerUser, loginUser, refreshTokenUser, logoutUser };
