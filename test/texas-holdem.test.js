const { test } = require('node:test');
const assert = require('node:assert');
const TexasHoldem = require('../server/games/TexasHoldem');
const Room = require('../server/rooms/Room');
const Player = require('../server/players/Player');

function makeRoom(settings = {}) {
  const room = new Room('TEST', 'texas', 'host');
  room.settings = {
    smallBlind: 10,
    bigBlind: 20,
    defaultChips: 1000,
    turnTime: 300,
    runItTwice: false,
    rebuyEnabled: true,
    rebuyMin: 200,
    rebuyMax: 2000,
    ...settings,
  };
  return room;
}

function makePlayer(name, id) {
  const p = new Player(name, id);
  p.id = id || name.toLowerCase();
  return p;
}

function mockIO() {
  const msgs = [];
  return {
    msgs,
    to: () => ({
      emit: (event, data) => msgs.push({ event, data }),
    }),
    emit: (event, data) => msgs.push({ event, data }),
  };
}

function getActions(game, playerId) {
  return game.getState(playerId).validActions;
}

function getCurrentPlayer(game) {
  return game.getPublicState().currentPlayerId;
}

function assertUniqueCards(cards) {
  const ids = cards.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'cards should not contain duplicates');
}

// Helper: play hand with simple strategy
function playHand(game, strategy = 'call') {
  let steps = 0;
  while (!game.handOver && steps < 100) {
    const pid = getCurrentPlayer(game);
    if (!pid) break;
    const actions = getActions(game, pid);

    // Handle showdown phase
    if (actions.includes('show') && actions.includes('muck')) {
      game.handleAction(pid, 'show', {});
      steps++;
      continue;
    }

    let action;
    if (strategy === 'call') {
      action = actions.includes('check') ? 'check' : 'call';
    } else if (strategy === 'allin') {
      action = actions.includes('all-in') ? 'all-in' : (actions.includes('check') ? 'check' : 'call');
    } else {
      action = actions[0];
    }
    const res = game.handleAction(pid, action, {});
    if (res.error) {
      game.handleAction(pid, 'fold', {});
    }
    steps++;
  }
  return steps;
}

test('TexasHoldem - initialization', async (t) => {
  await t.test('start creates seats for all players', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    const result = game.start();
    assert.equal(result.error, undefined);
    assert.equal(game.seats.length, 2);
    assert.equal(game.state, 'playing');
  });

  await t.test('rejects fewer than 2 players', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1')];
    const game = new TexasHoldem(room, mockIO());
    const result = game.start();
    assert.ok(result.error);
  });

  await t.test('deals 2 hole cards to each player', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2'), makePlayer('Carl', 'p3')];
    const game = new TexasHoldem(room, mockIO());
    game.start();
    game.seats.forEach(seat => {
      assert.equal(seat.hand.length, 2);
    });
  });

  await t.test('posts blinds correctly', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    // Dealer should be seat 0 (started at -1 equivalent)
    // SB: seat next to dealer, BB: seat after SB
    const seats = game.seats;
    const totalChips = seats.reduce((s, seat) => s + seat.chips, 0);
    // SB 10 + BB 20 = 30 in round bets, so chips = 2000 - 30 = 1970
    // Wait, chips are reduced when blinds posted. SB loses 10, BB loses 20.
    assert.equal(totalChips, 1970);
  });

  await t.test('heads-up dealer is small blind and other player is big blind', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const pub = game.getPublicState();
    const dealerSeat = pub.seats[game.dealerIndex];
    const otherSeat = pub.seats.find((_, i) => i !== game.dealerIndex);

    assert.equal(dealerSeat.isDealer, true);
    assert.equal(dealerSeat.isSmallBlind, true);
    assert.equal(dealerSeat.isBigBlind, false);
    assert.equal(otherSeat.isSmallBlind, false);
    assert.equal(otherSeat.isBigBlind, true);
  });
});

