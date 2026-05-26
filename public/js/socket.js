const SocketClient = (() => {
  let socket = null;
  let userId = sessionStorage.getItem('userId') || null;
  let deviceToken = sessionStorage.getItem('deviceToken') || null;
  let playerId = null;

  function connect() {
    socket = io(window.location.origin, {
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socket.on('connect', () => {
      document.getElementById('connection-status').className = 'status-dot connected';
      _authenticate();
    });

    socket.on('disconnect', () => {
      document.getElementById('connection-status').className = 'status-dot disconnected';
    });

    // Forward events to AppState
    socket.on('room:update', (room) => {
      AppState.set('room', room);
    });

    socket.on('game:started', (data) => {
      AppState.set('gameResult', null);
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

  async function _authenticate() {
    if (userId && deviceToken) {
      const shouldResumeRoom = sessionStorage.getItem('activeRoomCode') && sessionStorage.getItem('activePlayerId');
      const res = await emit('auth:resume', { userId, deviceToken, joinRoom: !!shouldResumeRoom }, true);
      if (res && res.reconnected) {
        // In room - restore full state
        playerId = res.player ? res.player.id : null;
        rememberRoomSession(res.room, res.player);
        AppState.set('player', res.player);
        AppState.set('room', res.room);
        if (res.room && res.room.gameType) {
          // Jump to game if playing/ended, otherwise room lobby
          if (res.room.state === 'playing' || res.room.state === 'ended') {
            Router.navigate('game');
          } else {
            Router.navigate('room-lobby');
          }
        }
        return;
      }
      if (res && res.authenticated) {
        // Token valid but not in room - keep credentials, user can join/create
        clearRoomSession();
        return;
      }
      // Token invalid - clear stale credentials
      clearIdentitySession();
    }
    userId = null;
    deviceToken = null;
    AppState.set('player', null);
    AppState.set('room', null);
  }

  async function register(displayName) {
    const res = await emit('auth:register', { displayName }, true);
    if (res.error) { Toast.show(res.error, 'error'); return false; }
    userId = res.userId;
    deviceToken = res.deviceToken;
    sessionStorage.setItem('userId', userId);
    sessionStorage.setItem('deviceToken', deviceToken);
    localStorage.setItem('displayName', res.displayName);
    return true;
  }

  function rememberRoomSession(room, player) {
    if (room && room.code) sessionStorage.setItem('activeRoomCode', room.code);
    if (player && player.id) sessionStorage.setItem('activePlayerId', player.id);
  }

  function clearRoomSession() {
    sessionStorage.removeItem('activeRoomCode');
    sessionStorage.removeItem('activePlayerId');
    playerId = null;
  }

  function clearIdentitySession() {
    sessionStorage.removeItem('userId');
    sessionStorage.removeItem('deviceToken');
    localStorage.removeItem('userId');
    localStorage.removeItem('deviceToken');
    clearRoomSession();
  }

  function emit(event, data, raw) {
    return new Promise((resolve) => {
      socket.emit(event, data, (res) => {
        if (!raw && res && res.error) {
          Toast.show(res.error, 'error');
        }
        resolve(res);
      });
    });
  }

  function getSocket() { return socket; }
  function getPlayerId() { return playerId; }
  function getUserId() { return userId; }

  return { connect, register, emit, getSocket, getPlayerId, getUserId, rememberRoomSession, clearRoomSession };
})();
