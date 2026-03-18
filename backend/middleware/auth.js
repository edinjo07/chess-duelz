// backend/middleware/auth.js
// JWT authentication middleware
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || 'your_secret_key';

// Auth middleware - extracts userId from JWT token
function auth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Support both .sub and .userId for compatibility
    req.user = { 
      id: payload.sub || payload.userId || payload.id,
      userId: payload.sub || payload.userId || payload.id
    };
    next();
  } catch (error) {
    console.error('JWT verification failed:', error.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth - doesn't fail if no token, just sets req.user if valid
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { 
      id: payload.sub || payload.userId || payload.id,
      userId: payload.sub || payload.userId || payload.id
    };
  } catch (error) {
    req.user = null;
  }
  
  next();
}

module.exports = { auth, optionalAuth };
