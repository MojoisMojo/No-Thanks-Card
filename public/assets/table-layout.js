(() => {
  const DESKTOP_SEAT_LAYOUTS = Object.freeze({
    1: Object.freeze([{ x: 50, y: 15 }]),
    2: Object.freeze([{ x: 20, y: 27 }, { x: 80, y: 27 }]),
    3: Object.freeze([{ x: 14, y: 45 }, { x: 50, y: 15 }, { x: 86, y: 45 }]),
    4: Object.freeze([{ x: 13, y: 31 }, { x: 37, y: 15 }, { x: 63, y: 15 }, { x: 87, y: 31 }]),
  });

  function tableSeatPosition(index, playerCount) {
    return DESKTOP_SEAT_LAYOUTS[playerCount]?.[index] || { x: 50, y: 15 };
  }

  const api = Object.freeze({ DESKTOP_SEAT_LAYOUTS, tableSeatPosition });
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof window !== 'undefined') window.NO_THANKS_TABLE_LAYOUT = api;
})();
