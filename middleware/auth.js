const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET env var not set — using insecure default. Set it in Railway before going live.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'addy-dev-fallback-change-before-launch';

function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    next();
  };
}

module.exports = { authenticate, authorize, JWT_SECRET };
