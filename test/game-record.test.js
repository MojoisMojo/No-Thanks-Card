const assert = require('node:assert/strict');
const test = require('node:test');
const { applyAction, createGame } = require('../game-engine');
const { createGameRecord, decisionObservation, finishGameRecord, recordTurn } = require('../game-record');

test('对局记录保存可回放初始状态，并为离线学习保存无牌库的决策观察', () => {
  const room = {
    id: 'room-demo',
    name: '演示对局',
    players: [
      { id: 'a', name: '甲', isBot: false },
      { id: 'b', name: '乙', isBot: true, botLevel: 'beginner' },
      { id: 'c', name: '丙', isBot: false },
    ],
  };
  const initial = createGame(['a', 'b', 'c'], { deck: [20], randomInt: () => 0 });
  const record = createGameRecord(room, initial);
  const observation = decisionObservation(initial, 'a', 0);
  assert.equal('deck' in observation, false);
  assert.deepEqual(observation.legalActions, ['take', 'pass']);
  assert.equal(observation.actionIndex, 0);
  assert.equal(observation.cardIndex, 0);
  assert.deepEqual(observation.otherPlayers, [{ id: 'b', cards: [] }, { id: 'c', cards: [] }]);

  const { state, event } = applyAction(initial, 'a', 'take');
  recordTurn(record, { playerId: 'a', action: 'take', observation, event });
  finishGameRecord(record, state);

  assert.deepEqual(record.initialState.deck, [20]);
  assert.equal(record.turns[0].event.card, 20);
  assert.equal(record.result.players[0].score.cardPoints, 20);
  assert.deepEqual(record.result.players[0].score.runs, [{ lowest: 20, cards: [20] }]);
});
