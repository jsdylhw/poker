const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.POKER_DB_PATH || path.join(__dirname, '..', 'data', 'poker.db');

let db;

function open() {
  const dir = path.dirname(DB_PATH);
  require('fs').mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      userId    TEXT PRIMARY KEY,
      displayName TEXT NOT NULL,
      deviceTokenHash TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      lastSeenAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      roomCode  TEXT PRIMARY KEY,
      gameType  TEXT NOT NULL,
      hostUserId TEXT NOT NULL REFERENCES users(userId),
      state     TEXT NOT NULL DEFAULT 'waiting',
      settings  TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_players (
      roomCode  TEXT NOT NULL REFERENCES rooms(roomCode) ON DELETE CASCADE,
      userId    TEXT NOT NULL REFERENCES users(userId),
      playerId  TEXT NOT NULL,
      seatIndex INTEGER NOT NULL DEFAULT 0,
      isReady   INTEGER NOT NULL DEFAULT 0,
      chips     INTEGER NOT NULL DEFAULT 1000,
      isOnline  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (roomCode, userId)
    );

    CREATE TABLE IF NOT EXISTS hand_records (
      handId    TEXT PRIMARY KEY,
      roomCode  TEXT NOT NULL,
      gameType  TEXT NOT NULL,
      startedAt INTEGER NOT NULL,
      endedAt   INTEGER NOT NULL,
      communityCards TEXT NOT NULL DEFAULT '[]',
      pot       INTEGER NOT NULL DEFAULT 0,
      results   TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS hand_players (
      handId    TEXT NOT NULL REFERENCES hand_records(handId) ON DELETE CASCADE,
      userId    TEXT NOT NULL,
      playerName TEXT NOT NULL,
      buyin     INTEGER NOT NULL,
      wonAmount INTEGER NOT NULL DEFAULT 0,
      totalBet  INTEGER NOT NULL DEFAULT 0,
      folded    INTEGER NOT NULL DEFAULT 0,
      handJson  TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (handId, userId)
    );
  `);

  return db;
}

function get() {
  if (!db) open();
  return db;
}

module.exports = { open, get };
