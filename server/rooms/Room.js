const config = require('../config');

class Room {
  constructor(code, gameType, hostId) {
    this.code = code;
    this.gameType = gameType;
    this.players = [];
    this.state = 'waiting';     // 'waiting' | 'playing' | 'ended'
    this.gameSession = null;
    this.hostId = hostId;
    this.settings = this._defaultSettings(gameType);
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  _defaultSettings(gameType) {
    const cfg = config.GAMES[gameType];
    return {
      smallBlind: cfg.smallBlind || 10,
      bigBlind: cfg.bigBlind || 20,
      defaultChips: cfg.defaultChips || 1000,
      turnTime: 30,
      runItTwice: false,
      rebuyEnabled: true,
      rebuyMin: 200,
      rebuyMax: 2000,
    };
  }

  updateSettings(playerId, patches) {
    if (playerId !== this.hostId) return { error: '只有房主可以修改设置' };
    if (this.state !== 'waiting') return { error: '游戏已开始，无法修改设置' };

    const allowed = ['smallBlind', 'bigBlind', 'defaultChips', 'turnTime', 'runItTwice', 'rebuyEnabled', 'rebuyMin', 'rebuyMax'];
    const numeric = ['smallBlind', 'bigBlind', 'defaultChips', 'turnTime', 'rebuyMin', 'rebuyMax'];
    const boolean = ['runItTwice', 'rebuyEnabled'];

    for (const key of Object.keys(patches)) {
      if (!allowed.includes(key)) return { error: `不允许修改 "${key}"` };
      const val = patches[key];
      if (numeric.includes(key)) {
        if (typeof val !== 'number' || val < 1 || val > 100000) return { error: `"${key}" 值不合法` };
      }
      if (boolean.includes(key)) {
        if (typeof val !== 'boolean') return { error: `"${key}" 必须是布尔值` };
      }
      this.settings[key] = val;
    }

    // Validate blind order
    if (this.settings.bigBlind < this.settings.smallBlind) {
      [this.settings.smallBlind, this.settings.bigBlind] = [this.settings.bigBlind, this.settings.smallBlind];
    }

    this.lastActivity = Date.now();
    return { success: true };
  }

  shuffleSeats(playerId) {
    if (playerId !== this.hostId) return { error: '只有房主可以随机座位' };
    if (this.state !== 'waiting') return { error: '游戏已开始，无法随机座位' };
    // Fisher-Yates shuffle
    for (let i = this.players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.players[i], this.players[j]] = [this.players[j], this.players[i]];
    }
    this.players.forEach((p, i) => { p.seatIndex = i; });
    this.lastActivity = Date.now();
    return { success: true };
  }

  get maxPlayers() {
    return config.GAMES[this.gameType].maxPlayers;
  }

  get minPlayers() {
    return config.GAMES[this.gameType].minPlayers;
  }

  getPlayer(playerId) {
    return this.players.find(p => p.id === playerId);
  }

  getPlayerBySocket(socketId) {
    return this.players.find(p => p.socketId === socketId);
  }

  addPlayer(player) {
    player.seatIndex = this.players.length;
    this.players.push(player);
    this.lastActivity = Date.now();
  }

  removePlayer(playerId) {
    const idx = this.players.findIndex(p => p.id === playerId);
    if (idx === -1) return null;
    const removed = this.players.splice(idx, 1)[0];
    this.players.forEach((p, i) => { p.seatIndex = i; });
    if (this.hostId === playerId && this.players.length > 0) {
      this.hostId = this.players[0].id;
    }
    this.lastActivity = Date.now();
    return removed;
  }

  isFull() {
    return this.players.length >= this.maxPlayers;
  }

  canStart() {
    if (this.players.length < this.minPlayers) return false;
    if (this.players.length > this.maxPlayers) return false;
    return this.players.every(p => p.isReady && p.isOnline);
  }

  toJSON(viewerPlayerId) {
    return {
      code: this.code,
      gameType: this.gameType,
      players: this.players.map(p => p.toJSON()),
      state: this.state,
      hostId: this.hostId,
      settings: this.settings,
      playerCount: this.players.length,
      maxPlayers: this.maxPlayers,
      ...(viewerPlayerId ? {
        myPlayerId: viewerPlayerId,
        isHost: viewerPlayerId === this.hostId,
      } : {}),
    };
  }
}

module.exports = Room;
