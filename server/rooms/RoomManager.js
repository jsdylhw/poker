const Room = require('./Room');
const Player = require('../players/Player');
const config = require('../config');

class RoomManager {
  constructor() {
    this.rooms = new Map();          // roomCode -> Room
    this.playerRoom = new Map();     // playerId -> roomCode
    this.socketPlayer = new Map();   // socketId -> playerId
  }

  createRoom(gameType, socketId, playerName) {
    if (!config.GAMES[gameType]) {
      return { error: '不支持的游戏类型' };
    }

    const player = new Player(playerName, socketId);
    player.isReady = true; // Host is auto-ready
    const code = this._generateCode();
    const room = new Room(code, gameType, player.id);
    room.addPlayer(player);

    this.rooms.set(code, room);
    this.playerRoom.set(player.id, code);
    this.socketPlayer.set(socketId, player.id);

    return { room, player };
  }

  joinRoom(code, socketId, playerName) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) {
      return { error: '房间不存在' };
    }
    if (room.state !== 'waiting') {
      return { error: '游戏已开始，无法加入' };
    }
    if (room.isFull()) {
      return { error: '房间已满' };
    }
    // Check if player is already in this room (reconnect)
    const existingBySocket = room.getPlayerBySocket(socketId);
    if (existingBySocket) {
      return { room, player: existingBySocket };
    }

    const player = new Player(playerName, socketId);
    room.addPlayer(player);
    this.playerRoom.set(player.id, code);
    this.socketPlayer.set(socketId, player.id);

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
    }

    return { room, playerId: removed ? removed.id : null };
  }

  disconnectSocket(socketId) {
    const playerId = this.socketPlayer.get(socketId);
    if (!playerId) return null;

    const roomCode = this.playerRoom.get(playerId);
    if (!roomCode) return null;

    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const player = room.getPlayer(playerId);
    if (player) {
      player.isOnline = false;
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
      }
    }
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
