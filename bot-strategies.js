const { score } = require('./game-engine');
const { applyMarkerEvent, createMarkerLedger } = require('./bot-memory-utils');

const BOT_LEVELS = Object.freeze({
  BEGINNER: 'beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
});

const BOT_LEVEL_LABELS = Object.freeze({
  [BOT_LEVELS.BEGINNER]: '初级',
  [BOT_LEVELS.INTERMEDIATE]: '中级',
  [BOT_LEVELS.ADVANCED]: '高级',
});

function formatBotName(level, number) {
  const label = BOT_LEVEL_LABELS[level];
  if (!label) throw new Error('人机等级无效');
  if (!Number.isInteger(number) || number < 1) throw new Error('人机编号必须是正整数');
  return `${label}人机${String(number).padStart(2, '0')}`;
}

const LOW_CARD_THRESHOLD = 10;
const LOW_CARD_ACCEPTABLE_PENALTY = 3;
const LOW_MARKER_ACCEPTABLE_PENALTY = 2;
const MARKER_RESERVE = 3;
const INTERMEDIATE_MARKER_RESERVE = 5;

function cardPoints(cards) {
  return score(cards, 0).cardPoints;
}

function marginalCardPoints(cards, card) {
  return cardPoints([...cards, card]) - cardPoints(cards);
}

function acceptablePenalty({ currentCard, markers }) {
  if (markers <= MARKER_RESERVE) return LOW_MARKER_ACCEPTABLE_PENALTY;
  if (currentCard <= LOW_CARD_THRESHOLD) return LOW_CARD_ACCEPTABLE_PENALTY;
  return 0;
}

function intermediateAcceptablePenalty({ currentCard, markers, pot }) {
  // 中级会更早地把标记当作稀缺资源，也会更重视已经累积的砝码。
  if (markers <= INTERMEDIATE_MARKER_RESERVE) return 4;
  if (currentCard <= LOW_CARD_THRESHOLD) return 4;
  if (currentCard <= 18) return 2;
  if (pot >= 3) return 2;
  return 0;
}

// 初级人机只使用自己的公开状态与桌面中央信息，不读取对手或未翻牌资料。
function chooseBeginnerAction({ env }) {
  const { cards, markers } = env.self;
  const { currentCard, pot } = env;
  if (markers <= 0) return 'take';

  const cardPointDelta = marginalCardPoints(cards, currentCard);
  const netScoreDelta = cardPointDelta - pot;

  // 补牌或桥接连续段会直接降低牌分，不等待砝码以免被其他玩家收走。
  if (cardPointDelta < 0) return 'take';

  // 接在已有连续段后不增加牌分时，空砝码先拒收一次；牌绕一圈回来时已有砝码就收。
  if (cardPointDelta === 0) {
    return pot > 0 || markers <= MARKER_RESERVE ? 'take' : 'pass';
  }

  if (netScoreDelta <= acceptablePenalty({ currentCard, markers })) return 'take';
  return 'pass';
}

// 中级仍只根据自己的牌、标记和公共桌面做判断，但会区分“放弃一枚标记”
// 与“收下一张会增加多少最终牌分”的代价。
function chooseIntermediateAction({ env }) {
  const { cards, markers } = env.self;
  const { currentCard, pot } = env;
  if (markers <= 0) return 'take';

  const cardPointDelta = marginalCardPoints(cards, currentCard);
  const netScoreDelta = cardPointDelta - pot;

  if (cardPointDelta < 0) return 'take';
  if (cardPointDelta === 0) {
    return pot > 0 || markers <= INTERMEDIATE_MARKER_RESERVE ? 'take' : 'pass';
  }

  if (netScoreDelta <= intermediateAcceptablePenalty({ currentCard, markers, pot })) return 'take';
  return 'pass';
}

function bestOpponentOpportunity(otherPlayers, currentCard) {
  const opportunities = otherPlayers
    .filter((player) => Array.isArray(player.cards))
    .map((player) => ({ player, cardPointDelta: marginalCardPoints(player.cards, currentCard) }));
  if (!opportunities.length) return null;
  return opportunities.reduce((best, candidate) => (
    candidate.cardPointDelta < best.cardPointDelta ? candidate : best
  ));
}

// 高级在中级的基础上读取所有玩家已经公开摆出的牌，并从公开动作账本推导
// 对手标记数。它不会读取未翻牌或牌库顺序；当某张牌会让对手补齐/桥接连续段
// 时，会在自身代价可承受的范围内优先截胡。
function chooseAdvancedAction({ env, memory }) {
  const intermediateAction = chooseIntermediateAction({ env });
  if (intermediateAction === 'take' || env.self.markers <= 0) return 'take';

  const opportunity = bestOpponentOpportunity(env.otherPlayers || [], env.currentCard);
  if (!opportunity || opportunity.cardPointDelta > 0) return 'pass';

  const ownNetScoreDelta = marginalCardPoints(env.self.cards, env.currentCard) - env.pot;
  const baseDenialAllowance = opportunity.cardPointDelta < 0 ? 4 : 2;
  // 标记很少的对手即将失去继续拒收的余地，因而更可能被迫收下当前牌。
  const inferredMarkers = memory?.inferredMarkers?.[opportunity.player.id];
  const forcedTakePressure = Number.isInteger(inferredMarkers) && inferredMarkers <= 2 ? 1 : 0;
  const denialAllowance = baseDenialAllowance + forcedTakePressure;
  return ownNetScoreDelta <= denialAllowance ? 'take' : 'pass';
}

function createEmptyMemory() {
  return null;
}

function preserveMemory(memory) {
  return memory;
}

function createAdvancedMemory(matchSetup) {
  return {
    inferredMarkers: createMarkerLedger(matchSetup.turnOrder, matchSetup.initialMarkers),
  };
}

function observeAdvancedEvent(memory, event) {
  return { ...memory, inferredMarkers: applyMarkerEvent(memory.inferredMarkers, event) };
}

const strategies = new Map([
  [BOT_LEVELS.BEGINNER, { createMemory: createEmptyMemory, onPublicEvent: preserveMemory, decide: chooseBeginnerAction }],
  [BOT_LEVELS.INTERMEDIATE, { createMemory: createEmptyMemory, onPublicEvent: preserveMemory, decide: chooseIntermediateAction }],
  [BOT_LEVELS.ADVANCED, { createMemory: createAdvancedMemory, onPublicEvent: observeAdvancedEvent, decide: chooseAdvancedAction }],
]);

function strategyFor(level) {
  const strategy = strategies.get(level);
  if (!strategy) throw new Error(`${BOT_LEVEL_LABELS[level] || level}人机策略暂未实现`);
  return strategy;
}

function createBotMemory({ level, matchSetup }) {
  return strategyFor(level).createMemory(matchSetup);
}

function observeBotEvent({ level, memory, event }) {
  return strategyFor(level).onPublicEvent(memory, event);
}

// 策略决策本身是纯函数：同一份 env 和 memory 必定返回同一动作。
function decideBotAction({ level, env, memory }) {
  return strategyFor(level).decide({ env, memory });
}

module.exports = {
  BOT_LEVEL_LABELS,
  BOT_LEVELS,
  createBotMemory,
  decideBotAction,
  formatBotName,
  observeBotEvent,
};
