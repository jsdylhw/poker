const { test } = require('node:test');
const assert = require('node:assert');
const RoomManager = require('../server/rooms/RoomManager');
const Room = require('../server/rooms/Room');
const userManager = require('../server/users/UserManager');

// Helper: register a user and return { userId, displayName }
function regUser(name) {
  return userManager.register(name);
}

test('RoomManager - create and join', async (t) => {
  await t.test('creates a room and auto-readies host', () => {
    const rm = new RoomManager();
    const user = regUser('Alice');
    const result = rm.createRoom('texas', 'sock1', user.displayName, user.userId);
    assert.equal(result.error, undefined);
    assert.ok(result.room);
    assert.ok(result.player);
    assert.equal(result.room.code.length, 4);
    assert.equal(result.room.gameType, 'texas');
    assert.equal(result.room.players.length, 1);
    assert.equal(result.player.isReady, true, 'Host should be auto-ready');
  });

  await t.test('generates unique room codes', () => {
    const rm = new RoomManager();
    const codes = new Set();
    for (let i = 0; i < 100; i++) {
      const u = regUser(`Player${i}`);
      const r = rm.createRoom('texas', `s${i}`, u.displayName, u.userId);
      codes.add(r.room.code);
    }
    // All codes should be unique (probabilistic, but 100 rooms from 31^4 space)
    assert.ok(codes.size >= 99, `Expected >=99 unique codes, got ${codes.size}`);
  });

  await t.test('joins an existing room', () => {
    const rm = new RoomManager();
    const u1 = regUser('Alice');
    const { room } = rm.createRoom('texas', 'sock1', u1.displayName, u1.userId);
    const u2 = regUser('Bob');
    const result = rm.joinRoom(room.code, 'sock2', u2.displayName, u2.userId);

    assert.equal(result.error, undefined);
    assert.equal(result.room.players.length, 2);
    assert.equal(result.player.name, 'Bob');
    assert.equal(result.player.seatIndex, 1);
  });

  await t.test('rejects join on non-existent room', () => {
    const rm = new RoomManager();
    const u = regUser('Alice');
    const result = rm.joinRoom('XXXX', 'sock1', u.displayName, u.userId);
    assert.ok(result.error);
  });

  await t.test('rejects join on full room', () => {
    const rm = new RoomManager();
    const u0 = regUser('Host');
    const { room } = rm.createRoom('texas', 'sock1', u0.displayName, u0.userId);
    for (let i = 1; i < 9; i++) {
      const u = regUser(`Player${i}`);
      rm.joinRoom(room.code, `s${i + 1}`, u.displayName, u.userId);
    }
    const ux = regUser('Extra');
    const result = rm.joinRoom(room.code, 'sock11', ux.displayName, ux.userId);
    assert.ok(result.error);
    assert.equal(result.error, '房间已满');
  });
});

