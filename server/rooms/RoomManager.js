const Room = require('./Room');
const Player = require('../players/Player');
const config = require('../config');
const db = require('../db');

class RoomManager {
  constructor() {
    this.rooms = new Map();          // roomCode -> Room
    this.playerRoom = new Map();     // playerId -> roomCode
    this.socketPlayer = new Map();   // socketId -> playerId
  }

  createRoom(gameType, socketId, playerName, userId) {
    if (!config.GAMES[gameType]) {
      return { error: '不支持的游戏类型' };
    }

    const player = new Player(playerName, socketId, userId);
    player.isReady = true; // Host is auto-ready
    const code = this._generateCode();
    const room = new Room(code, gameType, player.id);
    room.addPlayer(player);

    this.rooms.set(code, room);
    this.playerRoom.set(player.id, code);
    this.socketPlayer.set(socketId, player.id);

    this._dbUpsertRoom(room, player);
    return { room, player };
  }

  joinRoom(code, socketId, playerName, userId) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return { error: '房间不存在' };
    if (room.state !== 'waiting') return { error: '游戏已开始，无法加入' };

    // Same user already in room - refresh/reconnect, check before isFull
    const existing = room.players.find(p => p.userId === userId);
    if (existing) {
      if (existing.socketId) this.socketPlayer.delete(existing.socketId);
      existing.socketId = socketId;
      existing.isOnline = true;
      this.socketPlayer.set(socketId, existing.id);
      return { room, player: existing };
    }

    if (room.isFull()) return { error: '房间已满' };

    const player = new Player(playerName, socketId, userId);
    room.addPlayer(player);
    this.playerRoom.set(player.id, code);
    this.socketPlayer.set(socketId, player.id);

