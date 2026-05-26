const GameSession = require('./GameSession');
const Deck = require('../cards/Deck');
const { evaluateHand, HAND_NAMES } = require('../cards/CardPatterns');

class TexasHoldem extends GameSession {
  constructor(room, io) {
    super(room, io);
    this.phase = 'preflop';
    this.seats = [];
    this.communityCards = [];
    this.masterDeck = null;    // single deck per hand, prevents card duplication
    this.pot = 0;
    this.sidePots = [];
    this.dealerIndex = 0;
    this.smallBlindIndex = -1;
    this.bigBlindIndex = -1;
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
    this.runItTwicePhase = false;
    this.runItTwiceChoices = {};
    this.runItTwiceOrder = [];
    this.rebuyCooldown = {};   // playerId -> hands remaining to sit out
    this._turnTimerId = null;
    this._turnStartedAt = 0;
    this.showdownTime = 10;
    this._showdownTimerId = null;
    this._showdownStartedAt = 0;
  }

  start() {
    const players = this.room.players;
    if (players.length < 2) return { error: '至少需要2名玩家' };
    if (players.length > 9) return { error: '最多9名玩家' };

    // If continuing after hand end, just start a new hand
    if (this.state === 'ended' || this.handOver) {
      this._collectWinnings();
      this._startNewHand();
      if (this.state !== 'ended') this.state = 'playing';
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
    this.masterDeck = null;
    this.pot = 0;
    this.sidePots = [];
    this.smallBlindIndex = -1;
    this.bigBlindIndex = -1;
    this.handOver = false;
    this.results = null;
    this.showdownPhase = false;
    this.showdownChoices = {};
    this.showdownOrder = [];
    this._showdownStartedAt = 0;
    this.runItTwicePhase = false;
    this.runItTwiceChoices = {};
    this.runItTwiceOrder = [];
    this.actionHistory = [];
    this._stopShowdownTimer();

    // Reset seats
    this.seats.forEach(seat => {
      seat.hand = [];
      seat.folded = false;
      seat.allIn = false;
      seat.roundBet = 0;
      seat.totalBet = 0;
    });

    // Decrement rebuy cooldowns — one "hand cycle" has passed.
    // Auto-fold players still on cooldown (skip if chips=0, no rebuy yet).
    for (const [pid, cd] of Object.entries(this.rebuyCooldown)) {
      if (cd > 0) {
        const seat = this.seats.find(s => s.playerId === pid);
        if (seat && seat.chips > 0) {
          seat.folded = true;
        }
        this.rebuyCooldown[pid] = cd - 1;
      }
    }

    // If < 2 non-folded players with chips remain, skip this hand
    const canPlay = this.seats.filter(s => !s.folded && s.chips > 0);
    if (canPlay.length < 2) {
      this.state = 'ended';
      this.handOver = true;
      this.currentPlayerIndex = -1;
      this._stopTurnTimer();
      return;
    }

    this.state = 'playing';

    // Rotate dealer
    this.dealerIndex = this._nextActiveSeat(this.dealerIndex);

    // Post blinds
    this.phase = 'preflop';
    // Single master deck for entire hand - no card duplication
    this._handStartedAt = Date.now();
    this._handRecordSaved = false;
    this.masterDeck = Deck.createStandard52().shuffle();

    // Deal 2 cards to each active player
    for (const seat of this.seats) {
      if (seat.chips > 0 && !seat.folded) {
        seat.hand = this.masterDeck.deal(2);
      }
    }

    // Post blinds
    const activeSeatCount = this.seats.filter(s => s.chips > 0 && !s.folded).length;
    const sbIndex = activeSeatCount === 2 ? this.dealerIndex : this._nextActiveSeat(this.dealerIndex);
    const bbIndex = this._nextActiveSeat(sbIndex);
    this.smallBlindIndex = sbIndex;
    this.bigBlindIndex = bbIndex;

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
      if (!seat.folded && !seat.allIn && seat.chips > 0) return idx;
    }
    return -1;
  }

