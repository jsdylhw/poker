const SocketClient = (() => {
  let socket = null;
  let playerId = null;

  function connect() {
    socket = io(window.location.origin, {
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    playerId = localStorage.getItem('playerId');

    socket.on('connect', () => {
      document.getElementById('connection-status').className = 'status-dot connected';

      socket.emit('conn:register', { playerId }, (res) => {
        if (res.reconnected) {
          playerId = res.playerId;
          localStorage.setItem('playerId', playerId);
          AppState.set('player', res.player);
          AppState.set('room', res.room);
          if (res.room.gameType) {
            Router.navigate('room-lobby');
          }
        } else {
          // Reconnect rejected (another tab active) or not found - start fresh
          localStorage.removeItem('playerId');
          playerId = null;
          AppState.set('player', null);
          AppState.set('room', null);
        }
      });
    });

    socket.on('disconnect', () => {
      document.getElementById('connection-status').className = 'status-dot disconnected';
    });

    // Forward events to AppState
    socket.on('room:update', (room) => {
      AppState.set('room', room);
    });

    socket.on('game:started', (data) => {
      AppState.set('gameStarted', data);
      Router.navigate('game');
    });

    socket.on('game:dealt', (state) => {
      AppState.set('playerGameState', state);
    });

    socket.on('game:turn', (state) => {
      AppState.set('gamePublicState', state);
    });

    socket.on('game:action-played', (action) => {
      AppState.set('lastAction', action);
    });

    socket.on('game:ended', (result) => {
      AppState.set('gameResult', result);
    });

    socket.on('game:state-sync', (state) => {
      AppState.set('playerGameState', state);
      Router.navigate('game');
    });
  }

  function emit(event, data, callback) {
    return new Promise((resolve) => {
      if (callback !== undefined) {
        socket.emit(event, data, resolve);
      } else {
        socket.emit(event, data, (res) => {
          if (res && res.error) {
            Toast.show(res.error, 'error');
          }
          resolve(res);
        });
      }
    });
  }

  function getSocket() { return socket; }
  function getPlayerId() { return playerId; }

  return { connect, emit, getSocket, getPlayerId };
})();
