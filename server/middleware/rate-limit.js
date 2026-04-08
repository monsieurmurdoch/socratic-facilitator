/**
 * Rate limiting middleware for Express routes.
 * Uses express-rate-limit (must be installed).
 */
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MS) || 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH_MAX) || 5,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting in test environment
  skip: () => process.env.NODE_ENV === 'test',
});

const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_API_WINDOW_MS) || 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_API_MAX) || 100,
  message: { error: 'Rate limit exceeded. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

module.exports = { authLimiter, apiLimiter };
