function buildMatchSetup(state, selfId) {
  const self = state.players.find((player) => player.id === selfId);
  if (!self) throw new Error('初始化人机时找不到玩家');
  return {
    selfId,
    turnOrder: state.players.map((player) => player.id),
    initialMarkers: self.markers,
    deckSize: state.deck.length,
  };
}

function buildDecisionEnvironment(state, playerId, actionIndex) {
  const self = state.players.find((player) => player.id === playerId);
  if (!self) throw new Error('构造人机环境时找不到玩家');
  return {
    actionIndex,
    cardIndex: state.drawIndex,
    currentCard: state.currentCard,
    pot: state.pot,
    self: {
      id: self.id,
      cards: [...self.cards],
      markers: self.markers,
    },
    otherPlayers: state.players
      .filter((player) => player.id !== playerId)
      .map((player) => ({ id: player.id, cards: [...player.cards] })),
  };
}

function buildPublicActionEvent(state, { actionIndex, playerId, action, event }) {
  return {
    actionIndex,
    cardIndex: state.drawIndex,
    playerId,
    action,
    card: event.card,
    potBefore: state.pot,
    markers: event.markers,
  };
}

module.exports = { buildDecisionEnvironment, buildMatchSetup, buildPublicActionEvent };
