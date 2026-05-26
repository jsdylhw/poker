class TexasHoldemUI extends BaseGameUI {
  constructor() {
    super('texas');
    this.phaseNames = {
      preflop: 'Pre-flop',
      flop: 'Flop',
      turn: 'Turn',
      river: 'River',
      showdown: 'Showdown',
      'run-it-twice': 'Run It Twice',
    };
    this.privateState = null;
    this.publicState = null;
    this.selectedAction = null;
    this.raiseAmount = 0;
    this.timerSeconds = 0;
    this._handDealt = false;
    this._lastCommCount = 0;
    this._lastHandKey = '';
    this._lastCommKey = '';
    this._communityAnimationDoneAt = 0;
    this._resultRevealDoneAt = 0;
    this._communityRenderTimer = null;
    this._resultRenderTimer = null;
    this._winSoundTimer = null;
    this._runItTwiceRevealStartedAt = 0;
    this._runItTwiceRevealDoneAt = 0;
    this._showdownUrgentPrompted = false;
  }

  render() {
    this.container.innerHTML = `
      <div class="texas-table">
        <div id="phase-label" class="community-label"></div>
        <div class="community-area">
          <div id="community-cards" class="community-cards">
            ${Array(5).fill('<div class="placeholder"></div>').join('')}
          </div>
        </div>
        <div id="pot-display" class="pot-display">底池: 0</div>
        <div id="seats-container" class="seats-container"></div>
        <div id="winner-area"></div>
        <div id="center-countdown" class="center-countdown hidden"></div>
        <div id="my-hand-area" class="my-hand-area">
          <div id="my-hand" class="my-hand"></div>
          <div id="action-bar" class="action-bar"></div>
        </div>
        <div id="turn-timer" class="turn-timer hidden"></div>
        <button id="btn-stats-toggle" class="btn-stats-toggle">📊</button>
        <div id="stats-panel" class="stats-panel hidden">
          <div class="stats-title">累计战绩</div>
          <div id="stats-content"></div>
        </div>
      </div>
    `;
    // Bind stats toggle
    document.getElementById('btn-stats-toggle').addEventListener('click', () => {
      document.getElementById('stats-panel').classList.toggle('hidden');
    });
  }

  onPrivateState(state) {
    // Detect new hand (community cards reset)
    if (state.communityCards && state.communityCards.length === 0 && this._lastCommCount > 0) {
      this._handDealt = false;
      this._lastCommCount = 0;
      this._communityAnimationDoneAt = 0;
      this._resultRevealDoneAt = 0;
      this._runItTwiceRevealStartedAt = 0;
      this._runItTwiceRevealDoneAt = 0;
      if (this._communityRenderTimer) {
        clearTimeout(this._communityRenderTimer);
        this._communityRenderTimer = null;
      }
      if (this._resultRenderTimer) {
        clearTimeout(this._resultRenderTimer);
        this._resultRenderTimer = null;
      }
      if (this._winSoundTimer) {
        clearTimeout(this._winSoundTimer);
        this._winSoundTimer = null;
      }
    }
    this.privateState = state;
    this._updateUI();
  }

  onPublicState(state) {
    this.publicState = state;
    this._updateUI();
  }

  onAction(action) {
    const player = this._findSeatPlayer(action.playerId);
    const name = player ? player.playerName : action.playerId;
    const isMe = action.playerId === this.myPlayerId;

    if (action.isShowdown) {
      this.showMessage(action.action === 'show' ? `${name} 亮牌` : `${name} 不亮`);
      Sound[action.action === 'show' ? 'chip' : 'fold']();
      if (action.handOver) this._updateUI();
      return;
    }
    if (action.isRunItTwiceChoice) {
      this.showMessage(action.action === 'run-twice' ? `${name} 选择发两次` : `${name} 选择发一次`);
      Sound.chip();
      return;
    }
    if (action.action === 'fold') {
      this.showMessage(`${name} 弃牌`); Sound.fold();
    } else if (action.action === 'check') {
      this.showMessage(`${name} 过牌`); Sound.check();
    } else if (action.action === 'call') {
      this.showMessage(`${name} 跟注 ${action.amount}`); Sound.chip();
    } else if (action.action === 'raise') {
      this.showMessage(`${name} 加注到 ${action.totalBet}`); Sound.raise();
    } else if (action.action === 'all-in') {
      this.showMessage(`${name} ALL IN! ${action.totalBet}`); Sound.allin();
    }

    // My turn notification
    if (!isMe && this.privateState && this.privateState.isMyTurn) {
      Sound.yourTurn();
    }
  }

  onGameEnd(result) {
    this._updateUI();
    const soundAt = Math.max(this._resultRevealDoneAt, this._runItTwiceRevealDoneAt);
    if (Date.now() < soundAt) {
      if (this._winSoundTimer) clearTimeout(this._winSoundTimer);
      this._winSoundTimer = setTimeout(() => {
        this._winSoundTimer = null;
        Sound.win();
      }, Math.max(0, soundAt - Date.now()));
    } else {
      Sound.win();
    }
  }

  _updateUI() {
    if (!this.privateState || !this.publicState) return;

    const ps = this.privateState;
    const pub = this.publicState;

    // Phase label
    const phaseEl = document.getElementById('phase-label');
    if (phaseEl) {
      phaseEl.textContent = pub.runItTwicePhase
        ? this.phaseNames['run-it-twice']
        : (this.phaseNames[pub.phase] || pub.phase);
    }

    // Community cards
    this._renderCommunityCards(ps.communityCards, ps);

    // Pot
    const potEl = document.getElementById('pot-display');
    if (potEl) potEl.textContent = `底池: ${this._formatChips(ps.pot || pub.pot)}`;

    // Stats panel
    this._renderStats(ps.playerStats || pub.playerStats || []);

    // Seats
    this._renderSeats(ps, pub);

    // My hand
    this._renderMyHand(ps);

    // Action bar
    this._renderActionBar(ps);

    // Timer
    this._renderTimer(ps);

    // Winner
    this._renderWinner(ps, pub);
  }

  _scheduleResultRender(when) {
    if (this._resultRenderTimer) clearTimeout(this._resultRenderTimer);
    const delay = Math.max(0, when - Date.now());
    this._resultRenderTimer = setTimeout(() => {
      this._resultRenderTimer = null;
      this._updateUI();
    }, delay);
  }

  _scheduleCommunityReveal(when) {
    if (this._communityRenderTimer) clearTimeout(this._communityRenderTimer);
    const delay = Math.max(0, when - Date.now());
    this._communityRenderTimer = setTimeout(() => {
      this._communityRenderTimer = null;
      this._updateUI();
    }, delay);
  }

  _isCommunityAnimationPending() {
    return Date.now() < this._communityAnimationDoneAt;
  }

  _isResultRevealPending() {
    return Date.now() < this._resultRevealDoneAt;
  }

  _runItTwiceRevealState(results) {
    if (!results?.runItTwice || !results.runouts?.length) return null;
    if (!this._runItTwiceRevealStartedAt) {
      this._runItTwiceRevealStartedAt = Date.now();
    }

    const cardDelay = 1000;
    const winnerPause = 1600;
    const runStates = [];
    let cursor = this._runItTwiceRevealStartedAt;
    const now = Date.now();

    results.runouts.forEach((runout, idx) => {
      const totalCards = runout.communityCards.length;
      const cardsElapsed = now - cursor;
      const visibleCards = cardsElapsed < 0 ? 0 : Math.min(totalCards, Math.floor(cardsElapsed / cardDelay) + 1);
      const winnersAt = cursor + (totalCards * cardDelay);
      const winnersVisible = now >= winnersAt;
      runStates.push({ idx, visibleCards, winnersVisible });
      cursor = winnersAt + winnerPause;
    });

    this._runItTwiceRevealDoneAt = cursor;
    if (now < cursor) this._scheduleResultRender(Math.min(cursor, now + 250));
    return { runStates, done: now >= cursor };
  }

  _renderCommunityCards(cards, ps) {
    const container = document.getElementById('community-cards');
    if (!container) return;

    const count = cards.length;

    // Skip if unchanged (avoids double-render from dual state updates)
    const cardKey = cards.map(c => c.id).join(',');
    if (count === this._lastCommCount && cardKey === this._lastCommKey) return;
    this._lastCommKey = cardKey;

    if (count === 0 && this._lastCommCount > 0) this._lastCommCount = 0;
    const currentPrev = this._lastCommCount;
    const isAllInRunout = !!ps.handOver && count > currentPrev;
    const dealDelay = isAllInRunout ? 1000 : 250;
    if (isAllInRunout) {
      const animationDoneAt = Date.now() + ((count - currentPrev - 1) * dealDelay) + 500;
      this._communityAnimationDoneAt = Math.max(this._communityAnimationDoneAt, animationDoneAt);
      this._resultRevealDoneAt = Math.max(this._resultRevealDoneAt, animationDoneAt + 2300);
      this._scheduleCommunityReveal(this._communityAnimationDoneAt);
      this._scheduleResultRender(this._resultRevealDoneAt);
    }

    // Step 1: always render 5 placeholder divs
    container.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const ph = document.createElement('div');
      ph.className = 'placeholder';
      container.appendChild(ph);
    }

    // Step 2: replace slots that have cards
    for (let i = 0; i < count; i++) {
      if (i < currentPrev) {
        container.replaceChild(CardRenderer.createCard(cards[i]), container.children[i]);
      } else {
        const delay = (i - currentPrev) * dealDelay;
        const card = cards[i];
        setTimeout(() => {
          if (i < container.children.length) {
            const el = CardRenderer.createCard(card);
            el.classList.add('dealing');
            container.replaceChild(el, container.children[i]);
            Sound.deal();
          }
        }, delay);
      }
    }

    this._lastCommCount = count;
  }

  _renderSeats(ps, pub) {
    const container = document.getElementById('seats-container');
    if (!container) return;

    const myIdx = ps.mySeatIndex;
    const seats = ps.seats || pub.seats || [];
    const communityAnimationPending = this._isCommunityAnimationPending();
    const resultRevealPending = this._isResultRevealPending();

    const sdChoices = ps.showdownChoices || pub.showdownChoices || {};
    const sdWinners = ps.showdownPhase && ps.results?.winners ? new Set(ps.results.winners.map(w => w.playerId)) : new Set();

    container.innerHTML = seats.map((s, i) => {
      const isMe = i === myIdx;
      const isCurrent = i === pub.currentPlayerIndex;
      const isDealer = s.isDealer;
      const isSB = s.isSmallBlind;
      const isBB = s.isBigBlind;
      const isSdWinner = sdWinners.has(s.playerId);
      const choseShow = sdChoices[s.playerId] === 'show';
      const revealHand = isMe || (!communityAnimationPending && ((pub.handOver && !s.folded) || isSdWinner || choseShow));
      const animateReveal = revealHand && !isMe && (pub.handOver || choseShow);

      let cls = 'player-row';
      if (isMe) cls += ' is-me';
      if (isCurrent && !pub.handOver) cls += ' active-turn';
      if (s.folded) cls += ' folded';

      const roleTags = [];
      if (isDealer) roleTags.push('<span class="seat-role" style="background:#f1c40f;color:#333">D</span>');
      if (isSB) roleTags.push('<span class="seat-role" style="background:#3498db;color:#fff">SB</span>');
      if (isBB) roleTags.push('<span class="seat-role" style="background:#e74c3c;color:#fff">BB</span>');

      let cardsHtml = '';
      if (revealHand) {
        const handCards = isMe ? (ps.hand || []) : (s.hand || []);
        if (handCards.length > 0) {
          cardsHtml = '<div class="player-cards">' +
            handCards.map((c, idx) => {
              const el = CardRenderer.createCard(c, { small: true });
              if (animateReveal) {
                el.classList.add('dealing');
                el.style.animationDelay = `${idx * 1000}ms`;
              }
              return el.outerHTML;
            }).join('') +
            '</div>';
        }
      } else if (!isMe && s.cardCount > 0) {
        cardsHtml = '<div class="player-cards">' +
          Array(s.cardCount).fill(CardRenderer.createCard(null, { faceUp: false, small: true }).outerHTML).join('') +
          '</div>';
      }

      const betStr = s.roundBet > 0 ? ` 下注 ${s.roundBet}` : '';
      const handNet = (s.wonAmount || 0) - (s.totalBet || 0);
      const netStr = pub.handOver && !resultRevealPending && handNet !== 0 ? `${handNet > 0 ? '+' : ''}${handNet}` : '';
      const netClass = handNet >= 0 ? 'player-won' : 'player-lost';

      return `
        <div class="${cls}">
          <div class="player-info">
            <span class="player-name">${isMe ? '👤 ' : ''}${s.playerName}</span>
            <span class="player-chips">${s.chips}</span>
            ${roleTags.join('')}
            ${betStr ? `<span class="player-bet">${betStr}</span>` : ''}
            ${s.allIn ? '<span class="player-allin">ALL IN</span>' : ''}
          ${s.rebuyCooldown > 0 ? `<span class="player-cooldown">冷板凳 ${s.rebuyCooldown}局</span>` : ''}
            ${isSdWinner && !resultRevealPending ? '<span class="player-winner">赢家</span>' : ''}
            ${netStr ? `<span class="${netClass}">${netStr}</span>` : ''}
            ${sdChoices[s.playerId] && !resultRevealPending ? `<span class="player-sd-choice">${sdChoices[s.playerId]==='show'?'亮牌':'不亮'}</span>` : ''}
          </div>
          ${cardsHtml}
        </div>
      `;
    }).join('');
  }

  _renderMyHand(ps) {
    const container = document.getElementById('my-hand');
    if (!container) return;
    const hand = ps.hand || [];
    const isFolded = ps.myFolded;

    if (isFolded || hand.length === 0) {
      container.innerHTML = '';
      this._handDealt = false;
      return;
    }

    // Skip if hand hasn't changed (avoids double-render from dual state updates)
    const handKey = hand.map(c => c.id).sort().join(',');
    if (handKey === this._lastHandKey) return;
    this._lastHandKey = handKey;

    // Animate on first deal of each hand
    if (!this._handDealt && hand.length > 0) {
      this._handDealt = true;
      CardRenderer.dealCards(container, hand, { delay: 200, sort: true });
    } else {
      CardRenderer.renderHand(container, hand, { sort: true });
    }
  }

  _renderActionBar(ps) {
    const bar = document.getElementById('action-bar');
    if (!bar) return;

    const settings = ps.settings || {};

    if (ps.runItTwicePhase && ps.isMyTurn) {
      bar.innerHTML = `
        <button class="btn-success action-btn" data-action="run-twice">发两次</button>
        <button class="btn-secondary action-btn" data-action="run-once">发一次</button>
      `;
      bar.querySelectorAll('.action-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          SocketClient.emit('game:action', { action: btn.dataset.action });
        });
      });
      return;
    }

    if (ps.runItTwicePhase) {
      bar.innerHTML = '<span style="color:rgba(255,255,255,0.5);font-size:13px">等待选择发牌次数...</span>';
      return;
    }

    // Showdown phase: show/muck buttons
    if (ps.showdownPhase && ps.isMyTurn) {
      const actions = ps.validActions || [];
      const urgent = ps.showdownTimeLeft != null && ps.showdownTimeLeft <= 5;
      const label = urgent ? `最后 ${ps.showdownTimeLeft}s，请选择` : `亮牌倒计时 ${ps.showdownTimeLeft}s`;
      const timeText = ps.showdownTimeLeft != null ? `<span style="color:${urgent ? '#e74c3c' : '#f1c40f'};font-size:13px;font-weight:${urgent ? 'bold' : 'normal'}">${label}</span>` : '';
      bar.innerHTML = [
        timeText,
        actions.includes('show')
          ? '<button class="btn-success action-btn" data-action="show">亮牌</button>'
          : '',
        actions.includes('muck')
          ? '<button class="btn-danger action-btn" data-action="muck">不亮</button>'
          : '',
      ].join('');
      bar.querySelectorAll('.action-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          SocketClient.emit('game:action', { action: btn.dataset.action });
        });
      });
      return;
    }

    // Showdown phase: winner auto-shown, waiting for others
    if (ps.showdownPhase && ps.isShowdownWinner) {
      const urgent = ps.showdownTimeLeft != null && ps.showdownTimeLeft <= 5;
      const timeText = ps.showdownTimeLeft != null ? ` · ${urgent ? '最后 ' : ''}${ps.showdownTimeLeft}s 后下一局` : '';
      bar.innerHTML = `<span style="color:#f1c40f;font-size:14px;font-weight:bold">赢家 - 已亮牌${timeText}</span>`;
      return;
    }

    // Showdown phase: already decided or waiting
    if (ps.showdownPhase) {
      const urgent = ps.showdownTimeLeft != null && ps.showdownTimeLeft <= 5;
      const timeText = ps.showdownTimeLeft != null ? `${urgent ? '最后 ' : ''}${ps.showdownTimeLeft}s 后自动下一局` : '等待摊牌倒计时...';
      bar.innerHTML = `<span style="color:${urgent ? '#e74c3c' : 'rgba(255,255,255,0.65)'};font-size:13px;font-weight:${urgent ? 'bold' : 'normal'}">${timeText}</span>`;
      return;
    }

    if (!ps.isMyTurn || ps.handOver) {
      let html = '';
      const effectiveChips = ps.myEffectiveChips ?? ps.myChips;
      const canRebuyOutOfHand = effectiveChips === 0 && (ps.handOver || ps.rebuyCooldown >= 0) && (ps.hand?.length || 0) === 0;
      // A busted player may rebuy while sitting out of the current hand.
      if (settings.rebuyEnabled !== false && canRebuyOutOfHand && !ps.myFolded) {
        html += this._rebuyHtml(settings);
      }
      let waitMsg = '等待其他玩家操作...';
      if (ps.rebuyCooldown > 0) waitMsg = `坐冷板凳 - 还需等待 ${ps.rebuyCooldown} 局`;
      html += ps.handOver
        ? (this._isDealer(ps) ? '<button class="btn-gold" id="btn-next-hand">开始下一局</button>' : '<span style="color:rgba(255,255,255,0.5);font-size:13px">等待庄家开始下一局...</span>')
        : `<span style="color:rgba(255,255,255,0.5);font-size:13px">${waitMsg}</span>`;
      bar.innerHTML = html;
      this._bindNextHandBtn();
      this._bindRebuy();
      return;
    }

    const actions = ps.validActions || [];
    const maxBet = Math.max(...(ps.seats || []).map(s => s.roundBet), 0);
    const toCall = maxBet - (ps.myRoundBet || 0);
    const minRaise = maxBet + Math.max(settings.bigBlind || 20, 20);
    const pot = ps.pot || 0;
    const maxRaise = (ps.myChips || 0) + (ps.myRoundBet || 0);
    const canRaiseWithoutAllIn = actions.includes('raise') && minRaise <= maxRaise;
    const callAmount = Math.min(Math.max(0, toCall), ps.myChips || 0);
    const callLabel = callAmount < toCall ? `跟注 All-in ${callAmount}` : `跟注 ${toCall}`;
    const getRaiseAmount = () => {
      const input = document.getElementById('raise-custom');
      const raw = input ? parseInt(input.value, 10) : minRaise;
      const amount = Number.isFinite(raw) ? raw : minRaise;
      return Math.max(minRaise, Math.min(maxRaise, amount));
    };

    let html = '';
    html += `
      <div class="bet-status">
        <span>需跟注 <strong>${Math.max(0, toCall)}</strong></span>
        <span>筹码 <strong>${this._formatChips(ps.myChips || 0)}</strong></span>
      </div>
    `;

    if (actions.includes('fold')) {
      html += '<button class="btn-danger action-btn" data-action="fold">弃牌</button>';
    }
    if (actions.includes('check')) {
      html += '<button class="btn-secondary action-btn" data-action="check">过牌</button>';
    }
    if (actions.includes('call') && toCall > 0 && callAmount > 0) {
      html += `<button class="btn-primary action-btn" data-action="call">${callLabel}</button>`;
    }
    if (canRaiseWithoutAllIn) {
      const halfPot = Math.max(minRaise, Math.floor(pot / 2));
      const fullPot = Math.max(minRaise, pot);
      const quickBets = [
        { label: '下半池', amount: halfPot },
        { label: '下全池', amount: fullPot },
      ].filter(b => b.amount <= maxRaise);
      html += `
        <div class="raise-btns">
          ${quickBets.map(b => `<button class="btn-success action-btn raise-quick" data-amount="${b.amount}">${b.label} ${b.amount}</button>`).join('')}
          <div class="raise-input">
            <input type="number" id="raise-custom" min="${minRaise}" max="${maxRaise}" value="${minRaise}" placeholder="${minRaise}">
            <button class="btn-success action-btn" data-action="raise" id="btn-raise">自定义 <span id="raise-amount">${minRaise}</span></button>
          </div>
        </div>
      `;
    }
    if (actions.includes('all-in')) {
      html += `<button class="btn-gold action-btn" data-action="all-in">All-in ${ps.myChips + (ps.myRoundBet || 0)}</button>`;
    }

    bar.innerHTML = html;

    // Bind quick raise buttons
    bar.querySelectorAll('.raise-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        SocketClient.emit('game:action', { action: 'raise', data: { amount: parseInt(btn.dataset.amount) } });
      });
    });

    // Bind custom raise
    const raiseInput = document.getElementById('raise-custom');
    if (raiseInput) {
      const updateRaiseLabel = () => {
        const amountEl = document.getElementById('raise-amount');
        if (amountEl) amountEl.textContent = raiseInput.value;
      };
      raiseInput.addEventListener('input', updateRaiseLabel);
      // Enter key triggers raise
      raiseInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          SocketClient.emit('game:action', { action: 'raise', data: { amount: getRaiseAmount() } });
        }
      });
    }

    // Bind action buttons (fold, check, call, raise, all-in)
    bar.querySelectorAll('.action-btn:not(.raise-quick)').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        let data = {};
        if (action === 'raise') {
          data.amount = getRaiseAmount();
        }
        SocketClient.emit('game:action', { action, data });
      });
    });

    this._bindRebuy();
  }

  _rebuyHtml(settings) {
    const min = settings.rebuyMin || 200;
    const max = settings.rebuyMax || 2000;
    return `
      <div class="rebuy-area">
        <input type="number" id="rebuy-amount" min="${min}" max="${max}" value="${min}">
        <button class="btn-secondary" id="btn-rebuy">补筹码</button>
      </div>
    `;
  }

  _bindRebuy() {
    const btn = document.getElementById('btn-rebuy');
    if (btn && !btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', () => {
        const amount = parseInt(document.getElementById('rebuy-amount').value);
        SocketClient.emit('game:rebuy', { amount });
      });
    }
  }

  _renderTimer(ps) {
    const el = document.getElementById('center-countdown');
    if (!el) return;

    if ((ps.showdownPhase || ps.isMyTurn) && !ps.handOver) {
      if (this.timerInterval) clearInterval(this.timerInterval);
      this.timerSeconds = ps.showdownPhase ? (ps.showdownTimeLeft || 10) : (ps.turnTimeLeft || 30);
      el.classList.remove('hidden');
      el.classList.remove('urgent');
      el.textContent = this._timerText(ps, this.timerSeconds);
      if (ps.showdownPhase && this.timerSeconds <= 5 && !this._showdownUrgentPrompted) {
        this._showdownUrgentPrompted = true;
        Sound.countdownAlert();
      }

      this.timerInterval = setInterval(() => {
        this.timerSeconds = Math.max(0, this.timerSeconds - 1);
        el.textContent = this._timerText(ps, this.timerSeconds);
        if (this.timerSeconds <= 10) {
          el.classList.add('urgent');
          Sound.tick();
          if (ps.showdownPhase && this.timerSeconds <= 5 && !this._showdownUrgentPrompted) {
            this._showdownUrgentPrompted = true;
            Sound.countdownAlert();
          }
        }
        // Let server handle timeout via its own timer
      }, 1000);
    } else {
      if (this.timerInterval) clearInterval(this.timerInterval);
      el.classList.add('hidden');
      this._showdownUrgentPrompted = false;
    }
  }

  _timerText(ps, seconds) {
    if (ps.showdownPhase) {
      if (ps.isMyTurn) return seconds <= 5 ? `最后 ${seconds}s 请选择` : `亮牌倒计时 ${seconds}s`;
      return seconds <= 5 ? `最后 ${seconds}s 后下一局` : `${seconds}s 后自动下一局`;
    }
    return `你的回合 ${seconds}s`;
  }

  _renderWinner(ps, pub) {
    const area = document.getElementById('winner-area');
    if (!area) return;

    if (!(pub.handOver || pub.showdownPhase) || !ps.results || this._isResultRevealPending()) {
      area.innerHTML = '';
      return;
    }

    const results = ps.results;
    let html = '';
    const runItTwiceReveal = this._runItTwiceRevealState(results);

    // Run It Twice display
    if (results.runItTwice && results.runouts) {
      html += '<div class="run-it-twice-section">';
      results.runouts.forEach((runout, idx) => {
        const reveal = runItTwiceReveal?.runStates[idx] || { visibleCards: runout.communityCards.length, winnersVisible: true };
        const visibleCards = runout.communityCards.slice(0, reveal.visibleCards);
        const winners = runout.winners || [];
        const winnerLines = winners.map(w => {
          const seat = ps.seats.find(s => s.playerId === w.playerId);
          const name = seat ? seat.playerName : w.playerId;
          const handName = w.hand?.name ? ` - ${w.hand.name}` : '';
          return `<div class="run-it-twice-winner">${name} 赢${handName}</div>`;
        }).join('');
        html += `<div class="run-it-twice-col">
          <span class="run-it-twice-label">Run ${idx + 1}</span>
          <div class="run-it-twice-cards">`;
        visibleCards.forEach(card => {
          html += CardRenderer.createCard(card, { small: true }).outerHTML;
        });
        const placeholders = Math.max(0, runout.communityCards.length - visibleCards.length);
        for (let i = 0; i < placeholders; i++) {
          html += '<div class="placeholder"></div>';
        }
        html += `</div>${reveal.winnersVisible ? winnerLines : ''}</div>`;
      });
      html += '</div>';
    }

    const winners = results.winners || [];
    if (winners.length > 0 && (!runItTwiceReveal || runItTwiceReveal.done)) {
      const winnerIds = new Set(winners.map(w => w.playerId));
      const lines = ps.playerStats.map(s => {
        const playerName = s.playerName;
        const seat = ps.seats.find(ss => ss.playerId === s.playerId);
        const totalBet = seat ? (seat.totalBet || 0) : 0;
        const handNet = (s.wonAmount || 0) - totalBet;
        const netText = `${handNet >= 0 ? '+' : ''}${handNet}`;
        if (winnerIds.has(s.playerId)) {
          const w = winners.find(ww => ww.playerId === s.playerId);
          const handName = w && w.hand ? w.hand.name : '';
          const netStyle = handNet >= 0 ? '' : ' style="color:#e74c3c"';
          return `<div class="winner-name"${netStyle}>${playerName} ${netText}</div>
            ${handName ? `<div class="winner-hand">${handName}</div>` : ''}`;
        } else {
          return `<div class="winner-name" style="color:#e74c3c">${playerName} ${netText}</div>`;
        }
      }).join('');
      html += `<div class="winner-overlay"><div class="winner-hand">本局净输赢</div>${lines}</div>`;
    }

    area.innerHTML = html;
  }

  _bindNextHandBtn() {
    const btn = document.getElementById('btn-next-hand');
    if (btn && !btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', () => {
        SocketClient.emit('game:start', {});
      });
    }
  }

  _findSeatPlayer(playerId) {
    if (!this.privateState || !this.privateState.seats) return null;
    return this.privateState.seats.find(s => s.playerId === playerId);
  }

  _renderStats(stats) {
    const content = document.getElementById('stats-content');
    if (!content) return;
    content.innerHTML = stats.map(s => {
      const netClass = s.net >= 0 ? 'stats-profit' : 'stats-loss';
      const netSign = s.net >= 0 ? '+' : '';
      return `
        <div class="stats-row">
          <span class="stats-name">${s.playerName}${s.isOnline ? '' : ' ⚫'}</span>
          <span class="stats-detail">带入 ${s.buyin}</span>
          <span class="${netClass}">${netSign}${s.net}</span>
        </div>
      `;
    }).join('');
  }

  _isDealer(ps) {
    if (!ps.seats) return false;
    const mySeat = ps.seats[ps.mySeatIndex];
    return mySeat && mySeat.isDealer;
  }

  _formatChips(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  destroy() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    super.destroy();
  }
}

GameUIRegistry.register('texas', TexasHoldemUI);
