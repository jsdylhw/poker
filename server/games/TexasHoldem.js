const GameSession = require('./GameSession');
const Deck = require('../cards/Deck');
const { evaluateHand, HAND_NAMES } = require('../cards/CardPatterns');

class TexasHoldem extends GameSession {
  constructor(room, io) {
    super(room, io);
    this.phase = 'preflop';
    this.seats = [];
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.dealerIndex = 0;
    this.currentPlayerIndex = -1;
    this.settings = room.settings;
    this.smallBlind = this.settings.smallBlind;
    this.bigBlind = this.settings.bigBlind;
    this.defaultChips = this.settings.defaultChips;
    this.turnTime = this.settings.turnTime || 30;
    this.runItTwice = this.settings.runItTwice || false;
    this.minRaise = this.bigBlind;
    this.lastRaiseAmount = 0;
    this.playersToAct = new Set();
    this.handOver = false;
    this.results = null;
    this.showdownPhase = false;
    this.showdownChoices = {};
    this.showdownOrder = [];
    this._turnTimerId = null;
    this._turnStartedAt = 0;
  }

  start() {
    const players = this.room.players;
    if (players.length < 2) return { error: '至少需要2名玩家' };
    if (players.length > 9) return { error: '最多9名玩家' };

    // If continuing after hand end, just start a new hand
    if (this.state === 'ended' || this.handOver) {
      this._collectWinnings();
      this._startNewHand();
      this.state = 'playing';
      return { success: true };
    }

    // Sort by lobby seatIndex, room may have been shuffled by host
    const sorted = [...players].sort((a, b) => a.seatIndex - b.seatIndex);

    this.seats = sorted.map(p => ({
      playerId: p.id,
      hand: [],
      chips: this.defaultChips,
      totalBuyin: this.defaultChips,
      folded: false,
      allIn: false,
      roundBet: 0,
      totalBet: 0,
      wonAmount: 0,
    }));

    // Set dealer to last seat so _startNewHand rotates to seat 0 first
    this.dealerIndex = this.seats.length - 1;
    this.state = 'playing';
    this._startNewHand();
    return { success: true };
  }

  _collectWinnings() {
    // Add wonAmount to chips, then reset
    for (const seat of this.seats) {
      seat.chips += seat.wonAmount;
      seat.wonAmount = 0;
    }
  }

  _startNewHand() {
    // Reset for new hand
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.handOver = false;
    this.results = null;
    this.showdownPhase = false;
    this.showdownChoices = {};
    this.showdownOrder = [];
    this.actionHistory = [];

    // Reset seats
    this.seats.forEach(seat => {
      seat.hand = [];
      seat.folded = false;
      seat.allIn = false;
      seat.roundBet = 0;
      seat.totalBet = 0;
    });

    // Remove players with no chips
    const activeBefore = this.seats.filter(s => s.chips > 0);
    if (activeBefore.length < 2) {
      // Game over - someone wins
      this.state = 'ended';
      return;
    }

    // Rotate dealer
    this.dealerIndex = this._nextActiveSeat(this.dealerIndex);

    // Post blinds
    this.phase = 'preflop';
    const deck = Deck.createStandard52().shuffle();

    // Deal 2 cards to each active player
    for (const seat of this.seats) {
      if (seat.chips > 0) {
        seat.hand = deck.deal(2);
      }
    }

    // Post blinds
    const sbIndex = this._nextActiveSeat(this.dealerIndex);
    const bbIndex = this._nextActiveSeat(sbIndex);

    if (sbIndex !== -1) {
      const sbSeat = this.seats[sbIndex];
      const sbAmount = Math.min(this.smallBlind, sbSeat.chips);
      sbSeat.chips -= sbAmount;
      sbSeat.roundBet = sbAmount;
      if (sbSeat.chips === 0) sbSeat.allIn = true;
    }

    if (bbIndex !== -1) {
      const bbSeat = this.seats[bbIndex];
      const bbAmount = Math.min(this.bigBlind, bbSeat.chips);
      bbSeat.chips -= bbAmount;
      bbSeat.roundBet = bbAmount;
      if (bbSeat.chips === 0) bbSeat.allIn = true;
    }

    this.minRaise = this.bigBlind;
    this.lastRaiseAmount = this.bigBlind;

    // Set first to act
    // Preflop: after big blind (in heads-up, dealer/small blind acts first)
    const activePlayers = this.seats.filter(s => s.chips > 0 && !s.allIn);
    if (activePlayers.length <= 1) {
      // Edge case: all but one all-in after blinds
      this.currentPlayerIndex = -1;
      this._advancePhase();
    } else {
      if (this.seats.filter(s => s.chips > 0).length === 2) {
        // Heads-up: dealer acts first preflop
        this.currentPlayerIndex = this.dealerIndex;
      } else {
        this.currentPlayerIndex = this._nextActiveSeat(bbIndex);
      }
      // Track who still needs to act this round
      this._resetPlayersToAct();
    }

    // Start turn timer for first player
    this._startTurnTimer();
  }

