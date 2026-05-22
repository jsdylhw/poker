const Lobby = (() => {
  let selectedGame = 'texas';

  function init() {
    // Game tabs
    document.querySelectorAll('.game-tabs .tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.game-tabs .tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        selectedGame = tab.dataset.game;
        refreshRoomList();
      });
    });

    // Create room
    document.getElementById('btn-create-room').addEventListener('click', async () => {
      const name = getPlayerName();
      if (!name) return;
      if (!await ensureAuth(name)) return;
      const res = await SocketClient.emit('room:create', { gameType: selectedGame });
      if (res.error) return;
      AppState.set('player', res.player);
      AppState.set('room', res.room);
      Router.navigate('room-lobby');
    });

    // Join room
    document.getElementById('btn-join-room').addEventListener('click', async () => {
      const name = getPlayerName();
      if (!name) return;
      const code = document.getElementById('room-code').value.trim();
      if (!code) return Toast.show('请输入房间号', 'error');
      if (!await ensureAuth(name)) return;
      const res = await SocketClient.emit('room:join', { code: code.toUpperCase() });
      if (res.error) return;
      AppState.set('player', res.player);
      AppState.set('room', res.room);
      Router.navigate('room-lobby');
    });

    // Room code Enter key
    document.getElementById('room-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-join-room').click();
    });

    // Restore player name from socket identity
    const storedName = localStorage.getItem('displayName');
    if (storedName) {
      document.getElementById('player-name').value = storedName;
    }

    // Listen for room updates while in lobby
    AppState.on('room', (room) => {
      if (!room && window.location.hash === '') {
        Router.navigate('lobby');
      }
    });

    refreshRoomList();
  }

  function getPlayerName() {
    const name = document.getElementById('player-name').value.trim();
    if (!name) { Toast.show('请输入昵称', 'error'); return ''; }
    return name;
  }

  async function ensureAuth(name) {
    if (SocketClient.getUserId()) return true;
    const ok = await SocketClient.register(name);
    if (!ok) { Toast.show('注册失败，请重试', 'error'); return false; }
    return true;
  }

  async function refreshRoomList() {
    const res = await SocketClient.emit('room:list', { gameType: selectedGame }, true);
    const container = document.getElementById('room-list');
    if (!res || !res.rooms || res.rooms.length === 0) {
      container.innerHTML = '<div class="room-empty">暂无房间<br>创建一个吧</div>';
      return;
    }
    container.innerHTML = res.rooms.map(r => `
      <div class="room-item">
        <div>
          <span class="room-code">${r.code}</span>
          <span class="room-info">${r.playerCount}/${r.maxPlayers}人</span>
        </div>
        <button class="btn-secondary btn-join-room" data-code="${r.code}">加入</button>
      </div>
    `).join('');

    // Bind join buttons
    container.querySelectorAll('.btn-join-room').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = getPlayerName();
        if (!name) return;
        if (!await ensureAuth(name)) return;
        const code = btn.dataset.code;
        document.getElementById('room-code').value = code;
        const res = await SocketClient.emit('room:join', { code });
        if (res.error) return;
        AppState.set('player', res.player);
        AppState.set('room', res.room);
        Router.navigate('room-lobby');
      });
    });
  }

  function renderRoomLobby() {
    const room = AppState.get('room');
    const player = AppState.get('player');
    if (!room) return;

    const gameNames = { texas: '德州扑克', doudizhu: '斗地主', guandan: '掼蛋' };
    document.getElementById('room-code-display').textContent = room.code;
    document.getElementById('game-type-display').textContent = gameNames[room.gameType] || room.gameType;

    const isHost = room.isHost === true;
    document.getElementById('btn-start-game').classList.toggle('hidden', !isHost);
    document.getElementById('btn-ready').classList.toggle('hidden', isHost);

    // Player list
    const listEl = document.getElementById('player-list');
    listEl.innerHTML = room.players.map(p => `
      <div class="player-item">
        <span class="player-seat">#${p.seatIndex + 1}</span>
        <span class="player-name">${p.name} ${p.id === room.hostId ? '<span class="player-host">房主</span>' : ''}</span>
        <span class="player-ready ${p.isReady ? 'yes' : 'no'}">${p.isReady ? '已准备' : '未准备'}</span>
      </div>
    `).join('');

    // Settings panel (host only for texas)
    renderSettingsPanel(room, isHost);

    // Shuffle seats button (host only)
    const shuffleBtn = document.getElementById('btn-shuffle-seats');
    if (shuffleBtn) {
      shuffleBtn.classList.toggle('hidden', !isHost);
      if (isHost && !shuffleBtn._bound) {
        shuffleBtn._bound = true;
        shuffleBtn.addEventListener('click', async () => {
          await SocketClient.emit('room:shuffleSeats', {});
        });
      }
    }

    // Ready button
    document.getElementById('btn-ready').onclick = async () => {
      const currentPlayer = room.players.find(p => p.id === player.id);
      const newReady = !(currentPlayer && currentPlayer.isReady);
      await SocketClient.emit('room:ready', { ready: newReady });
    };

    // Start game button
    document.getElementById('btn-start-game').onclick = async () => {
      await SocketClient.emit('game:start', {});
    };

    // Leave button
    document.getElementById('btn-leave-room').onclick = async () => {
      await SocketClient.emit('room:leave', {});
      AppState.set('room', null);
      AppState.set('player', null);
      Router.navigate('lobby');
    };
  }

  function renderSettingsPanel(room, isHost) {
    const panel = document.getElementById('settings-panel');
    if (!panel) return;

    // Only show for texas
    if (room.gameType !== 'texas' || room.state !== 'waiting') {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.toggle('hidden', !isHost);

    const s = room.settings || {};

    // Populate fields
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };

    setVal('set-turn-time', s.turnTime || 30);
    setVal('set-small-blind', s.smallBlind || 10);
    setVal('set-big-blind', s.bigBlind || 20);
    setVal('set-default-chips', s.defaultChips || 1000);
    setChk('set-run-it-twice', s.runItTwice || false);
    setChk('set-rebuy-enabled', s.rebuyEnabled !== false);
    setVal('set-rebuy-min', s.rebuyMin || 200);
    setVal('set-rebuy-max', s.rebuyMax || 2000);

    // Toggle expand/collapse (bind once)
    const header = document.getElementById('settings-toggle');
    if (header && !header._bound) {
      header._bound = true;
      header.addEventListener('click', () => {
        panel.classList.toggle('open');
      });
    }

    // Bind field changes (debounced)
    const fields = ['set-turn-time', 'set-small-blind', 'set-big-blind', 'set-default-chips',
      'set-rebuy-min', 'set-rebuy-max'];
    const checks = ['set-run-it-twice', 'set-rebuy-enabled'];

    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el && !el._bound) {
        el._bound = true;
        let timer;
        el.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => emitSettings(), 500);
        });
      }
    });
    checks.forEach(id => {
      const el = document.getElementById(id);
      if (el && !el._bound) {
        el._bound = true;
        el.addEventListener('change', () => emitSettings());
      }
    });

    function emitSettings() {
      const patches = {};
      patches.turnTime = parseInt(document.getElementById('set-turn-time').value);
      patches.smallBlind = parseInt(document.getElementById('set-small-blind').value);
      patches.bigBlind = parseInt(document.getElementById('set-big-blind').value);
      patches.defaultChips = parseInt(document.getElementById('set-default-chips').value);
      patches.runItTwice = document.getElementById('set-run-it-twice').checked;
      patches.rebuyEnabled = document.getElementById('set-rebuy-enabled').checked;
      patches.rebuyMin = parseInt(document.getElementById('set-rebuy-min').value);
      patches.rebuyMax = parseInt(document.getElementById('set-rebuy-max').value);
      SocketClient.emit('room:updateSettings', patches);
    }
  }

  // Re-render on room update
  AppState.on('room', (room) => {
    if (room && document.getElementById('page-room-lobby').classList.contains('active')) {
      renderRoomLobby();
    }
  });

  return { init, renderRoomLobby };
})();
