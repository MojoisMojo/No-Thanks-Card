const assert = require('node:assert/strict');
const test = require('node:test');
const { applyMarkerEvent, createMarkerLedger, getTurnDistance } = require('../bot-memory-utils');

test('公共记忆工具可以推导循环座次与标记账本', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(getTurnDistance(order, 'a', 'b'), 1);
  assert.equal(getTurnDistance(order, 'a', 'c'), 2);
  assert.equal(getTurnDistance(order, 'c', 'a'), 1);

  let ledger = createMarkerLedger(order, 11);
  ledger = applyMarkerEvent(ledger, { playerId: 'a', action: 'pass', markers: 1 });
  ledger = applyMarkerEvent(ledger, { playerId: 'b', action: 'pass', markers: 1 });
  ledger = applyMarkerEvent(ledger, { playerId: 'c', action: 'take', markers: 2 });
  assert.deepEqual(ledger, { a: 10, b: 10, c: 13 });
});