test('TexasHoldem - betting rounds', async (t) => {
  await t.test('advances through preflop to showdown', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();
    playHand(game);
    assert.equal(game.handOver, true);
    assert.equal(game.phase, 'showdown');
    assert.equal(game.communityCards.length, 5);
  });

  await t.test('flop deals 3 community cards', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    // Play through preflop
    while (game.phase === 'preflop' && !game.handOver) {
      const pid = getCurrentPlayer(game);
      const actions = getActions(game, pid);
      const action = actions.includes('check') ? 'check' : 'call';
      game.handleAction(pid, action, {});
    }
    assert.equal(game.phase, 'flop');
    assert.equal(game.communityCards.length, 3);
  });

  await t.test('uses one deck for hole cards and community cards', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2'), makePlayer('Carl', 'p3')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    playHand(game);

    const visibleCards = [
      ...game.communityCards,
      ...game.seats.flatMap(seat => seat.hand),
    ];
    assert.equal(game.communityCards.length, 5);
    assertUniqueCards(visibleCards);
  });
});

test('TexasHoldem - actions', async (t) => {
  await t.test('fold removes player from hand', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2'), makePlayer('Carl', 'p3')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const pid = getCurrentPlayer(game);
    game.handleAction(pid, 'fold', {});
    // Next player should be valid
    assert.ok(game.seats.find(s => s.playerId === pid).folded);
  });

  await t.test('all-in sets player all-in', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const pid = getCurrentPlayer(game);
    const actions = getActions(game, pid);
    if (actions.includes('all-in')) {
      game.handleAction(pid, 'all-in', {});
      const seat = game.seats.find(s => s.playerId === pid);
      assert.equal(seat.allIn, true);
      assert.equal(seat.chips, 0);
    }
  });

  await t.test('raise increases bet', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const pid = getCurrentPlayer(game);
    const state = game.getState(pid);
    const oldRoundBet = state.myRoundBet;
    const actions = getActions(game, pid);
    if (actions.includes('raise')) {
      game.handleAction(pid, 'raise', { amount: 40 });
      const newState = game.getState(pid);
      assert.ok(newState.myRoundBet > oldRoundBet);
    }
  });

  await t.test('cannot act out of turn', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2'), makePlayer('Carl', 'p3')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const currentPid = getCurrentPlayer(game);
    // Find a player who is NOT the current player
    const otherPid = game.seats.find(s => s.playerId !== currentPid && !s.folded).playerId;
    const result = game.handleAction(otherPid, 'fold', {});
    assert.ok(result.error);
  });
});