  _onTurnChange() {
    this._startTurnTimer();
  }

  _nextActiveSeat(fromIndex) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const idx = (fromIndex + i) % n;
      const seat = this.seats[idx];
      if (seat.chips > 0 && !seat.folded) return idx;
    }
    return -1;
  }

  _nextSeatToAct(fromIndex) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const idx = (fromIndex + i) % n;
      const seat = this.seats[idx];
      if (!seat.folded && !seat.allIn) return idx;
    }
    return -1;
  }

  _resetPlayersToAct() {
    this.playersToAct.clear();
    for (let i = 0; i < this.seats.length; i++) {
      const seat = this.seats[i];
      if (!seat.folded && !seat.allIn) {
        this.playersToAct.add(i);
      }
    }
    // Current player is ABOUT to act, keep them in the set.
    // They will be removed after they act in handleAction.
  }

  _roundComplete() {
    // Round ends when no one left to act AND all bets equal
    if (this.playersToAct.size > 0) return false;

    // Check all active players have equal round bets or are all-in
    const activeNotAllIn = this.seats.filter(s => !s.folded && !s.allIn);
    if (activeNotAllIn.length <= 1) return true;

    const firstBet = activeNotAllIn[0].roundBet;
    return activeNotAllIn.every(s => s.roundBet === firstBet);
  }

  _advancePhase() {
    // Collect round bets into pot
    for (const seat of this.seats) {
      this.pot += seat.roundBet;
      seat.totalBet += seat.roundBet;
      seat.roundBet = 0;
    }

    // Check if hand is over (only one player left)
    const activePlayers = this.seats.filter(s => !s.folded);
    if (activePlayers.length === 1) {
      this._awardPot([activePlayers[0]]);
      this.handOver = true;
      return;
    }

    // Count players with chips remaining (not all-in)
    const canAct = this.seats.filter(s => !s.folded && !s.allIn && s.chips > 0);

    // Check for Run It Twice: all remaining players are all-in
    if (canAct.length === 0 && this.runItTwice && this.phase !== 'river' && this.phase !== 'showdown') {
      const activePlayers = this.seats.filter(s => !s.folded);
      if (activePlayers.length >= 2) {
        this._runItTwiceShowdown(activePlayers);
        this.handOver = true;
        this._stopTurnTimer();
        return;
      }
    }

    switch (this.phase) {
      case 'preflop':
        this.phase = 'flop';
        this.communityCards = this._dealCommunity(3);
        break;
      case 'flop':
        this.phase = 'turn';
        this.communityCards.push(...this._dealCommunity(1));
        break;
      case 'turn':
        this.phase = 'river';
        this.communityCards.push(...this._dealCommunity(1));
        break;
      case 'river':
        this._startShowdownDecisions();
        return;
    }

    // Reset for new round
    this.seats.forEach(s => { s.roundBet = 0; });
    this.minRaise = this.bigBlind;
    this.lastRaiseAmount = 0;

    // Determine who acts first in new round (first active left of dealer)
    this.currentPlayerIndex = this._nextSeatToAct(this.dealerIndex);

    if (canAct.length <= 1 && this.currentPlayerIndex === -1) {
      // All remaining players are all-in, run out community
      if (this.runItTwice) {
        const activePlayers = this.seats.filter(s => !s.folded);
        this._runItTwiceShowdown(activePlayers);
      } else {
        this._runoutCommunity();
        this._startShowdownDecisions();
      }
      return;
    }

    this._resetPlayersToAct();
    this._startTurnTimer();
  }

  _runoutCommunity() {
    // Deal remaining community cards when everyone is all-in
    const deck = Deck.createStandard52().shuffle(); // new deck just for community
    if (this.phase === 'preflop') {
      this.communityCards = deck.deal(5);
    } else if (this.phase === 'flop') {
      this.communityCards.push(...deck.deal(2));
    } else if (this.phase === 'turn') {
      this.communityCards.push(...deck.deal(1));
    }
  }

  _dealCommunity(count) {
    // Use fresh cards - in a real game we'd track the deck, but for simplicity
    const deck = Deck.createStandard52().shuffle();
    return deck.deal(count);
  }

  handleAction(playerId, action, data) {
    if (this.state !== 'playing') return { error: '游戏未在进行中' };
    if (this.handOver) return { error: '本局已结束' };

    const seatIndex = this.seats.findIndex(s => s.playerId === playerId);
    if (seatIndex === -1) return { error: '玩家不在座位上' };
    if (!this.showdownPhase && seatIndex !== this.currentPlayerIndex) return { error: '还没轮到你' };

    const seat = this.seats[seatIndex];

    // Showdown phase: allow folded/all-in players to show/muck
    if (this.showdownPhase) {
      if (action !== 'show' && action !== 'muck') return { error: '请选择亮牌或不亮' };
      const player = this.room.getPlayer(playerId);
      this.showdownChoices[playerId] = action;

      this.actionHistory.push({ playerId, action, phase: 'showdown' });

      // Move to next undecided player
      const nextUndecided = this.showdownOrder.find(pid => this.showdownChoices[pid] === null);
      if (nextUndecided) {
        this.currentPlayerIndex = this._getSeatIndex(nextUndecided);
        this._startTurnTimer();
      } else {
        this._finishShowdown();
      }

      return {
        publicAction: {
          action,
          playerId,
          playerName: player ? player.name : '',
          seatIndex,
          isShowdown: true,
          handOver: this.handOver,
        },
      };
    }

    let result;
    switch (action) {
      case 'fold':   result = this._doFold(seatIndex); break;
      case 'check':  result = this._doCheck(seatIndex); break;
      case 'call':   result = this._doCall(seatIndex); break;
      case 'raise':  result = this._doRaise(seatIndex, data?.amount); break;
      case 'all-in': result = this._doAllIn(seatIndex); break;
      default: return { error: '无效操作' };
    }

    if (result.error) return result;

    this.actionHistory.push({
      playerId,
      action,
      amount: result.amount,
      phase: this.phase,
    });

    // Check if hand is over (only one player left after fold/all-in)
    const remainingPlayers = this.seats.filter(s => !s.folded);
    if (remainingPlayers.length <= 1) {
      if (remainingPlayers.length === 1) {
        // Collect all pending bets into pot before awarding
        for (const seat of this.seats) {
          this.pot += seat.roundBet;
          seat.roundBet = 0;
        }
        this._calculateSidePots();
        this._awardSidePots([{
          playerId: remainingPlayers[0].playerId,
          seatIndex: this._getSeatIndex(remainingPlayers[0].playerId),
          hand: remainingPlayers[0].hand,
          score: 0, name: '',
        }]);
        this.results = {
          winners: [{ playerId: remainingPlayers[0].playerId, amount: remainingPlayers[0].wonAmount }],
        };
      }
      // Enter showdown so everyone (incl. folded) can show cards
      // Fold-all win: winner doesn't auto-show, they choose like everyone
      this._startShowdownDecisions(true);
      return { publicAction: result };
    }

    // If round is complete, advance phase
    if (this._roundComplete()) {
      this._advancePhase();
      return { publicAction: result };
    }

    // Remove current player (just acted) from "to act" set, then advance to next
    this.playersToAct.delete(this.currentPlayerIndex);
    this.currentPlayerIndex = this._nextSeatToAct(this.currentPlayerIndex);

    if (this.currentPlayerIndex === -1 || this._roundComplete()) {
      this._advancePhase();
    } else {
      this._startTurnTimer();
    }

    return { publicAction: result };
  }

  _doFold(seatIndex) {
    const seat = this.seats[seatIndex];
    const player = this.room.getPlayer(seat.playerId);
    seat.folded = true;
    return {
      action: 'fold',
      playerId: seat.playerId,
      playerName: player ? player.name : '',
      seatIndex,
    };
  }

  _doCheck(seatIndex) {
    const seat = this.seats[seatIndex];
    const player = this.room.getPlayer(seat.playerId);
    const maxBet = Math.max(...this.seats.map(s => s.roundBet));
    if (seat.roundBet < maxBet) return { error: '必须跟注或加注' };

    return {
      action: 'check',
      playerId: seat.playerId,
      playerName: player ? player.name : '',
      seatIndex,
    };
  }

  _doCall(seatIndex) {
    const seat = this.seats[seatIndex];
    const player = this.room.getPlayer(seat.playerId);
    const maxBet = Math.max(...this.seats.map(s => s.roundBet));
    const toCall = maxBet - seat.roundBet;

    if (toCall <= 0) return { error: '无需跟注，可以过牌' };

    const callAmount = Math.min(toCall, seat.chips);
    seat.chips -= callAmount;
    seat.roundBet += callAmount;

    if (seat.chips === 0) seat.allIn = true;

    return {
      action: 'call',
      playerId: seat.playerId,
      playerName: player ? player.name : '',
      seatIndex,
      amount: callAmount,
      isAllIn: seat.allIn,
    };
  }

  _doRaise(seatIndex, amount) {
    const seat = this.seats[seatIndex];
    const player = this.room.getPlayer(seat.playerId);
    const maxBet = Math.max(...this.seats.map(s => s.roundBet));
    const toCall = maxBet - seat.roundBet;
    const minTotalBet = maxBet + Math.max(this.minRaise, this.lastRaiseAmount);

    if (amount == null || amount < minTotalBet) {
      return { error: `加注至少需要 ${minTotalBet} 筹码` };
    }
    if (amount > seat.chips + seat.roundBet) {
      return { error: '筹码不足' };
    }

    const totalNeeded = amount - seat.roundBet;
    seat.chips -= totalNeeded;
    seat.roundBet = amount;
    this.lastRaiseAmount = amount - maxBet;
    this.minRaise = this.lastRaiseAmount;

    if (seat.chips === 0) seat.allIn = true;

    // Reset who needs to act (everyone except raiser)
    this._resetPlayersToAct();
    this.playersToAct.delete(seatIndex);

    return {
      action: 'raise',
      playerId: seat.playerId,
      playerName: player ? player.name : '',
      seatIndex,
      amount: totalNeeded,
      totalBet: seat.roundBet,
      isAllIn: seat.allIn,
    };
  }

  _doAllIn(seatIndex) {
    const seat = this.seats[seatIndex];
    const player = this.room.getPlayer(seat.playerId);
    const allInAmount = seat.chips;

    if (allInAmount === 0) return { error: '已无筹码' };

    const maxBet = Math.max(...this.seats.map(s => s.roundBet));
    seat.roundBet += allInAmount;
    seat.chips = 0;
    seat.allIn = true;

    // If all-in amount is a valid raise, update raise tracking
    if (seat.roundBet - maxBet >= this.minRaise) {
      this.lastRaiseAmount = seat.roundBet - maxBet;
      this.minRaise = this.lastRaiseAmount;
      this._resetPlayersToAct();
      this.playersToAct.delete(seatIndex);
    }

    return {
      action: 'all-in',
      playerId: seat.playerId,
      playerName: player ? player.name : '',
      seatIndex,
      amount: allInAmount,
      totalBet: seat.roundBet,
    };
  }

  _doShowdown() {
    const activePlayers = this.seats.filter(s => !s.folded);
    this._calculateSidePots();

    // Evaluate hands for all non-folded players
    const evaluations = [];
    for (const seat of activePlayers) {
      const allCards = [...seat.hand, ...this.communityCards];
      const evalResult = evaluateHand(allCards);
      evaluations.push({
        playerId: seat.playerId,
        seatIndex: this.seats.indexOf(seat),
        hand: seat.hand,
        ...evalResult,
      });
    }

    // Award pots
    this._awardSidePots(evaluations);

    this.results = {
      evaluations,
      pot: this.pot,
      sidePots: this.sidePots,
      winners: this.seats
        .filter(s => s.wonAmount > 0)
        .map(s => ({
          playerId: s.playerId,
          amount: s.wonAmount,
          hand: evaluations.find(e => e.playerId === s.playerId),
        })),
    };
  }

  _calculateSidePots() {
    // Sort by totalBet ascending
    const activeSeats = this.seats
      .map((s, i) => ({ ...s, idx: i }))
      .filter(s => !s.folded)
      .sort((a, b) => a.totalBet - b.totalBet);

    this.sidePots = [];
    let prevLevel = 0;

    for (const seat of activeSeats) {
      const contribution = seat.totalBet - prevLevel;
      if (contribution > 0) {
        const eligible = activeSeats
          .filter(s => s.totalBet >= seat.totalBet)
          .map(s => s.playerId);
        const potAmount = contribution * eligible.length;
        this.sidePots.push({ amount: potAmount, eligiblePlayerIds: eligible });
        prevLevel = seat.totalBet;
      }
    }
  }

  _awardSidePots(evaluations) {
    for (const sidePot of this.sidePots) {
      const eligible = evaluations.filter(e =>
        sidePot.eligiblePlayerIds.includes(e.playerId) && !this.seats[this._getSeatIndex(e.playerId)].folded
      );
      eligible.sort((a, b) => b.score - a.score);

      const winners = [];
      for (const e of eligible) {
        if (winners.length === 0 || e.score === winners[0].score) {
          winners.push(e);
        } else {
          break;
        }
      }

      const share = Math.floor(sidePot.amount / winners.length);
      let remainder = sidePot.amount - share * winners.length;

      for (const winner of winners) {
        const seatIdx = this._getSeatIndex(winner.playerId);
        this.seats[seatIdx].wonAmount += share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
      }
    }
  }

  _awardPot(winners) {
    const share = Math.floor(this.pot / winners.length);
    let remainder = this.pot - share * winners.length;
    for (const winner of winners) {
      const seat = this.seats.find(s => s.playerId === winner.playerId);
      if (seat) {
        seat.wonAmount += share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
      }
    }
  }

  _runItTwiceShowdown(activePlayers) {
    // Calculate side pots first
    this._calculateSidePots();

    // Store original community cards
    const savedPhase = this.phase;
    const savedCommunity = [...this.communityCards];

    // Determine how many more community cards are needed
    let cardsNeeded;
    if (this.phase === 'preflop') cardsNeeded = 5;
    else if (this.phase === 'flop') cardsNeeded = 2;
    else if (this.phase === 'turn') cardsNeeded = 1;
    else cardsNeeded = 0;

    // Create two runouts from a single deck (no card duplication)
    const masterDeck = Deck.createStandard52().shuffle();
    const runouts = [];
    for (let r = 0; r < 2; r++) {
      const extraCards = masterDeck.deal(cardsNeeded);
      const fullCommunity = [...savedCommunity, ...extraCards];

      const evaluations = [];
      for (const seat of activePlayers) {
        const allCards = [...seat.hand, ...fullCommunity];
        const evalResult = evaluateHand(allCards);
        evaluations.push({
          playerId: seat.playerId,
          seatIndex: this._getSeatIndex(seat.playerId),
          hand: seat.hand,
          ...evalResult,
        });
      }

      runouts.push({
        communityCards: fullCommunity,
        evaluations,
      });
    }

    // Side pots are already set. Split each side pot into two halves.
    this.phase = 'showdown';
    this.results = {
      runItTwice: true,
      runouts,
      sidePots: this.sidePots,
      winners: [],
    };

    // Evaluate each side pot with two runouts
    for (const sidePot of this.sidePots) {
      const halfAmount1 = Math.floor(sidePot.amount / 2);
      const halfAmount2 = sidePot.amount - halfAmount1;

      for (let r = 0; r < 2; r++) {
        const runout = runouts[r];
        const halfAmount = r === 0 ? halfAmount1 : halfAmount2;

        const eligible = runout.evaluations.filter(e =>
          sidePot.eligiblePlayerIds.includes(e.playerId) &&
          !this.seats[this._getSeatIndex(e.playerId)].folded
        );
        eligible.sort((a, b) => b.score - a.score);

        const winGroup = [];
        for (const e of eligible) {
          if (winGroup.length === 0 || e.score === winGroup[0].score) {
            winGroup.push(e);
          } else break;
        }

        const share = Math.floor(halfAmount / winGroup.length);
        let remainder = halfAmount - share * winGroup.length;

        for (const winner of winGroup) {
          const seatIdx = this._getSeatIndex(winner.playerId);
          if (seatIdx !== -1) {
            this.seats[seatIdx].wonAmount += share + (remainder > 0 ? 1 : 0);
            if (remainder > 0) remainder--;
          }
        }
      }
    }

    this.results.winners = this.seats
      .filter(s => s.wonAmount > 0)
      .map(s => ({ playerId: s.playerId, amount: s.wonAmount }));
  }

  _getSeatIndex(playerId) {
    return this.seats.findIndex(s => s.playerId === playerId);
  }

  _totalPot() {
    const pendingBets = this.seats.reduce((sum, s) => sum + s.roundBet, 0);
    return this.pot + pendingBets;
  }

  _playerStats() {
    return this.seats.map((s, i) => {
      const buyin = s.totalBuyin || this.defaultChips;
      const current = s.chips + (s.wonAmount || 0);
      return {
        playerId: s.playerId,
        playerName: this.room.getPlayer(s.playerId)?.name || '',
        buyin,
        current,
        net: current - buyin,
        wonAmount: s.wonAmount || 0,
        folded: s.folded,
        allIn: s.allIn,
        isOnline: this.room.getPlayer(s.playerId)?.isOnline !== false,
      };
    });
  }

  getState(playerId) {
    const seatIdx = this._getSeatIndex(playerId);
    const seat = seatIdx !== -1 ? this.seats[seatIdx] : null;

    return {
      gameType: 'texas',
      phase: this.phase,
      state: this.state,
      hand: seat ? seat.hand : [],
      mySeatIndex: seatIdx,
      myChips: seat ? seat.chips : 0,
      myTotalBuyin: seat ? (seat.totalBuyin || this.defaultChips) : 0,
      myRoundBet: seat ? seat.roundBet : 0,
      myTotalBet: seat ? seat.totalBet : 0,
      myFolded: seat ? seat.folded : false,
      myAllIn: seat ? seat.allIn : false,
      showdownPhase: this.showdownPhase,
      showdownChoices: this.showdownPhase ? this.showdownChoices : null,
      showdownOrder: this.showdownPhase ? this.showdownOrder : null,
      isShowdownWinner: this.showdownPhase && this.showdownChoices[playerId] === 'show'
        && this.results?.winners?.some(w => w.playerId === playerId),
      myHandRevealed: this.showdownPhase && this.showdownChoices[playerId] === 'show',
      isMyTurn: this.showdownPhase
        ? (this.showdownChoices[playerId] === null && !this.handOver)
        : (this.currentPlayerIndex === seatIdx && !this.handOver),
      validActions: this._getValidActions(seatIdx, playerId),
      communityCards: this.communityCards,
      pot: this._totalPot(),
      sidePots: this.sidePots,
      handOver: this.handOver,
      results: this.results,
      seats: this.seats.map((s, i) => ({
        playerId: s.playerId,
        playerName: this.room.getPlayer(s.playerId)?.name || '',
        chips: s.chips,
        folded: s.folded,
        allIn: s.allIn,
        roundBet: s.roundBet,
        totalBet: s.totalBet,
        wonAmount: s.wonAmount,
        hand: (this.handOver && !s.folded) ? s.hand : [],
        isDealer: i === this.dealerIndex,
        isSmallBlind: this._isSmallBlind(i),
        isBigBlind: this._isBigBlind(i),
      })),
      dealerIndex: this.dealerIndex,
      actionHistory: this.actionHistory.slice(-10),
      settings: this.settings,
      turnTimeLeft: this.getTurnTimeLeft(),
      playerStats: this._playerStats(),
    };
  }

  getPublicState() {
    return {
      gameType: 'texas',
      phase: this.phase,
      state: this.state,
      communityCards: this.communityCards,
      pot: this._totalPot(),
      sidePots: this.sidePots,
      currentPlayerIndex: this.currentPlayerIndex,
      currentPlayerId: this.showdownPhase
        ? this.showdownOrder.find(pid => this.showdownChoices[pid] === null) || null
        : (this.currentPlayerIndex !== -1 ? this.seats[this.currentPlayerIndex]?.playerId : null),
      handOver: this.handOver,
      showdownPhase: this.showdownPhase,
      showdownChoices: this.showdownPhase ? this.showdownChoices : null,
      showdownOrder: this.showdownPhase ? this.showdownOrder : null,
      seats: this.seats.map((s, i) => ({
        playerId: s.playerId,
        playerName: this.room.getPlayer(s.playerId)?.name || '',
        chips: s.chips,
        folded: s.folded,
        allIn: s.allIn,
        roundBet: s.roundBet,
        totalBet: s.totalBet,
        wonAmount: s.wonAmount,
        cardCount: s.hand.length,
        isDealer: i === this.dealerIndex,
        isSmallBlind: this._isSmallBlind(i),
        isBigBlind: this._isBigBlind(i),
      })),
      dealerIndex: this.dealerIndex,
      settings: this.settings,
      playerStats: this._playerStats(),
    };
  }

  getEndState() {
    return {
      gameType: 'texas',
      phase: this.phase,
      results: this.results,
      runItTwice: this.runItTwice,
      seats: this.seats.map((s, i) => ({
        playerId: s.playerId,
        playerName: this.room.getPlayer(s.playerId)?.name || '',
        chips: s.chips,
        wonAmount: s.wonAmount,
        totalBet: s.totalBet,
        hand: s.hand,
      })),
      communityCards: this.communityCards,
      pot: this._totalPot(),
      settings: this.settings,
    };
  }

  _getValidActions(seatIndex, playerId) {
    if (seatIndex === -1) return [];
    if (this.handOver) return [];

    // Showdown phase
    if (this.showdownPhase) {
      if (this.showdownChoices[playerId] !== null) return []; // already decided (incl. winner)
      if (!this.showdownOrder.includes(playerId)) return [];
      return ['show', 'muck']; // show = 亮牌, muck = 不亮
    }

    if (this.currentPlayerIndex !== seatIndex) return [];

    const seat = this.seats[seatIndex];
    if (seat.folded || seat.allIn) return [];

    const maxBet = Math.max(...this.seats.map(s => s.roundBet));
    const toCall = maxBet - seat.roundBet;
    const actions = [];

    actions.push('fold');
    if (toCall <= 0) {
      actions.push('check');
    } else {
      actions.push('call');
    }
    if (seat.chips + seat.roundBet > maxBet) {
      actions.push('raise');
      actions.push('all-in');
    }

    return actions;
  }

  _isSmallBlind(idx) {
    return idx === this._nextActiveSeat(this.dealerIndex);
  }

  _isBigBlind(idx) {
    const sb = this._nextActiveSeat(this.dealerIndex);
    return idx === this._nextActiveSeat(sb);
  }

  rebuy(playerId, amount) {
    if (!this.settings.rebuyEnabled) return { error: '补筹码功能未开启' };
    if (typeof amount !== 'number' || amount < this.settings.rebuyMin || amount > this.settings.rebuyMax) {
      return { error: `补筹码范围: ${this.settings.rebuyMin} - ${this.settings.rebuyMax}` };
    }

    const seatIdx = this._getSeatIndex(playerId);
    if (seatIdx === -1) return { error: '玩家不在座位上' };

    const seat = this.seats[seatIdx];
    seat.chips += amount;
    seat.totalBuyin = (seat.totalBuyin || this.defaultChips) + amount;
    return { success: true, newChips: seat.chips };
  }

  _startTurnTimer() {
    this._stopTurnTimer();
    this._turnStartedAt = Date.now();
    const duration = (this.turnTime || 30) * 1000;
    this._turnTimerId = setTimeout(() => {
      if (this.handOver || this.state !== 'playing') return;
      const playerId = this.seats[this.currentPlayerIndex]?.playerId;
      if (playerId) {
        console.log(`[超时] ${playerId} 自动弃牌`);
        this.handleAction(playerId, 'fold', {});
        // Broadcast timeout
        const publicState = this.getPublicState();
        const endState = this.handOver ? this.getEndState() : null;
        this.io.to(this.room.code).emit('game:turn', publicState);
        for (const p of this.room.players) {
          this.io.to(p.socketId).emit('game:dealt', this.getState(p.id));
        }
        if (endState) {
          this.io.to(this.room.code).emit('game:ended', endState);
          this.room.state = 'ended';
        }
      }
    }, duration);
    // Allow process to exit in test environments (HTTP server keeps it alive otherwise)
    this._turnTimerId.unref();
  }

  _stopTurnTimer() {
    if (this._turnTimerId) {
      clearTimeout(this._turnTimerId);
      this._turnTimerId = null;
    }
  }

  getTurnTimeLeft() {
    if (!this._turnStartedAt) return this.turnTime;
    const elapsed = (Date.now() - this._turnStartedAt) / 1000;
    return Math.max(0, Math.ceil(this.turnTime - elapsed));
  }

  _startShowdownDecisions(skipAutoShow = false) {
    this.phase = 'showdown';
    this.showdownPhase = true;
    this.showdownChoices = {};

    const activePlayers = this.seats.filter(s => !s.folded);

    // Auto-evaluate if not already done (e.g. from fold-all path)
    if (!this.results) {
      this._calculateSidePots();
      const evaluations = [];
      for (const seat of activePlayers) {
        const allCards = [...seat.hand, ...this.communityCards];
        const evalResult = evaluateHand(allCards);
        evaluations.push({
          playerId: seat.playerId,
          seatIndex: this._getSeatIndex(seat.playerId),
          hand: seat.hand,
          ...evalResult,
        });
      }

      this._awardSidePots(evaluations);

      evaluations.sort((a, b) => b.score - a.score);
      this.results = {
        evaluations,
        pot: this.pot,
        sidePots: this.sidePots,
        winners: this.seats
          .filter(s => s.wonAmount > 0)
          .map(s => ({
            playerId: s.playerId,
            amount: s.wonAmount,
            hand: evaluations.find(e => e.playerId === s.playerId),
          })),
      };
    }

    // Winner(s) auto-show (unless fold-all win where winner can choose)
    const winnerIds = new Set(this.results.winners.map(w => w.playerId));
    if (!skipAutoShow) {
      winnerIds.forEach(pid => {
        this.showdownChoices[pid] = 'show';
      });
    }

    // Build order: winners first, then other active, then folded
    this.showdownOrder = [];
    winnerIds.forEach(pid => {
      this.showdownOrder.push(pid);
      if (skipAutoShow) this.showdownChoices[pid] = null;
    });
    activePlayers.forEach(s => {
      if (!winnerIds.has(s.playerId)) {
        this.showdownOrder.push(s.playerId);
        this.showdownChoices[s.playerId] = null;
      }
    });
    // Folded players can also show
    this.seats.forEach(s => {
      if (s.folded && !this.showdownOrder.includes(s.playerId)) {
        this.showdownOrder.push(s.playerId);
        this.showdownChoices[s.playerId] = null;
      }
    });

    // Find first undecided player
    const firstUndecided = this.showdownOrder.find(pid => this.showdownChoices[pid] === null);
    if (firstUndecided) {
      this.currentPlayerIndex = this._getSeatIndex(firstUndecided);
      this._startTurnTimer();
    } else {
      this._finishShowdown();
    }
  }

  _finishShowdown() {
    this.showdownPhase = false;
    this.handOver = true;
    this._stopTurnTimer();
  }

  onPlayerDisconnect(playerId) {
    const seatIdx = this._getSeatIndex(playerId);
    if (seatIdx !== -1 && this.currentPlayerIndex === seatIdx && !this.handOver) {
      this.handleAction(playerId, 'fold', {});
    }
  }

  destroy() {
    this._stopTurnTimer();
  }
}

module.exports = TexasHoldem;
