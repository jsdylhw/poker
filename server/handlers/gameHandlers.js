function registerGameHandlers(io, socket, roomManager) {

  socket.on('game:start', (_, callback) => {
    const playerId = roomManager.socketPlayer.get(socket.id);
    if (!playerId) return callback && callback({ error: '不在房间中' });

    const room = roomManager.getRoomByPlayer(playerId);
    if (!room) return callback && callback({ error: '房间不存在' });

    // Next hand: existing session - only dealer can start
    if (room.state === 'ended' && room.gameSession) {
      const dealerSeat = room.gameSession.seats[room.gameSession.dealerIndex];
      if (!dealerSeat || dealerSeat.playerId !== playerId) {
        return callback && callback({ error: '只有庄家可以开始下一局' });
      }
      const result = room.gameSession.start();
      if (result && result.error) return callback && callback({ error: result.error });
      room.state = 'playing';
      _broadcastGameState(io, room);
      return callback && callback({ success: true });
    }

    // First start - only host
    if (room.hostId !== playerId) return callback && callback({ error: '只有房主可以开始游戏' });
    if (!room.canStart()) return callback && callback({ error: '人数不足或有人未准备' });

    let GameEngine;
    try {
      GameEngine = require(`../games/${getGameModule(room.gameType)}`);
    } catch (e) {
      return callback && callback({ error: '游戏引擎加载失败' });
    }

    const session = new GameEngine(room, io);
    room.gameSession = session;
    room.state = 'playing';

    const result = session.start();
    if (result && result.error) {
      room.gameSession = null;
      room.state = 'waiting';
      return callback && callback({ error: result.error });
    }

    // Only mark DB playing after successful start
    try { require('../db').get().prepare(`UPDATE rooms SET state = 'playing' WHERE roomCode = ?`).run(room.code); } catch (e) {}

    _broadcastGameState(io, room);
    if (callback) callback({ success: true });
  });

  socket.on('game:action', ({ action, data }, callback) => {
    const playerId = roomManager.socketPlayer.get(socket.id);
    if (!playerId) return callback && callback({ error: '不在房间中' });

    const room = roomManager.getRoomByPlayer(playerId);
    if (!room || !room.gameSession) return callback && callback({ error: '游戏未开始' });
    if (room.state !== 'playing') return callback && callback({ error: '游戏未在进行中' });

    const result = room.gameSession.handleAction(playerId, action, data);
    if (result && result.error) {
      return callback({ error: result.error });
    }

    // Broadcast action to all players
    io.to(room.code).emit('game:action-played', result.publicAction);

    // Send updated state
    _broadcastGameState(io, room);

    // Check if game ended
    require('./finishHand')(io, room);


    if (callback) callback({ success: true });
  });

  socket.on('game:request-sync', (_, callback) => {
    const playerId = roomManager.socketPlayer.get(socket.id);
    if (!playerId) return callback && callback({ error: '不在房间中' });

    const room = roomManager.getRoomByPlayer(playerId);
    if (!room || !room.gameSession) return callback && callback({ error: '游戏未开始' });

    const state = room.gameSession.getState(playerId);
    socket.emit('game:state-sync', state);
    if (callback) callback({ success: true });
  });
}

function _broadcastGameState(io, room) {
  io.to(room.code).emit('game:started', { gameType: room.gameType });
  io.to(room.code).emit('game:turn', room.gameSession.getPublicState());
  for (const player of room.players) {
    const state = room.gameSession.getState(player.id);
    if (player.socketId) io.to(player.socketId).emit('game:dealt', state);
  }
}

function getGameModule(gameType) {
  const modules = {
    texas: 'TexasHoldem',
    doudizhu: 'DouDiZhu',
    guandan: 'GuanDan',
  };
  return modules[gameType] || gameType;
}

module.exports = registerGameHandlers;
