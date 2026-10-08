const assert = require('node:assert/strict');
const test = require('node:test');
const { DESKTOP_SEAT_LAYOUTS, tableSeatPosition } = require('../public/assets/table-layout');

test('桌面端 1–4 名对手均使用彼此分离的固定座位', () => {
  for (const playerCount of [1, 2, 3, 4]) {
    const seats = DESKTOP_SEAT_LAYOUTS[playerCount];
    assert.equal(seats.length, playerCount);
    seats.forEach((seat, index) => assert.deepEqual(tableSeatPosition(index, playerCount), seat));
    for (let leftIndex = 0; leftIndex < seats.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < seats.length; rightIndex += 1) {
        const left = seats[leftIndex];
        const right = seats[rightIndex];
        assert.ok(Math.abs(left.x - right.x) >= 24 || Math.abs(left.y - right.y) >= 16);
      }
    }
  }
});