test('RoomManager - leave and disconnect', async (t) => {
  await t.test('player leaves room', () => {
    const rm = new RoomManager();
    const u1 = regUser('Alice');
    const { room } = rm.createRoom('texas', 'sock1', u1.displayName, u1.userId);
    const u2 = regUser('Bob');
    rm.joinRoom(room.code, 'sock2', u2.displayName, u2.userId);

    const result = rm.leaveRoom('sock2');
    assert.equal(result.room.players.length, 1);
    assert.equal(room.players[0].name, 'Alice');
  });

  await t.test('host transfers on leave', () => {
    const rm = new RoomManager();
    const u1 = regUser('Alice');
    const { room, player: alice } = rm.createRoom('texas', 'sock1', u1.displayName, u1.userId);
    const u2 = regUser('Bob');
    const { player: bob } = rm.joinRoom(room.code, 'sock2', u2.displayName, u2.userId);

    assert.equal(room.hostId, alice.id);
    rm.leaveRoom('sock1');
    assert.equal(room.hostId, bob.id);
  });

  await t.test('empty room is cleaned up', () => {
    const rm = new RoomManager();
    const u = regUser('Alice');
    const { room } = rm.createRoom('texas', 'sock1', u.displayName, u.userId);
    const code = room.code;
    rm.leaveRoom('sock1');
    assert.equal(rm.getRoomByCode(code), undefined);
  });

  await t.test('disconnect marks player offline', () => {
    const rm = new RoomManager();
    const u = regUser('Alice');
    const { room } = rm.createRoom('texas', 'sock1', u.displayName, u.userId);
    const result = rm.disconnectSocket('sock1');
    assert.ok(result);
    assert.equal(room.players[0].isOnline, false);
    assert.equal(room.players[0].socketId, null);
    assert.equal(rm.socketPlayer.get('sock1'), undefined);
  });

  await t.test('reconnect updates socket and re-onlines player', () => {
    const rm = new RoomManager();
    const u = regUser('Alice');
    const { room, player } = rm.createRoom('texas', 'sock1', u.displayName, u.userId);
    rm.disconnectSocket('sock1');
    const result = rm.reconnectSocket('sock2_new', player.id);
    assert.ok(result);
    assert.equal(room.players[0].isOnline, true);
    assert.equal(room.players[0].socketId, 'sock2_new');
  });
});

test('Room - settings', async (t) => {
  await t.test('default settings are populated', () => {
    const room = new Room('TEST', 'texas', 'host1');
    assert.equal(room.settings.smallBlind, 10);
    assert.equal(room.settings.bigBlind, 20);
    assert.equal(room.settings.defaultChips, 1000);
    assert.equal(room.settings.turnTime, 30);
    assert.equal(room.settings.runItTwice, false);
    assert.equal(room.settings.rebuyEnabled, true);
    assert.equal(room.settings.rebuyMin, 200);
    assert.equal(room.settings.rebuyMax, 2000);
  });

  await t.test('host can update settings', () => {
    const room = new Room('TEST', 'texas', 'host1');
    const result = room.updateSettings('host1', {
      smallBlind: 25,
      bigBlind: 50,
      turnTime: 60,
    });
    assert.equal(result.error, undefined);
    assert.equal(room.settings.smallBlind, 25);
    assert.equal(room.settings.bigBlind, 50);
    assert.equal(room.settings.turnTime, 60);
    // Unchanged settings stay the same
    assert.equal(room.settings.runItTwice, false);
  });

  await t.test('non-host cannot update settings', () => {
    const room = new Room('TEST', 'texas', 'host1');
    const result = room.updateSettings('guest', { smallBlind: 100 });
    assert.ok(result.error);
    assert.equal(room.settings.smallBlind, 10); // unchanged
  });

  await t.test('invalid settings are rejected', () => {
    const room = new Room('TEST', 'texas', 'host1');
    const result = room.updateSettings('host1', { invalidKey: 123 });
    assert.ok(result.error);
  });

  await t.test('swaps blinds if big < small', () => {
    const room = new Room('TEST', 'texas', 'host1');
    room.updateSettings('host1', { smallBlind: 100, bigBlind: 50 });
    assert.equal(room.settings.smallBlind, 50);
    assert.equal(room.settings.bigBlind, 100);
  });
});

