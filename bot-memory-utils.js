function getTurnDistance(turnOrder, selfId, otherId) {
  const selfIndex = turnOrder.indexOf(selfId);
  const otherIndex = turnOrder.indexOf(otherId);
  if (selfIndex < 0 || otherIndex < 0) throw new Error('座次中找不到玩家');
  return (otherIndex - selfIndex + turnOrder.length) % turnOrder.length;
}

function createMarkerLedger(playerIds, initialMarkers) {
  if (!Array.isArray(playerIds) || playerIds.length === 0) throw new Error('标记账本需要至少一名玩家');
  if (!Number.isInteger(initialMarkers) || initialMarkers < 0) throw new Error('初始标记数无效');
  return Object.fromEntries(playerIds.map((playerId) => [playerId, initialMarkers]));
}

function applyMarkerEvent(ledger, event) {
  if (!ledger || !Object.hasOwn(ledger, event.playerId)) throw new Error('标记账本中找不到行动者');
  if (!Number.isInteger(event.markers) || event.markers < 0) throw new Error('公开行动的标记数无效');
  if (event.action !== 'pass' && event.action !== 'take') throw new Error('公开行动类型无效');
  const markerChange = event.action === 'pass' ? -event.markers : event.markers;
  return { ...ledger, [event.playerId]: ledger[event.playerId] + markerChange };
}

module.exports = { applyMarkerEvent, createMarkerLedger, getTurnDistance };
