const assert = require('node:assert/strict');
const test = require('node:test');
const { applyAction, createGame, legalActions, score } = require('../game-engine');

test('游戏引擎可在不创建房间的情况下完成一局', () => {
  const game = createGame(['a', 'b', 'c'], { deck: [20, 21], randomInt: () => 0 });
  assert.equal(game.currentPlayerId, 'a');
  assert.deepEqual(legalActions(game, 'a'), ['take', 'pass']);

  const passed = applyAction(game, 'a', 'pass');
  assert.equal(game.players[0].markers, 11, '原状态不被动作修改');
  assert.equal(passed.state.currentPlayerId, 'b');
  assert.equal(passed.state.pot, 1);

  const taken = applyAction(passed.state, 'b', 'take');
  assert.deepEqual(taken.state.players[1].cards, [20]);
  assert.equal(taken.state.players[1].markers, 12);
  assert.equal(taken.state.currentCard, 21);

  const finished = applyAction(taken.state, 'b', 'take');
  assert.equal(finished.state.phase, 'finished');
  assert.equal(finished.state.currentCard, null);
  assert.equal(finished.event.finished, true);
});

test('连续牌只计连续段的最低牌，并扣除标记', () => {
  assert.deepEqual(score([25, 23, 24, 30], 5), {
    cardPoints: 53,
    markers: 5,
    total: 48,
    runs: [
      { lowest: 23, cards: [23, 24, 25] },
      { lowest: 30, cards: [30] },
    ],
  });
});