    this._dbAddPlayer(room.code, player);
    return { room, player };
  }

  leaveRoom(socketId) {
    const playerId = this.socketPlayer.get(socketId);
    if (!playerId) return null;

    const roomCode = this.playerRoom.get(playerId);
    if (!roomCode) return null;

    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const removed = room.removePlayer(playerId);
    this.playerRoom.delete(playerId);
    this.socketPlayer.delete(socketId);

    // Clean up empty rooms
    if (room.players.length === 0 && room.state !== 'playing') {
      this.rooms.delete(roomCode);
      this._dbDeleteRoom(roomCode);
    } else {
      this._dbRemovePlayer(roomCode, playerId);
    }

    return { room, playerId: removed ? removed.id : null };
  }

  disconnectSocket(socketId) {
    const playerId = this.socketPlayer.get(socketId);
    if (!playerId) return null;

    this.socketPlayer.delete(socketId);

    const roomCode = this.playerRoom.get(playerId);
    if (!roomCode) return null;

    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const player = room.getPlayer(playerId);
    if (player) {
      player.isOnline = false;
      player.socketId = null;
    }

    return { room, playerId };
  }

  reconnectSocket(socketId, playerId) {
    const roomCode = this.playerRoom.get(playerId);
    if (!roomCode) return null;

    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const player = room.getPlayer(playerId);
    if (!player) return null;

    // Reject if player is already online (another tab has this identity)
    if (player.isOnline) return { rejected: true };

    // Update socket mapping
    const oldSocketId = player.socketId;
    if (oldSocketId) {
      this.socketPlayer.delete(oldSocketId);
    }
    player.socketId = socketId;
    player.isOnline = true;
    this.socketPlayer.set(socketId, playerId);

    return { room, player };
  }

  updateActivity(roomCode) {
    const room = this.rooms.get(roomCode);
    if (room) room.lastActivity = Date.now();
  }

  getRoomByCode(code) {
    return this.rooms.get(code);
  }

  getRoomByPlayer(playerId) {
    const code = this.playerRoom.get(playerId);
    if (!code) return null;
    return this.rooms.get(code);
  }

  getRoomByUserId(userId) {
    for (const [code, room] of this.rooms) {
      if (room.players.some(p => p.userId === userId)) return room;
    }
    return null;
  }

  getPlayerBySocket(socketId) {
    const playerId = this.socketPlayer.get(socketId);
    if (!playerId) return null;
    const roomCode = this.playerRoom.get(playerId);
    if (!roomCode) return null;
    const room = this.rooms.get(roomCode);
    return room ? room.getPlayer(playerId) : null;
  }

  listRooms(gameType) {
    const result = [];
    for (const room of this.rooms.values()) {
      if (room.state === 'waiting' && (!gameType || room.gameType === gameType)) {
        result.push(room.toJSON());
      }
    }
    return result;
  }

  cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.players.length === 0 && now - room.lastActivity > config.ROOM_STALE_TIMEOUT) {
        this.rooms.delete(code);
        this._dbDeleteRoom(code);
      }
    }
  }

  _dbUpsertRoom(room, hostPlayer) {
    try {
      const d = db.get();
      d.prepare(`INSERT OR REPLACE INTO rooms (roomCode, gameType, hostUserId, state, settings, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        room.code, room.gameType, hostPlayer.userId, room.state,
        JSON.stringify(room.settings), room.createdAt, Date.now()
      );
      d.prepare(`INSERT OR REPLACE INTO room_players (roomCode, userId, playerId, seatIndex, isReady, chips, isOnline)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        room.code, hostPlayer.userId, hostPlayer.id, 0, hostPlayer.isReady ? 1 : 0, 1000, 1
      );
    } catch (e) { console.error('[DB] upsert room:', e.message); }
  }

  _dbAddPlayer(roomCode, player) {
    try {
      db.get().prepare(`INSERT OR REPLACE INTO room_players (roomCode, userId, playerId, seatIndex, isReady, chips, isOnline)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        roomCode, player.userId, player.id, player.seatIndex, player.isReady ? 1 : 0, 1000, 1
      );
    } catch (e) { console.error('[DB] add player:', e.message); }
  }

  _dbRemovePlayer(roomCode, playerId) {
    try {
      db.get().prepare(`DELETE FROM room_players WHERE roomCode = ? AND playerId = ?`).run(roomCode, playerId);
    } catch (e) { console.error('[DB] remove player:', e.message); }
  }

  syncRoomToDB(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room || room.state !== 'waiting') return;
    this._dbSyncRoom(room);
  }

  _dbSyncRoom(room) {
    try {
      const d = db.get();
      d.prepare(`UPDATE rooms SET hostUserId = ?, settings = ?, updatedAt = ? WHERE roomCode = ?`).run(
        (room.players.find(p => p.id === room.hostId) || {}).userId || '',
        JSON.stringify(room.settings), Date.now(), room.code
      );
      const upsert = d.prepare(`INSERT OR REPLACE INTO room_players (roomCode, userId, playerId, seatIndex, isReady, chips, isOnline)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const p of room.players) {
        upsert.run(room.code, p.userId, p.id, p.seatIndex, p.isReady ? 1 : 0, 1000, p.isOnline ? 1 : 0);
      }
    } catch (e) { console.error('[DB] sync room:', e.message); }
  }

  _dbDeleteRoom(roomCode) {
    try {
      db.get().prepare(`DELETE FROM rooms WHERE roomCode = ?`).run(roomCode);
    } catch (e) { console.error('[DB] delete room:', e.message); }
  }

  restoreRoom(data) {
    if (this.rooms.has(data.code)) return { error: '房间号已存在' };
    if (!config.GAMES[data.gameType]) return { error: '不支持的游戏类型' };

    const room = new Room(data.code, data.gameType, data.hostId);
    room.settings = { ...room.settings, ...data.settings };
    room.createdAt = data.createdAt || Date.now();

    for (const p of (data.players || [])) {
      const player = new Player(p.name, null, p.userId);
      player.id = p.playerId || p.id;
      player.seatIndex = p.seatIndex || 0;
      player.isReady = p.isReady || false;
      player.isOnline = false;
      room.players.push(player);
      this.playerRoom.set(player.id, data.code);
    }
    // Fix hostId: data.hostId might be a userId, convert to playerId
    const hostPlayer = room.players.find(p => p.id === data.hostId || p.userId === data.hostId);
    room.hostId = hostPlayer ? hostPlayer.id : (room.players[0] ? room.players[0].id : '');
    this.rooms.set(data.code, room);
    return { room };
  }

  /** Load waiting rooms from DB on startup. Also clean up abandoned playing rooms. */
  loadFromDB() {
    try {
      const d = db.get();
      // Clean up playing rooms - they can't be restored and would accumulate forever
      const deleted = d.prepare(`DELETE FROM rooms WHERE state = 'playing'`).run();
      if (deleted.changes > 0) console.log(`[DB] 清理了 ${deleted.changes} 个 abandoned playing 房间`);
      const rows = d.prepare(`SELECT * FROM rooms WHERE state = 'waiting'`).all();
      for (const r of rows) {
        const room = new Room(r.roomCode, r.gameType, '');
        room.settings = { ...room.settings, ...JSON.parse(r.settings || '{}') };
        room.createdAt = r.createdAt;

        const players = d.prepare(`SELECT * FROM room_players WHERE roomCode = ? ORDER BY seatIndex ASC`).all(r.roomCode);
        for (const p of players) {
          const player = new Player('', null, p.userId);
          player.id = p.playerId;
          player.seatIndex = p.seatIndex;
          player.isReady = false; // reset on restore - player must re-ready
          player.isOnline = false;
          const user = d.prepare(`SELECT displayName FROM users WHERE userId = ?`).get(p.userId);
          if (user) player.name = user.displayName;
          room.players.push(player);
          this.playerRoom.set(player.id, r.roomCode);
        }
        // Fix hostId: DB stores hostUserId, need to convert to playerId
        const hostPlayer = room.players.find(p => p.userId === r.hostUserId);
        room.hostId = hostPlayer ? hostPlayer.id : (room.players[0] ? room.players[0].id : '');
        this.rooms.set(r.roomCode, room);
      }
      console.log(`[DB] 恢复了 ${rows.length} 个房间`);
    } catch (e) { console.error('[DB] 加载房间失败:', e.message); }
  }

  _generateCode() {
    const chars = config.ROOM_CODE_CHARS;
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < config.ROOM_CODE_LENGTH; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    // Fallback: just return random
    let code = '';
    for (let i = 0; i < config.ROOM_CODE_LENGTH; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }
}

module.exports = RoomManager;
