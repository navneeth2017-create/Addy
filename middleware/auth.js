const jwt = require('jsonwebtoken');

/**
 * Every session token is signed with this. The old fallback was a fixed string
 * committed to the repo, so any deployment missing JWT_SECRET could have an
 * admin token forged by anyone who read this file — a complete account
 * takeover, guarded only by a startup warning nobody sees again after boot.
 *
 * In production we now refuse to start rather than run on a publicly known
 * key — the same rule Monarch already enforces. Outside production the
 * fallback stays, so local dev and the test suite need no setup.
 */
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '\nFATAL: JWT_SECRET is not set.\n' +
      'Refusing to start. Without it, every session token would be signed with a\n' +
      'key that is public in this repository, letting anyone forge an admin login.\n' +
      'Set JWT_SECRET to a long random string in your host environment\n' +
      '  openssl rand -base64 48\n' +
      'and redeploy.\n'
    );
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET not set — using the dev fallback. Never deploy like this.');
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
