const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BOT_LEVELS,
  createBotMemory,
  decideBotAction,
  formatBotName,
  observeBotEvent,
} = require('../bot-strategies');

const matchSetup = Object.freeze({ selfId: 'a', turnOrder: ['a', 'b', 'c'], initialMarkers: 11, deckSize: 24 });

function env({ cards = [], currentCard, markers = 11, pot = 0, otherPlayers = [] }) {
  return {
    actionIndex: 0,
    cardIndex: 0,
    currentCard,
    pot,
    self: { id: 'a', cards, markers },
    otherPlayers,
  };
}

function memoryFor(level) {
  return createBotMemory({ level, matchSetup });
}

function decide(input, level = BOT_LEVELS.BEGINNER, memory = memoryFor(level)) {
  return decideBotAction({ level, env: input, memory });
}

test('人机名称包含难度并使用两位编号', () => {
  assert.equal(formatBotName(BOT_LEVELS.BEGINNER, 1), '初级人机01');
  assert.equal(formatBotName(BOT_LEVELS.INTERMEDIATE, 12), '中级人机12');
  assert.equal(formatBotName(BOT_LEVELS.ADVANCED, 3), '高级人机03');
});

test('初级人机优先收下能桥接连续段的牌', () => {
  assert.equal(decide(env({ cards: [22, 24], currentCard: 23 })), 'take');
});

test('初级人机对免费连牌先等待砝码，之后收下', () => {
  const observation = env({ cards: [22, 23, 24], currentCard: 25 });
  assert.equal(decide(observation), 'pass');
  assert.equal(decide({ ...observation, pot: 1 }), 'take');
});

test('初级人机在没有标记时只能收牌，并会拒绝孤立高牌', () => {
  assert.equal(decide(env({ currentCard: 30, markers: 0 })), 'take');
  assert.equal(decide(env({ currentCard: 30 })), 'pass');
});

test('中级人机会为已累积的砝码接受可控的牌分', () => {
  const observation = env({ currentCard: 12, pot: 10 });
  assert.equal(decide(observation), 'pass');
  assert.equal(decide(observation, BOT_LEVELS.INTERMEDIATE), 'take');
});

test('高级人机只以公开牌防止对手补齐连续段', () => {
  const observation = env({
    cards: [3],
    currentCard: 12,
    pot: 8,
    otherPlayers: [{ id: 'b', cards: [11, 13] }, { id: 'c', cards: [20] }],
  });
  assert.equal(decide(observation, BOT_LEVELS.INTERMEDIATE), 'pass');
  assert.equal(decide(observation, BOT_LEVELS.ADVANCED), 'take');
});

test('高级人机在没有公开对手收益时回退到中级判断', () => {
  const observation = env({ currentCard: 25, pot: 1, otherPlayers: [{ id: 'b', cards: [10] }] });
  assert.equal(decide(observation, BOT_LEVELS.ADVANCED), 'pass');
});

test('高级人机从自己的 memory 推导低标记压力', () => {
  const observation = env({ currentCard: 20, pot: 15, otherPlayers: [{ id: 'b', cards: [19, 21] }] });
  let memory = memoryFor(BOT_LEVELS.ADVANCED);
  assert.equal(decide(observation, BOT_LEVELS.ADVANCED, memory), 'pass');
  for (let index = 0; index < 9; index += 1) {
    memory = observeBotEvent({
      level: BOT_LEVELS.ADVANCED,
      memory,
      event: { actionIndex: index, cardIndex: 0, playerId: 'b', action: 'pass', card: 20, potBefore: index, markers: 1 },
    });
  }
  assert.equal(memory.inferredMarkers.b, 2);
  assert.equal(decide(observation, BOT_LEVELS.ADVANCED, memory), 'take');
});

test('初级和中级可以保持自定义的空 memory', () => {
  const memory = memoryFor(BOT_LEVELS.BEGINNER);
  assert.equal(memory, null);
  assert.equal(observeBotEvent({
    level: BOT_LEVELS.BEGINNER,
    memory,
    event: { actionIndex: 0, cardIndex: 0, playerId: 'b', action: 'pass', card: 20, potBefore: 0, markers: 1 },
  }), null);
});
