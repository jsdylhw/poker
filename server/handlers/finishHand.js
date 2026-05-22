/** Shared end-of-hand logic used by both normal action handler and timeout */
function finishHand(io, room) {
  if (!room.gameSession || !(room.gameSession.handOver || room.gameSession.state === 'ended')) return;

  const endState = room.gameSession.getEndState();
  io.to(room.code).emit('game:ended', endState);
  room.state = 'ended';

  if (!room.gameSession._handRecordSaved) {
    room.gameSession._handRecordSaved = true;
    try { require('../records/HandRecords').saveHand(room, room.gameSession); } catch (e) {}
  }
}

module.exports = finishHand;
