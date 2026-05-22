const { v4: uuidv4 } = require('uuid');
const db = require('../db');

module.exports = {
  /** Save a completed hand to the database */
  saveHand(room, gameSession) {
    try {
      const endState = gameSession.getEndState();
      if (!endState || !endState.results) return;

      const handId = 'h_' + uuidv4().slice(0, 8);
      const d = db.get();

      d.prepare(`INSERT INTO hand_records (handId, roomCode, gameType, startedAt, endedAt, communityCards, pot, results)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        handId,
        room.code,
        room.gameType,
        gameSession._handStartedAt || Date.now(),
        Date.now(),
        JSON.stringify((endState.communityCards || []).map(c => c.toJSON ? c.toJSON() : c)),
        endState.pot || 0,
        JSON.stringify(endState.results)
      );

      const insertPlayer = d.prepare(`INSERT INTO hand_players (handId, userId, playerName, buyin, wonAmount, totalBet, folded, handJson)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

      for (const seat of gameSession.seats) {
        const player = room.getPlayer(seat.playerId);
        insertPlayer.run(
          handId,
          player ? player.userId : seat.playerId,
          player ? player.name : '',
          seat.totalBuyin || 0,
          seat.wonAmount || 0,
          seat.totalBet || 0,
          seat.folded ? 1 : 0,
          JSON.stringify((seat.hand || []).map(c => c.toJSON ? c.toJSON() : c))
        );
      }
    } catch (e) {
      console.error('[记录] 保存牌局失败:', e.message);
    }
  },

  /** Get hand history for a room */
  getRoomHands(roomCode, limit = 50) {
    const d = db.get();
    return d.prepare(`SELECT * FROM hand_records WHERE roomCode = ? ORDER BY endedAt DESC LIMIT ?`).all(roomCode, limit);
  }
};
