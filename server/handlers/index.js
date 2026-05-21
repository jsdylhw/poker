const registerRoomHandlers = require('./roomHandlers');
const registerGameHandlers = require('./gameHandlers');

function registerAllHandlers(io, roomManager) {
  io.on('connection', (socket) => {
    console.log(`[连接] ${socket.id}`);

    // Send assigned player id
    socket.on('conn:register', ({ playerId } = {}, callback) => {
      if (playerId) {
        // Only reconnect if player is offline (prevents tab duplication)
        const result = roomManager.reconnectSocket(socket.id, playerId);
        if (result) {
          if (result.rejected) {
            // Another tab already has this player - start fresh
            callback({ reconnected: false });
            return;
          }
          socket.join(result.room.code);
          callback({
            playerId: result.player.id,
            player: result.player.toJSON(),
            room: result.room.toJSON(),
            reconnected: true,
          });

          // Notify others
          socket.to(result.room.code).emit('room:update', result.room.toJSON());

          // If game in progress, sync state
          if (result.room.gameSession) {
            const state = result.room.gameSession.getState(result.player.id);
            socket.emit('game:state-sync', state);
          }
          return;
        }
      }
      callback({ reconnected: false });
    });

    registerRoomHandlers(io, socket, roomManager);
    registerGameHandlers(io, socket, roomManager);
  });
}

module.exports = registerAllHandlers;
