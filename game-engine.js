const CARD_MIN = 3;
const CARD_MAX = 35;
const REMOVED_CARD_COUNT = 9;
const INITIAL_MARKERS = 11;

function defaultRandomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function shuffle(values, randomInt) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function cloneState(state) {
  return {
    ...state,
    deck: [...state.deck],
    players: state.players.map((player) => ({ ...player, cards: [...player.cards] })),
  };
}

function score(cards, markers) {
  const ordered = [...cards].sort((a, b) => a - b);
  let cardPoints = 0;
  const runs = [];
  for (let index = 0; index < ordered.length; index += 1) {
    if (index === 0 || ordered[index] !== ordered[index - 1] + 1) {
      cardPoints += ordered[index];
      runs.push({ lowest: ordered[index], cards: [ordered[index]] });
    } else {
      runs[runs.length - 1].cards.push(ordered[index]);
    }
  }
  return { cardPoints, markers, total: cardPoints - markers, runs };
}

function createGame(playerIds, options = {}) {
  if (!Array.isArray(playerIds) || playerIds.length < 3 || playerIds.length > 5) {
    throw new Error('需要 3-5 名玩家才能开始');
  }
  if (new Set(playerIds).size !== playerIds.length || playerIds.some((id) => !id)) {
    throw new Error('玩家标识必须唯一');
  }

  const randomInt = options.randomInt || defaultRandomInt;
  const fullDeck = Array.from({ length: CARD_MAX - CARD_MIN + 1 }, (_, index) => CARD_MIN + index);
  const deck = options.deck ? [...options.deck] : shuffle(fullDeck, randomInt).slice(REMOVED_CARD_COUNT);
  if (deck.length === 0) throw new Error('牌库不能为空');

  return {
    phase: 'playing',
    deck,
    drawIndex: 0,
    currentCard: deck[0],
    currentPlayerId: playerIds[randomInt(playerIds.length)],
    pot: 0,
    players: playerIds.map((id) => ({ id, markers: options.initialMarkers ?? INITIAL_MARKERS, cards: [] })),
  };
}

function legalActions(state, playerId) {
  if (state.phase !== 'playing' || state.currentPlayerId !== playerId) return [];
  const player = state.players.find((entry) => entry.id === playerId);
  if (!player) return [];
  return player.markers > 0 ? ['take', 'pass'] : ['take'];
}

function applyAction(state, playerId, action) {
  if (state.phase !== 'playing') throw new Error('当前不在进行中的游戏');
  if (state.currentPlayerId !== playerId) throw new Error('还没轮到你');
  const next = cloneState(state);
  const player = next.players.find((entry) => entry.id === playerId);
  if (!player) throw new Error('玩家不存在');

  if (action === 'pass') {
    if (player.markers <= 0) throw new Error('你已经没有标记，不能拒收');
    player.markers -= 1;
    next.pot += 1;
    const currentIndex = next.players.findIndex((entry) => entry.id === playerId);
    next.currentPlayerId = next.players[(currentIndex + 1) % next.players.length].id;
    return {
      state: next,
      event: { kind: 'pass', playerId, card: next.currentCard, markers: 1 },
    };
  }

  if (action !== 'take') throw new Error('动作必须是 take 或 pass');
  const card = next.currentCard;
  const markers = next.pot;
  player.cards.push(card);
  player.markers += markers;
  next.pot = 0;
  next.drawIndex += 1;
  if (next.drawIndex >= next.deck.length) {
    next.phase = 'finished';
    next.currentCard = null;
    next.currentPlayerId = null;
  } else {
    next.currentCard = next.deck[next.drawIndex];
  }
  return {
    state: next,
    event: { kind: 'take', playerId, card, markers, finished: next.phase === 'finished' },
  };
}

module.exports = { applyAction, createGame, legalActions, score };
