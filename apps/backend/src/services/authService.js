const fs = require('fs');
const path = require('path');
const envPath = fs.existsSync(path.resolve(__dirname, '../../../.env'))
  ? path.resolve(__dirname, '../../../.env')
  : fs.existsSync(path.resolve(__dirname, '../../.env'))
    ? path.resolve(__dirname, '../../.env')
    : path.resolve(process.cwd(), '.env');
require('dotenv').config({ path: envPath });

const jwt = require('jsonwebtoken');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

// Tokens are always HS256. Pinning the algorithm stops a token that declares another one from being accepted.
const JWT_ALGORITHM = 'HS256';
const MIN_SECRET_LENGTH = 32;

class AuthService {
  constructor(secret = null) {
    const configuredSecret = secret || process.env.JWT_SECRET || '';
    this.JWT_SECRET = configuredSecret;
    this.DEFAULT_EXPIRATION_MS = 24 * 3600 * 1000; // 24 hours
  }

  // There is no fallback secret. A missing or short secret stops signing and verifying, in every environment.
  getSecret() {
    if (!this.JWT_SECRET || this.JWT_SECRET.length < MIN_SECRET_LENGTH) {
      throw new Error(`JWT_SECRET must be configured with at least ${MIN_SECRET_LENGTH} characters`);
    }
    return this.JWT_SECRET;
  }

  /**
   * Generates signed JWT token for user
   */
  generateToken(user, ttlMs = this.DEFAULT_EXPIRATION_MS) {
    const payload = {
      id: user.id || user.userId,
      name: user.name || 'Vaayu User',
      phone: user.phone || '',
      role: user.role || 'CUSTOMER',
      city: user.city || 'Hyderabad',
      iat: Math.floor(Date.now() / 1000)
    };

    return jwt.sign(payload, this.getSecret(), { algorithm: JWT_ALGORITHM, expiresIn: Math.floor(ttlMs / 1000) });
  }

  /**
   * Verifies and decodes JWT token
   */
  verifyToken(token) {
    if (!token || typeof token !== 'string') {
      metricsService.increment('auth_failure_total');
      metricsService.increment('invalid_token_total');
      return null;
    }

    try {
      const payload = jwt.verify(token, this.getSecret(), { algorithms: [JWT_ALGORITHM] });
      metricsService.increment('auth_success_total');
      return payload;
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        metricsService.increment('expired_token_total');
      } else {
        metricsService.increment('invalid_token_total');
      }
      return null;
    }
  }

  /**
   * Extracts the bearer token from the Authorization header only.
   * Query-string tokens are refused: URLs end up in access logs, history and referrers.
   */
  extractToken(req) {
    if (!req) return null;

    const authHeader = req.headers ? (req.headers.authorization || req.headers.Authorization) : null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }

    return null;
  }

  /**
   * Middleware/Helper to authenticate incoming HTTP request
   */
  authenticateRequest(req) {
    const token = this.extractToken(req);
    if (!token) {
      return { authenticated: false, code: 'UNAUTHORIZED', message: 'Missing Authorization Bearer token' };
    }

    const user = this.verifyToken(token);
    if (!user) {
      return { authenticated: false, code: 'INVALID_TOKEN', message: 'Invalid or expired JWT authorization token' };
    }

    req.user = user;
    return { authenticated: true, user };
  }
}

const authService = new AuthService();

module.exports = {
  AuthService,
  authService
};