  _resetPlayersToAct() {
    this.playersToAct.clear();
    for (let i = 0; i < this.seats.length; i++) {
      const seat = this.seats[i];
      if (!seat.folded && !seat.allIn && seat.chips > 0) {
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
    const activeNotAllIn = this.seats.filter(s => !s.folded && !s.allIn && s.chips > 0);
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
    const activePlayers = this.seats.filter(s => !s.folded && s.hand.length > 0);
    if (activePlayers.length === 1) {
      this._awardPot([activePlayers[0]]);
      this.handOver = true;
      return;
    }

    // Count players with chips remaining (not all-in)
    const canAct = this.seats.filter(s => !s.folded && !s.allIn && s.chips > 0);

    // If 0 or 1 players can still act, betting is closed. Run out remaining
    // community cards and move to showdown.
    if (canAct.length <= 1 && this.phase !== 'river' && this.phase !== 'showdown') {
      const activePlayers = this.seats.filter(s => !s.folded && s.hand.length > 0);
      if (activePlayers.length >= 2) {
        this._resolveClosedAllInBetting(activePlayers);
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
      const activePlayers = this.seats.filter(s => !s.folded && s.hand.length > 0);
      this._resolveClosedAllInBetting(activePlayers);
      return;
    }

    this._resetPlayersToAct();
    this._startTurnTimer();
  }

  _runoutCommunity() {
    // Deal remaining community cards from master deck
    if (this.phase === 'preflop') {
      this.communityCards = this._dealCommunity(5);
    } else if (this.phase === 'flop') {
      this.communityCards.push(...this._dealCommunity(2));
    } else if (this.phase === 'turn') {
      this.communityCards.push(...this._dealCommunity(1));
    }
  }

  _dealCommunity(count) {
    // Deal from the master deck - no card duplication
    return this.masterDeck ? this.masterDeck.deal(count) : [];
  }

  _remainingCommunityCardsNeeded() {
    if (this.phase === 'preflop') return 5;
    if (this.phase === 'flop') return 2;
    if (this.phase === 'turn') return 1;
    return 0;
  }

  _resolveClosedAllInBetting(activePlayers) {
    if (this.runItTwice && this._remainingCommunityCardsNeeded() > 0) {
      this._startRunItTwiceDecisions(activePlayers);
      return;
    }

    this._runoutCommunity();
    this._startShowdownDecisions();
  }

  _startRunItTwiceDecisions(activePlayers) {
    this.runItTwicePhase = true;
    this.runItTwiceChoices = {};
    this.runItTwiceOrder = activePlayers.map(s => s.playerId);
    this.runItTwiceOrder.forEach(pid => {
      this.runItTwiceChoices[pid] = null;
    });

    const first = this.runItTwiceOrder[0];
    this.currentPlayerIndex = this._getSeatIndex(first);
    this._startTurnTimer();
  }

  _finishRunItTwiceDecisions() {
    this.runItTwicePhase = false;
    const activePlayers = this._activeShowdownSeats();
    const agreedTwice = activePlayers.length >= 2
      && activePlayers.every(s => this.runItTwiceChoices[s.playerId] === 'twice');

    if (agreedTwice) {
      this._runItTwiceShowdown(activePlayers);
      this._startShowdownDecisions();
      return;
    }

    this._runoutCommunity();
    this._startShowdownDecisions();
  }

  handleAction(playerId, action, data) {
    if (this.state !== 'playing') return { error: '游戏未在进行中' };
    if (this.handOver) return { error: '本局已结束' };

    const seatIndex = this.seats.findIndex(s => s.playerId === playerId);
    if (seatIndex === -1) return { error: '玩家不在座位上' };
    if (!this.showdownPhase && seatIndex !== this.currentPlayerIndex) return { error: '还没轮到你' };

    const seat = this.seats[seatIndex];

    if (this.runItTwicePhase) {
      if (action !== 'run-once' && action !== 'run-twice') return { error: '请选择发一次或发两次' };
      if (!this.runItTwiceOrder.includes(playerId) || this.runItTwiceChoices[playerId] !== null) {
        return { error: '无需选择发牌次数' };
      }

      const player = this.room.getPlayer(playerId);
      this.runItTwiceChoices[playerId] = action === 'run-twice' ? 'twice' : 'once';
      this.actionHistory.push({ playerId, action, phase: 'run-it-twice' });

      const nextUndecided = this.runItTwiceOrder.find(pid => this.runItTwiceChoices[pid] === null);
      if (nextUndecided) {
        this.currentPlayerIndex = this._getSeatIndex(nextUndecided);
        this._startTurnTimer();
      } else {
        this._finishRunItTwiceDecisions();
      }

      return {
        publicAction: {
          action,
          playerId,
          playerName: player ? player.name : '',
          seatIndex,
          isRunItTwiceChoice: true,
          handOver: this.handOver,
        },
      };
    }

    // Showdown phase: allow players in showdown order to show/muck.
    if (this.showdownPhase) {
      if (action !== 'show' && action !== 'muck') return { error: '请选择亮牌或不亮' };
      if (!this.showdownOrder.includes(playerId) || this.showdownChoices[playerId] !== null) {
        return { error: '无需摊牌操作' };
      }
      if (action === 'muck' && this._mustShowAtShowdown(playerId)) {
        return { error: 'All-in 摊牌必须亮牌' };
      }
      const player = this.room.getPlayer(playerId);
      this.showdownChoices[playerId] = action;

      this.actionHistory.push({ playerId, action, phase: 'showdown' });

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
          seat.totalBet += seat.roundBet;
          seat.roundBet = 0;
        }
        this._awardPot([remainingPlayers[0]]);
        this.results = {
          winners: [{ playerId: remainingPlayers[0].playerId, amount: remainingPlayers[0].wonAmount }],
        };
      }
      // Enter a short post-settlement window. Fold-all winners may choose
      // whether to show, but are not forced or auto-revealed.
      this._startShowdownDecisions({ foldWin: true });
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
    // Build pots from every contribution, including folded players' dead money.
    // Eligibility is still limited to players who have not folded.
    const contributedSeats = this.seats
      .map((s, i) => ({ ...s, idx: i }))
      .filter(s => s.totalBet > 0)
      .sort((a, b) => a.totalBet - b.totalBet);

    this.sidePots = [];
    let prevLevel = 0;

    for (const seat of contributedSeats) {
      const contribution = seat.totalBet - prevLevel;
      if (contribution > 0) {
        const contributors = contributedSeats.filter(s => s.totalBet >= seat.totalBet);
        const eligible = contributors
          .filter(s => !s.folded)
          .map(s => s.playerId);
        const potAmount = contribution * contributors.length;
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
      if (winners.length === 0) continue;

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

    const cardsNeeded = this._remainingCommunityCardsNeeded();

    // Create two runouts from the master deck (no card duplication)
    const runouts = [];
    for (let r = 0; r < 2; r++) {
      const extraCards = this._dealCommunity(cardsNeeded);
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
        winners: [],
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
            const amount = share + (remainder > 0 ? 1 : 0);
            this.seats[seatIdx].wonAmount += amount;
            const existing = runout.winners.find(w => w.playerId === winner.playerId);
            if (existing) {
              existing.amount += amount;
            } else {
              runout.winners.push({
                playerId: winner.playerId,
                amount,
                hand: winner,
              });
            }
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
        rebuyCooldown: this.rebuyCooldown[s.playerId] || 0,
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
      myEffectiveChips: seat ? seat.chips + (seat.wonAmount || 0) : 0,
      myWonAmount: seat ? (seat.wonAmount || 0) : 0,
      myTotalBuyin: seat ? (seat.totalBuyin || this.defaultChips) : 0,
      myRoundBet: seat ? seat.roundBet : 0,
      myTotalBet: seat ? seat.totalBet : 0,
      myFolded: seat ? seat.folded : false,
      myAllIn: seat ? seat.allIn : false,
      showdownPhase: this.showdownPhase,
      showdownChoices: this.showdownPhase ? this.showdownChoices : null,
      showdownOrder: this.showdownPhase ? this.showdownOrder : null,
      showdownTimeLeft: this.showdownPhase ? this.getShowdownTimeLeft() : null,
      runItTwicePhase: this.runItTwicePhase,
      runItTwiceChoices: this.runItTwicePhase ? this.runItTwiceChoices : null,
      runItTwiceOrder: this.runItTwicePhase ? this.runItTwiceOrder : null,
      rebuyCooldown: this.rebuyCooldown[playerId] || 0,
      isShowdownWinner: this.showdownPhase && this.showdownChoices[playerId] === 'show'
        && this.results?.winners?.some(w => w.playerId === playerId),
      myHandRevealed: this.showdownPhase && this.showdownChoices[playerId] === 'show',
      isMyTurn: this.runItTwicePhase
        ? (this.runItTwiceChoices[playerId] === null && !this.handOver)
        : (this.showdownPhase
          ? (this.showdownChoices[playerId] === null && !this.handOver)
          : (this.currentPlayerIndex === seatIdx && !this.handOver)),
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
        hand: this._isHandVisibleToPlayer(s, playerId) ? s.hand : [],
        rebuyCooldown: this.rebuyCooldown[s.playerId] || 0,
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
      currentPlayerId: this.runItTwicePhase
        ? this.runItTwiceOrder.find(pid => this.runItTwiceChoices[pid] === null) || null
        : (this.showdownPhase
          ? null
          : (this.currentPlayerIndex !== -1 ? this.seats[this.currentPlayerIndex]?.playerId : null)),
      handOver: this.handOver,
      showdownPhase: this.showdownPhase,
      showdownChoices: this.showdownPhase ? this.showdownChoices : null,
      showdownOrder: this.showdownPhase ? this.showdownOrder : null,
      showdownTimeLeft: this.showdownPhase ? this.getShowdownTimeLeft() : null,
      runItTwicePhase: this.runItTwicePhase,
      runItTwiceChoices: this.runItTwicePhase ? this.runItTwiceChoices : null,
      runItTwiceOrder: this.runItTwicePhase ? this.runItTwiceOrder : null,
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
        rebuyCooldown: this.rebuyCooldown[s.playerId] || 0,
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

    if (this.runItTwicePhase) {
      if (this.runItTwiceChoices[playerId] !== null) return [];
      if (!this.runItTwiceOrder.includes(playerId)) return [];
      return ['run-once', 'run-twice'];
    }

    // Showdown phase
    if (this.showdownPhase) {
      if (this.showdownChoices[playerId] !== null) return []; // already decided (incl. winner)
      if (!this.showdownOrder.includes(playerId)) return [];
      if (this._mustShowAtShowdown(playerId)) return ['show'];
      return ['show', 'muck']; // show = 亮牌, muck = 不亮
    }

    if (this.currentPlayerIndex !== seatIndex) return [];

    const seat = this.seats[seatIndex];
    if (seat.folded || seat.allIn || seat.chips === 0) return [];

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
    return idx === this.smallBlindIndex;
  }

  _isBigBlind(idx) {
    return idx === this.bigBlindIndex;
  }

  rebuy(playerId, amount) {
    if (!this.settings.rebuyEnabled) return { error: '补筹码功能未开启' };
    if (typeof amount !== 'number' || amount < this.settings.rebuyMin || amount > this.settings.rebuyMax) {
      return { error: `补筹码范围: ${this.settings.rebuyMin} - ${this.settings.rebuyMax}` };
    }

    const seatIdx = this._getSeatIndex(playerId);
    if (seatIdx === -1) return { error: '玩家不在座位上' };

    const seat = this.seats[seatIdx];
    const canRebuyDuringHand = seat.chips === 0 && seat.hand.length === 0;
    if (!this.handOver && !canRebuyDuringHand) return { error: '本局结束后才能补筹码' };
    // Only allow rebuy when chips = 0 (lost an all-in)
    if (seat.chips + (seat.wonAmount || 0) > 0) return { error: '只能在输光 all-in 后补筹码' };

    seat.chips += amount;
    seat.totalBuyin = (seat.totalBuyin || this.defaultChips) + amount;
    // If this bustout was not finalized through normal showdown, still apply
    // the sit-out rule. Otherwise keep the remaining countdown.
    if (this.rebuyCooldown[playerId] == null) this.rebuyCooldown[playerId] = 2;
    return { success: true, newChips: seat.chips, cooldown: this.rebuyCooldown[playerId] };
  }

  _startTurnTimer() {
    this._stopTurnTimer();
    this._turnStartedAt = Date.now();
    const duration = (this.turnTime || 30) * 1000;
    this._turnTimerId = setTimeout(() => {
      if (this.handOver || this.state !== 'playing') return;
      const playerId = this.seats[this.currentPlayerIndex]?.playerId;
      if (playerId) {
        const timeoutAction = this.runItTwicePhase
          ? 'run-once'
          : (this.showdownPhase ? 'muck' : 'fold');
        const timeoutLabel = timeoutAction === 'run-once'
          ? '发一次'
          : (timeoutAction === 'muck' ? '不亮' : '弃牌');
        console.log(`[超时] ${playerId} 自动${timeoutLabel}`);
        this.handleAction(playerId, timeoutAction, {});
        // Broadcast state
        this.io.to(this.room.code).emit('game:turn', this.getPublicState());
        for (const p of this.room.players) {
          if (p.socketId) this.io.to(p.socketId).emit('game:dealt', this.getState(p.id));
        }
        // Use shared end-of-hand logic (saves HandRecords, etc)
        try { require('../handlers/finishHand')(this.io, this.room); } catch (e) {}
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
    if (this.showdownPhase) return this.getShowdownTimeLeft();
    if (!this._turnStartedAt) return this.turnTime;
    const elapsed = (Date.now() - this._turnStartedAt) / 1000;
    return Math.max(0, Math.ceil(this.turnTime - elapsed));
  }

  getShowdownTimeLeft() {
    if (!this._showdownStartedAt) return this.showdownTime;
    const elapsed = (Date.now() - this._showdownStartedAt) / 1000;
    return Math.max(0, Math.ceil(this.showdownTime - elapsed));
  }

  _isHandVisibleToPlayer(seat, viewerId) {
    if (seat.playerId === viewerId) return true;
    if (this.showdownPhase && this.showdownChoices[seat.playerId] === 'show') return true;
    return this.handOver && !seat.folded;
  }

  _activeShowdownSeats() {
    return this.seats.filter(s => !s.folded && s.hand.length > 0);
  }

  _isAllInShowdown() {
    return this._activeShowdownSeats().some(s => s.allIn);
  }

  _mustShowAtShowdown(playerId) {
    if (!this.showdownPhase || !this._isAllInShowdown()) return false;
    return this._activeShowdownSeats().some(s => s.playerId === playerId);
  }

  _startShowdownDecisions(options = {}) {
    const foldWin = typeof options === 'boolean' ? options : !!options.foldWin;
    this.phase = 'showdown';
    this.showdownPhase = true;
    this.showdownChoices = {};
    this.currentPlayerIndex = -1;
    this._stopTurnTimer();

    const activePlayers = this._activeShowdownSeats();

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

    // Winner(s) auto-show. If an all-in reaches showdown, all active dealt
    // players must table their cards.
    const winnerIds = new Set(this.results.winners.map(w => w.playerId));
    if (!foldWin) {
      const autoShowIds = this._isAllInShowdown()
        ? activePlayers.map(s => s.playerId)
        : Array.from(winnerIds);
      autoShowIds.forEach(pid => {
        this.showdownChoices[pid] = 'show';
      });
    }

    // Build order: winners first, then other active, then folded
    this.showdownOrder = [];
    winnerIds.forEach(pid => {
      this.showdownOrder.push(pid);
      if (foldWin) this.showdownChoices[pid] = null;
    });
    activePlayers.forEach(s => {
      if (!winnerIds.has(s.playerId)) {
        this.showdownOrder.push(s.playerId);
        if (this.showdownChoices[s.playerId] !== 'show') {
          this.showdownChoices[s.playerId] = null;
        }
      }
    });
    // Folded players can also show (but only if they were dealt cards)
    this.seats.forEach(s => {
      if (s.folded && !this.showdownOrder.includes(s.playerId) && s.hand.length > 0) {
        this.showdownOrder.push(s.playerId);
        this.showdownChoices[s.playerId] = null;
      }
    });

    this._startShowdownTimer();
  }

  _finishShowdown() {
    this.showdownPhase = false;
    this.handOver = true;
    this._stopTurnTimer();
    this._stopShowdownTimer();
  }

  _startShowdownTimer() {
    this._stopShowdownTimer();
    this._showdownStartedAt = Date.now();
    this._showdownTimerId = setTimeout(() => {
      this._completeShowdownCountdown();
    }, this.showdownTime * 1000);
    this._showdownTimerId.unref();
  }

  _completeShowdownCountdown() {
    if (!this.showdownPhase || this.handOver || this.state !== 'playing') return;
    for (const pid of this.showdownOrder) {
      if (this.showdownChoices[pid] === null) {
        this.showdownChoices[pid] = this._mustShowAtShowdown(pid) ? 'show' : 'muck';
      }
    }
    this._finalizeShowdown();
    this.start();
    this.room.state = (this.handOver || this.state === 'ended') ? 'ended' : 'playing';
    this._broadcastCurrentState();
  }

  _stopShowdownTimer() {
    if (this._showdownTimerId) {
      clearTimeout(this._showdownTimerId);
      this._showdownTimerId = null;
    }
  }

  _finalizeShowdown() {
    this._markBustedPlayersSuspended();
    this._finishShowdown();
    // Broadcast state with handOver=true before emitting game:ended
    this.io.to(this.room.code).emit('game:turn', this.getPublicState());
    for (const p of this.room.players) {
      if (p.socketId) this.io.to(p.socketId).emit('game:dealt', this.getState(p.id));
    }
    try { require('../handlers/finishHand')(this.io, this.room); } catch (e) {}
  }

  _markBustedPlayersSuspended() {
    for (const seat of this.seats) {
      if (seat.hand.length === 0) continue;
      if (seat.chips + (seat.wonAmount || 0) === 0) {
        this.rebuyCooldown[seat.playerId] = Math.max(this.rebuyCooldown[seat.playerId] || 0, 2);
      }
    }
  }

  _broadcastCurrentState() {
    this.io.to(this.room.code).emit('game:started', { gameType: this.room.gameType });
    this.io.to(this.room.code).emit('game:turn', this.getPublicState());
    for (const p of this.room.players) {
      if (p.socketId) this.io.to(p.socketId).emit('game:dealt', this.getState(p.id));
    }
  }

  onPlayerDisconnect(playerId) {
    // Let the turn timer handle timeout — if the player reconnects before
    // the timer expires they can resume their turn. No immediate auto-fold.
    const seatIdx = this._getSeatIndex(playerId);
    if (seatIdx !== -1 && this.currentPlayerIndex === seatIdx && !this.handOver) {
      const label = this.showdownPhase ? '自动不亮' : '自动弃牌';
      console.log(`[断线] ${playerId} 断线，等待倒计时结束${label}`);
    }
  }

  destroy() {
    this._stopTurnTimer();
    this._stopShowdownTimer();
  }
}

module.exports = TexasHoldem;