test('RoomManager - userId based identity', async (t) => {
  await t.test('getRoomByUserId finds room for user', () => {
    const rm = new RoomManager();
    const ua = regUser('Alice'); const ub = regUser('Bob');
    const { room } = rm.createRoom('texas', 'sock1', ua.displayName, ua.userId);
    rm.joinRoom(room.code, 'sock2', ub.displayName, ub.userId);
    const user_a = ua.userId; const user_b = ub.userId;

    const found = rm.getRoomByUserId(user_a);
    assert.ok(found);
    assert.equal(found.code, room.code);

    const found2 = rm.getRoomByUserId(user_b);
    assert.ok(found2);

    assert.equal(rm.getRoomByUserId('user_unknown'), null);
  });

  await t.test('duplicate userId join reuses existing player', () => {
    const rm = new RoomManager();
    const u = regUser('Alice');
    const { room } = rm.createRoom('texas', 'sock1', u.displayName, u.userId);

    // Same userId joins again with new socket
    const result = rm.joinRoom(room.code, 'sock1_new', u.displayName, u.userId);
    assert.equal(result.error, undefined);
    assert.equal(room.players.length, 1, 'Should not create duplicate player');
    assert.equal(result.player.socketId, 'sock1_new');
    assert.equal(rm.socketPlayer.get('sock1'), undefined, 'Old socket mapping removed');
    assert.equal(rm.socketPlayer.get('sock1_new'), result.player.id);
  });

  await t.test('DB restored room has correct hostId and seat order', () => {
    const rm = new RoomManager();
    // Simulate DB restore path
    const data = {
      code: 'REST',
      gameType: 'texas',
      hostId: '', // Will be fixed to playerId
      settings: {},
      createdAt: Date.now(),
      players: [
        { name: 'Alice', userId: 'u1', playerId: 'p1', seatIndex: 0, isReady: true },
        { name: 'Bob', userId: 'u2', playerId: 'p2', seatIndex: 1, isReady: false },
      ],
    };
    // Set hostUserId in data (simulating DB row)
    data.hostId = 'u1'; // Simulating what loadFromDB fixes

    const result = rm.restoreRoom(data);
    assert.equal(result.error, undefined);
    const room = rm.getRoomByCode('REST');
    assert.ok(room);
    assert.equal(room.players.length, 2);
    // Seat order preserved
    assert.equal(room.players[0].seatIndex, 0);
    assert.equal(room.players[1].seatIndex, 1);
    assert.equal(room.players[0].name, 'Alice');
    assert.equal(room.players[1].name, 'Bob');
    // HostId was the userId - should now be playerId
    assert.equal(room.hostId, 'p1');
    assert.equal(room.hostId, room.players[0].id);
  });

  await t.test('toJSON includes isHost for viewer', () => {
    const room = new Room('TEST', 'texas', 'player1');
    room.players.push({ id: 'player1', name: 'Host', seatIndex: 0, isReady: true, toJSON: () => ({ id: 'player1' }), userId: 'u1' });
    room.players.push({ id: 'player2', name: 'Guest', seatIndex: 1, isReady: false, toJSON: () => ({ id: 'player2' }), userId: 'u2' });

    const hostView = room.toJSON('player1');
    assert.equal(hostView.isHost, true);
    assert.equal(hostView.myPlayerId, 'player1');

    const guestView = room.toJSON('player2');
    assert.equal(guestView.isHost, false);
    assert.equal(guestView.myPlayerId, 'player2');
  });
});

test('Room - canStart', async (t) => {
  await t.test('returns false if not enough players', () => {
    const room = new Room('TEST', 'texas', 'host1');
    assert.equal(room.canStart(), false);
  });

  await t.test('returns false if players not ready', () => {
    const room = new Room('TEST', 'texas', 'host1');
    room.addPlayer({ id: 'p1', isReady: true, isOnline: true, seatIndex: 0, toJSON: () => ({}) });
    room.addPlayer({ id: 'p2', isReady: false, isOnline: true, seatIndex: 1, toJSON: () => ({}) });
    assert.equal(room.canStart(), false);
  });

  await t.test('returns true when all ready and min met', () => {
    const room = new Room('TEST', 'texas', 'host1');
    room.addPlayer({ id: 'p1', isReady: true, isOnline: true, seatIndex: 0, toJSON: () => ({}) });
    room.addPlayer({ id: 'p2', isReady: true, isOnline: true, seatIndex: 1, toJSON: () => ({}) });
    assert.equal(room.canStart(), true);
  });
});
