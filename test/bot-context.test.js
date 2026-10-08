const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDecisionEnvironment, buildMatchSetup, buildPublicActionEvent } = require('../bot-context');

const state = {
  deck: [20, 21],
  drawIndex: 0,
  currentCard: 20,
  pot: 2,
  players: [
    { id: 'a', markers: 10, cards: [3] },
    { id: 'b', markers: 11, cards: [4] },
    { id: 'c', markers: 12, cards: [] },
  ],
};

test('人机环境使用统一的零开始索引，并把固定信息留给开局配置', () => {
  assert.deepEqual(buildMatchSetup(state, 'a'), {
    selfId: 'a',
    turnOrder: ['a', 'b', 'c'],
    initialMarkers: 10,
    deckSize: 2,
  });
  assert.deepEqual(buildDecisionEnvironment(state, 'a', 7), {
    actionIndex: 7,
    cardIndex: 0,
    currentCard: 20,
    pot: 2,
    self: { id: 'a', cards: [3], markers: 10 },
    otherPlayers: [{ id: 'b', cards: [4] }, { id: 'c', cards: [] }],
  });
});

test('公开行动事件带有对应的零开始行动和牌索引', () => {
  assert.deepEqual(buildPublicActionEvent(state, {
    actionIndex: 7,
    playerId: 'a',
    action: 'take',
    event: { card: 20, markers: 2 },
  }), {
    actionIndex: 7,
    cardIndex: 0,
    playerId: 'a',
    action: 'take',
    card: 20,
    potBefore: 2,
    markers: 2,
  });
});
