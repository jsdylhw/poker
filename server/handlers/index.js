const registerRoomHandlers = require('./roomHandlers');
const registerGameHandlers = require('./gameHandlers');
const userManager = require('../users/UserManager');

function registerAllHandlers(io, roomManager) {
  io.on('connection', (socket) => {
    console.log(`[连接] ${socket.id}`);

    // Register new user (first time)
    socket.on('auth:register', ({ displayName } = {}, callback) => {
      if (!displayName || displayName.trim().length === 0) {
        return callback({ error: '请输入昵称' });
      }
      if (displayName.trim().length > 12) {
        return callback({ error: '昵称最多12个字符' });
      }
      const user = userManager.register(displayName.trim());
      // Set identity immediately - no race condition
      socket._userId = user.userId;
      socket._displayName = user.displayName;
      callback({ userId: user.userId, deviceToken: user.deviceToken, displayName: user.displayName });
    });

    // Resume existing session (reconnect/refresh)
    socket.on('auth:resume', ({ userId, deviceToken } = {}, callback) => {
      const user = userManager.verify(userId, deviceToken);
      if (!user) {
        return callback({ reconnected: false });
      }

      // Set identity immediately - no race condition
      socket._userId = user.userId;
      socket._displayName = user.displayName;

      // Find if user is in a room
      const room = roomManager.getRoomByUserId(userId);
      if (room) {
        const player = room.players.find(p => p.userId === userId);
        if (player) {
          // Allow refresh replace (same user, new socket)
          if (player.isOnline) {
            const oldSocketId = player.socketId;
            if (oldSocketId && oldSocketId !== socket.id) {
              roomManager.socketPlayer.delete(oldSocketId);
            }
          }

          player.socketId = socket.id;
          player.isOnline = true;
          roomManager.socketPlayer.set(socket.id, player.id);

          socket.join(room.code);

          callback({
            reconnected: true,
            userId: user.userId,
            displayName: user.displayName,
            player: player.toJSON(),
            room: room.toJSON(player.id),
          });

          // Notify others with personalized JSON
          for (const p of room.players) {
            if (p.socketId && p.socketId !== socket.id) {
              io.to(p.socketId).emit('room:update', room.toJSON(p.id));
            }
          }

          if (room.gameSession) {
            socket.emit('game:turn', room.gameSession.getPublicState());
            socket.emit('game:dealt', room.gameSession.getState(player.id));
            if (room.gameSession.handOver || room.gameSession.state === 'ended') {
              socket.emit('game:ended', room.gameSession.getEndState());
            }
          }
          return;
        }
      }
      // User valid but not in any room - don't clear credentials
      callback({ authenticated: true, inRoom: false, userId: user.userId, displayName: user.displayName });
    });

    registerRoomHandlers(io, socket, roomManager, userManager);
    registerGameHandlers(io, socket, roomManager);
  });
}

module.exports = registerAllHandlers;
