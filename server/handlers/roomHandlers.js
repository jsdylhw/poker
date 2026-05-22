function registerRoomHandlers(io, socket, roomManager, userManager) {

  function getUserId() { return socket._userId || null; }
  function getName() { return socket._displayName || ''; }

  function broadcastRoom(room) {
    if (!room) return;
    for (const player of room.players) {
      if (player.socketId) {
        io.to(player.socketId).emit('room:update', room.toJSON(player.id));
      }
    }
  }

  socket.on('room:create', ({ gameType }, callback) => {
    const userId = getUserId();
    const name = getName();
    if (!name) return callback({ error: '请先输入昵称' });
    // Prevent one user from creating multiple rooms
    if (roomManager.getRoomByUserId(userId)) return callback({ error: '你已经在一个房间中，请先离开' });

    const result = roomManager.createRoom(gameType, socket.id, name, userId);
    if (result.error) return callback({ error: result.error });

    socket.join(result.room.code);
    callback({ room: result.room.toJSON(result.player.id), player: result.player.toJSON() });
  });

  socket.on('room:join', ({ code }, callback) => {
    const userId = getUserId();
    const name = getName();
    if (!name) return callback({ error: '请先输入昵称' });
    if (!code || code.trim().length === 0) return callback({ error: '请输入房间号' });

    const result = roomManager.joinRoom(code.trim(), socket.id, name, userId);
    if (result.error) return callback({ error: result.error });

    socket.join(result.room.code);
    callback({ room: result.room.toJSON(result.player.id), player: result.player.toJSON() });
    broadcastRoom(result.room);
  });

  socket.on('room:leave', (_, callback) => {
    const result = roomManager.leaveRoom(socket.id);
    if (!result) return callback && callback({ error: '不在任何房间中' });
    socket.leave(result.room.code);
    if (callback) callback({ success: true });
    if (result.room) roomManager.syncRoomToDB(result.room.code);
    broadcastRoom(result.room);
  });

  socket.on('room:list', ({ gameType } = {}, callback) => {
    const rooms = roomManager.listRooms(gameType || null);
    if (callback) callback({ rooms });
  });

  socket.on('room:ready', ({ ready }, callback) => {
    const room = roomManager.getRoomByPlayer(roomManager.socketPlayer.get(socket.id));
    if (!room) return callback && callback({ error: '不在房间中' });
    const player = room.getPlayerBySocket(socket.id);
    if (!player) return callback && callback({ error: '玩家不在房间中' });
    player.isReady = ready;
    roomManager.syncRoomToDB(room.code);
    if (callback) callback({ success: true });
    broadcastRoom(room);
  });

  socket.on('room:shuffleSeats', (_, callback) => {
    const playerId = roomManager.socketPlayer.get(socket.id);
    if (!playerId) return callback && callback({ error: '不在房间中' });
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room) return callback && callback({ error: '房间不存在' });
    const result = room.shuffleSeats(playerId);
    if (result.error) return callback && callback({ error: result.error });
    roomManager.syncRoomToDB(room.code);
    broadcastRoom(room);
    if (callback) callback({ success: true });
  });

  socket.on('room:updateSettings', (patches, callback) => {
    const playerId = roomManager.socketPlayer.get(socket.id);
    if (!playerId) return callback && callback({ error: '不在房间中' });
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room) return callback && callback({ error: '房间不存在' });
    const result = room.updateSettings(playerId, patches);
    if (result.error) return callback && callback({ error: result.error });
    roomManager.syncRoomToDB(room.code);
    broadcastRoom(room);
    if (callback) callback({ success: true });
  });

  socket.on('game:rebuy', ({ amount }, callback) => {
    const playerId = roomManager.socketPlayer.get(socket.id);
    if (!playerId) return callback && callback({ error: '不在房间中' });
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room || !room.gameSession) return callback && callback({ error: '游戏未开始' });
    const result = room.gameSession.rebuy(playerId, amount);
    if (result.error) return callback && callback({ error: result.error });
    io.to(room.code).emit('game:turn', room.gameSession.getPublicState());
    for (const player of room.players) {
      if (player.socketId) io.to(player.socketId).emit('game:dealt', room.gameSession.getState(player.id));
    }
    if (callback) callback({ success: true });
  });

  socket.on('disconnect', () => {
    const result = roomManager.disconnectSocket(socket.id);
    if (result && result.room) {
      broadcastRoom(result.room);
      if (result.room.gameSession) {
        // Broadcast updated game state so online-status dots update immediately
        io.to(result.room.code).emit('game:turn', result.room.gameSession.getPublicState());
        for (const p of result.room.players) {
          const state = result.room.gameSession.getState(p.id);
          if (p.socketId) io.to(p.socketId).emit('game:dealt', state);
        }
        result.room.gameSession.onPlayerDisconnect(result.playerId);
      }
    }
  });
}

module.exports = registerRoomHandlers;
