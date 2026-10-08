const { legalActions, score } = require('./game-engine');
const { buildDecisionEnvironment } = require('./bot-context');

const RECORD_SCHEMA_VERSION = 1;

function snapshotState(state) {
  return {
    phase: state.phase,
    deck: [...state.deck],
    drawIndex: state.drawIndex,
    currentCard: state.currentCard,
    currentPlayerId: state.currentPlayerId,
    pot: state.pot,
    players: state.players.map((player) => ({
      id: player.id,
      markers: player.markers,
      cards: [...player.cards],
    })),
  };
}

function playerMetadata(players) {
  return players.map((player) => ({
    id: player.id,
    name: player.name,
    isBot: player.isBot,
    botLevel: player.isBot ? player.botLevel : null,
  }));
}

function createGameRecord(room, initialState) {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    type: 'no-thanks-game-record',
    startedAt: new Date().toISOString(),
    room: { id: room.id, name: room.name },
    players: playerMetadata(room.players),
    initialState: snapshotState(initialState),
    turns: [],
    result: null,
  };
}

// This is the fixed decision environment supplied to offline training. It omits
// the deck and future cards; strategies may combine it with their own memory.
function decisionObservation(state, playerId, actionIndex = 0) {
  return {
    ...buildDecisionEnvironment(state, playerId, actionIndex),
    legalActions: legalActions(state, playerId),
  };
}

function recordTurn(record, { playerId, action, observation, event }) {
  if (!record) return;
  record.turns.push({
    index: record.turns.length,
    playerId,
    action,
    observation,
    event: { ...event },
  });
}

function finishGameRecord(record, finalState) {
  if (!record) return;
  record.finishedAt = new Date().toISOString();
  record.result = {
    players: finalState.players.map((player) => ({
      playerId: player.id,
      cards: [...player.cards].sort((a, b) => a - b),
      markers: player.markers,
      score: score(player.cards, player.markers),
    })),
  };
}

module.exports = {
  createGameRecord,
  decisionObservation,
  finishGameRecord,
  recordTurn,
};