test('TexasHoldem - side pots', async (t) => {
  await t.test('calculates side pots with different all-in amounts', () => {
    const room = makeRoom({ defaultChips: 100, smallBlind: 5, bigBlind: 10 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2'), makePlayer('Carl', 'p3')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    // Force all-in for all players (they have 100 chips each)
    playHand(game, 'allin');
    assert.equal(game.handOver, true);
    const endState = game.getEndState();
    assert.ok(endState.results);
  });

  await t.test('chip conservation after side pots', () => {
    const room = makeRoom({ defaultChips: 100 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const initialTotal = game.seats.reduce((s, seat) => s + seat.chips, 0) + game.pot;

    playHand(game);
    const finalTotal = game.seats.reduce((s, seat) => s + seat.chips + seat.wonAmount, 0);
    assert.equal(finalTotal, 200); // 2 players * 100 default chips
  });

  await t.test('side pots include folded players contributed chips', () => {
    const room = makeRoom({ defaultChips: 500 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2'), makePlayer('Carl', 'p3')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    game.seats[0].totalBet = 50;
    game.seats[1].totalBet = 50;
    game.seats[2].totalBet = 50;
    game.seats[2].folded = true;
    game._calculateSidePots();
    game._awardSidePots([
      { playerId: 'p1', score: 100 },
      { playerId: 'p2', score: 10 },
    ]);

    assert.deepEqual(game.sidePots, [{ amount: 150, eligiblePlayerIds: ['p1', 'p2'] }]);
    assert.equal(game.seats[0].wonAmount, 150);
    assert.equal(game.seats[1].wonAmount, 0);
    assert.equal(game.seats[2].wonAmount, 0);
  });
});

test('TexasHoldem - Run It Twice', async (t) => {
  await t.test('activates when all players all-in', () => {
    const room = makeRoom({ runItTwice: true, defaultChips: 100 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    playHand(game, 'allin');
    const endState = game.getEndState();
    // Run It Twice may or may not trigger depending on when all-in happened
    if (endState.results && endState.results.runItTwice) {
      assert.equal(endState.results.runouts.length, 2);
      // Verify no duplicate cards between the two runouts' NEW cards
      const saved = game.communityCards;
      const savedIds = new Set(saved.map(c => c.id));
      const r1new = endState.results.runouts[0].communityCards.filter(c => !savedIds.has(c.id));
      const r2new = endState.results.runouts[1].communityCards.filter(c => !savedIds.has(c.id));
      const r1newIds = new Set(r1new.map(c => c.id));
      const overlap = r2new.filter(c => r1newIds.has(c.id));
      assert.equal(overlap.length, 0, 'New cards must not duplicate across runouts');
    }
  });

  await t.test('runItTwice false does not trigger', () => {
    const room = makeRoom({ runItTwice: false, defaultChips: 100 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    playHand(game, 'allin');
    const endState = game.getEndState();
    assert.equal(endState.results && endState.results.runItTwice, undefined);
  });
});

test('TexasHoldem - rebuy', async (t) => {
  await t.test('adds chips within allowed range (only when chips=0)', () => {
    const room = makeRoom({ rebuyEnabled: true, rebuyMin: 100, rebuyMax: 1000 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    // Force chips to 0 first (simulate all-in loss)
    game.seats[0].chips = 0;
    const result = game.rebuy('p1', 500);
    assert.equal(result.error, undefined);
    assert.equal(game.seats[0].chips, 500);
    assert.equal(game.rebuyCooldown['p1'], 2);
  });

  await t.test('rejects rebuy when chips > 0', () => {
    const room = makeRoom({ rebuyEnabled: true, rebuyMin: 100, rebuyMax: 1000 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const result = game.rebuy('p1', 500);
    assert.ok(result.error);
  });

  await t.test('rejects rebuy below minimum', () => {
    const room = makeRoom({ rebuyEnabled: true, rebuyMin: 200, rebuyMax: 1000 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const result = game.rebuy('p1', 50);
    assert.ok(result.error);
  });

  await t.test('rejects rebuy when disabled', () => {
    const room = makeRoom({ rebuyEnabled: false });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const result = game.rebuy('p1', 500);
    assert.ok(result.error);
  });
});

test('TexasHoldem - multi-hand', async (t) => {
  await t.test('dealer rotates each hand', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2'), makePlayer('Carl', 'p3')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const dealer1 = game.dealerIndex;
    assert.equal(dealer1, 0, 'First dealer should be seat 0');

    playHand(game);

    // Start hand 2
    game.state = 'ended';
    game.start();
    const dealer2 = game.dealerIndex;
    assert.equal(dealer2, 1, 'Second dealer should be seat 1');

    playHand(game);

    // Start hand 3
    game.state = 'ended';
    game.start();
    const dealer3 = game.dealerIndex;
    assert.equal(dealer3, 2, 'Third dealer should be seat 2');
  });

  await t.test('winnings carry over to next hand', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const h1total = game.seats.reduce((s, seat) => s + seat.chips + (seat.wonAmount || 0), 0);

    playHand(game);
    game.state = 'ended';
    game.start();

    const h2total = game.seats.reduce((s, seat) => s + seat.chips, 0);
    // After collecting winnings, total should be same as hand 1
    assert.equal(h2total, h1total);
  });
});

test('TexasHoldem - state API', async (t) => {
  await t.test('getState returns private hand for own player', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const state = game.getState('p1');
    assert.ok(state.hand);
    assert.equal(state.hand.length, 2);
    assert.equal(state.gameType, 'texas');
    assert.equal(state.validActions.length > 0, true);
  });

  await t.test('getPublicState hides hole cards', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const pub = game.getPublicState();
    pub.seats.forEach(s => {
      // Public state only shows card count, not actual cards
      assert.ok(s.cardCount !== undefined);
      assert.equal(s.hand, undefined);
    });
  });
});

test('TexasHoldem - edge cases', async (t) => {
  await t.test('heads-up: dealer acts first preflop', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    // In heads-up, dealer acts first preflop
    const currentPlayerId = getCurrentPlayer(game);
    const dealerPlayerId = game.seats[game.dealerIndex].playerId;
    assert.equal(currentPlayerId, dealerPlayerId);
  });

  await t.test('fold wins pot immediately', () => {
    const room = makeRoom({ defaultChips: 500 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2'), makePlayer('Carl', 'p3')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    // First player folds
    const pid1 = getCurrentPlayer(game);
    game.handleAction(pid1, 'fold', {});

    // Second player folds
    const pid2 = getCurrentPlayer(game);
    game.handleAction(pid2, 'fold', {});

    // Winner auto-awarded, now in showdown - process all show/muck
    playHand(game);
    assert.equal(game.handOver, true);
  });

  await t.test('heads-up fold awards blinds and preserves chip total', () => {
    const room = makeRoom({ defaultChips: 500, smallBlind: 10, bigBlind: 20 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const folderId = getCurrentPlayer(game);
    const winnerId = game.seats.find(s => s.playerId !== folderId).playerId;
    const result = game.handleAction(folderId, 'fold', {});
    assert.equal(result.error, undefined);

    const folder = game.seats.find(s => s.playerId === folderId);
    const winner = game.seats.find(s => s.playerId === winnerId);

    assert.equal(game.showdownPhase, true);
    assert.equal(game.pot, 30);
    assert.equal(folder.totalBet, 10);
    assert.equal(winner.totalBet, 20);
    assert.equal(winner.wonAmount, 30);
    assert.equal(folder.chips + folder.wonAmount + winner.chips + winner.wonAmount, 1000);

    game.state = 'ended';
    game.start();
    const totalAfterNextHandStarts = game.seats.reduce(
      (sum, seat) => sum + seat.chips + seat.roundBet + seat.wonAmount,
      0
    ) + game.pot;
    assert.equal(totalAfterNextHandStarts, 1000);
  });

  await t.test('rebuy cooldown auto-folds for 2 hands', () => {
    const room = makeRoom({ rebuyEnabled: true, rebuyMin: 100, rebuyMax: 1000, defaultChips: 500 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    // Simulate all-in loss and rebuy
    game.seats[0].chips = 0;
    game.rebuy('p1', 500);
    assert.equal(game.rebuyCooldown['p1'], 2);

    // Hand 1 - p1 auto-folded, cooldown 2→1
    playHand(game);
    game.state = 'ended';
    game.start();
    assert.equal(game.rebuyCooldown['p1'], 1);
    assert.equal(game.seats[0].folded, true, 'Hand 1: should be auto-folded');

    // Hand 2 - p1 auto-folded, cooldown 1→0
    playHand(game);
    game.state = 'ended';
    game.start();
    assert.equal(game.rebuyCooldown['p1'], 0);

    // Hand 3 - cooldown over, p1 plays normally
    playHand(game);
    game.state = 'ended';
    game.start();
    assert.equal(game.rebuyCooldown['p1'], 0);
    assert.equal(game.seats[0].folded, false, 'Hand 3: cooldown over, should NOT be folded');
  });

  await t.test('cooldown player is not dealt into a skipped two-player hand', () => {
    const room = makeRoom({ rebuyEnabled: true, rebuyMin: 100, rebuyMax: 1000, defaultChips: 500 });
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    game.seats[0].chips = 0;
    game.rebuy('p1', 500);
    game.state = 'ended';
    game.start();

    assert.equal(game.state, 'ended');
    assert.equal(game.seats[0].folded, true);
    assert.equal(game.seats[0].hand.length, 0);
  });

  await t.test('no immediate auto-fold on disconnect', () => {
    const room = makeRoom();
    room.players = [makePlayer('Alice', 'p1'), makePlayer('Bob', 'p2'), makePlayer('Carl', 'p3')];
    const game = new TexasHoldem(room, mockIO());
    game.start();

    const currentPid = getCurrentPlayer(game);
    game.onPlayerDisconnect(currentPid);
    const seat = game.seats.find(s => s.playerId === currentPid);
    // Player should NOT be auto-folded immediately — turn timer handles timeout.
    // This allows the player to reconnect and resume their turn on refresh.
    assert.equal(seat.folded, false);
  });
});
