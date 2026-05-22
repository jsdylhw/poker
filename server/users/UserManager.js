const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

class UserManager {
  constructor() {
    this._cache = new Map(); // userId -> { displayName, deviceTokenHash }
  }

  /** Register a new user or return existing */
  register(displayName) {
    const userId = 'u_' + uuidv4();
    const deviceToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this._hash(deviceToken);
    const now = Date.now();

    const d = db.get();
    d.prepare(`INSERT INTO users (userId, displayName, deviceTokenHash, createdAt, lastSeenAt)
      VALUES (?, ?, ?, ?, ?)`).run(userId, displayName, tokenHash, now, now);

    this._cache.set(userId, { displayName, deviceTokenHash: tokenHash });
    return { userId, displayName, deviceToken };
  }

  /** Verify userId + deviceToken, update lastSeen */
  verify(userId, deviceToken) {
    if (!userId || !deviceToken) return null;

    // Check cache first
    const cached = this._cache.get(userId);
    if (cached && cached.deviceTokenHash === this._hash(deviceToken)) {
      return { userId, displayName: cached.displayName };
    }

    // Check DB
    const d = db.get();
    const row = d.prepare(`SELECT displayName, deviceTokenHash FROM users WHERE userId = ?`).get(userId);
    if (!row || row.deviceTokenHash !== this._hash(deviceToken)) return null;

    // Update lastSeen
    d.prepare(`UPDATE users SET lastSeenAt = ? WHERE userId = ?`).run(Date.now(), userId);
    this._cache.set(userId, { displayName: row.displayName, deviceTokenHash: row.deviceTokenHash });
    return { userId, displayName: row.displayName };
  }

  /** Get display name for a userId */
  getName(userId) {
    const cached = this._cache.get(userId);
    if (cached) return cached.displayName;

    const d = db.get();
    const row = d.prepare(`SELECT displayName FROM users WHERE userId = ?`).get(userId);
    return row ? row.displayName : null;
  }

  _hash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}

module.exports = new UserManager();
