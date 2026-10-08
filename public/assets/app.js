const app = {
  session: JSON.parse(sessionStorage.getItem('noThanksSession') || 'null'),
  state: null,
  events: null,
  heartbeat: null,
  replay: null,
  replayStep: -1,
  replayTimer: null,
  replaySpeed: 1,
  replaySource: null,
  quickChatBubbleTimer: null,
  quickChatArrivalTimes: new Map(),
};

const PLAYER_NAME_STORAGE_KEY = 'noThanksPlayerName';
const QUICK_CHAT_BUBBLE_MS = 5000;
const MAX_QUICK_CHAT_ARRIVAL_TIMES = 24;
const QUICK_CHAT_PHRASES = Array.isArray(window.QUICK_CHAT_MESSAGES) ? window.QUICK_CHAT_MESSAGES : [];
const quickChatPhraseById = new Map(QUICK_CHAT_PHRASES.map((phrase) => [phrase.id, phrase.text]));
const tableSeatPosition = window.NO_THANKS_TABLE_LAYOUT?.tableSeatPosition || (() => ({ x: 50, y: 15 }));
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const avatarHue = (name) => [...String(name)].reduce((total, character) => total + character.codePointAt(0), 0) % 360;
const avatarHtml = (player, className = '') => `<span class="player-avatar ${className}" style="--avatar-hue:${avatarHue(player.name)}" aria-hidden="true">${escapeHtml([...player.name][0] || '?')}</span>`;
function formatCardRuns(cards) {
  const sorted = [...new Set(cards)].sort((a, b) => a - b);
  const runs = [];
  for (let index = 0; index < sorted.length; ) {
    const start = sorted[index];
    let end = start;
    while (sorted[index + 1] === end + 1) end = sorted[++index];
    runs.push(start === end ? String(start) : `${start}-${end}`);
    index += 1;
  }
  return runs;
}

function currentScore(cards, markers) {
  const ordered = [...cards].sort((a, b) => a - b);
  let cardPoints = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    if (index === 0 || ordered[index] !== ordered[index - 1] + 1) {
      cardPoints += ordered[index];
    }
  }
  return cardPoints - markers;
}

function scoreRuns(cards) {
  const sorted = [...cards].sort((a, b) => a - b);
  const runs = [];
  for (let index = 0; index < sorted.length; ) {
    const run = [sorted[index]];
    while (sorted[index + 1] === run[run.length - 1] + 1) run.push(sorted[++index]);
    runs.push({ lowest: run[0], cards: run });
    index += 1;
  }
  return runs;
}

function formatScoreBreakdown(player) {
  const score = player.score || { cardPoints: 0, markers: player.markers || 0, total: 0 };
  const runs = Array.isArray(score.runs) ? score.runs : scoreRuns(player.cards || []);
  if (!runs.length) return '没有收牌';
  return runs.map((run) => (
    run.cards.length === 1 ? String(run.cards[0]) : `${run.cards[0]}–${run.cards[run.cards.length - 1]}`
  )).join('、');
}

function assertReplayRecord(record) {
  if (!record || record.schemaVersion !== 1 || !Array.isArray(record.players) || !record.initialState || !Array.isArray(record.initialState.deck) || !Array.isArray(record.initialState.players) || !Array.isArray(record.turns) || !record.result || !Array.isArray(record.result.players)) {
    throw new Error('不是可识别的不谢牌对局记录（需要 schemaVersion: 1）。');
  }
  const knownPlayers = new Set(record.players.map((player) => player.id));
  if (!knownPlayers.size || record.initialState.players.some((player) => !knownPlayers.has(player.id))) {
    throw new Error('对局记录中的玩家信息不完整。');
  }
  if (record.turns.some((turn) => !knownPlayers.has(turn.playerId) || !['take', 'pass'].includes(turn.action) || !turn.event)) {
    throw new Error('对局记录包含无法回放的行动。');
  }
  return record;
}

function resultPlayersForRecord(record) {
  const playersById = new Map(record.players.map((player) => [player.id, player]));
  return record.result.players.map((player) => ({
    ...player,
    name: playersById.get(player.playerId)?.name || player.playerId,
    id: player.playerId,
  })).sort((left, right) => left.score.total - right.score.total);
}

function renderResultTable(results, selfId = null) {
  $('resultTable').innerHTML = `<div class="result-head"><span>玩家</span><span>收牌</span><span>牌分</span><span>剩余标记</span><span>总分</span></div>${results.map((player) => `<div class="result-item"><span>${escapeHtml(player.name)}${player.id === selfId ? ' · 你' : ''}</span><span class="score-breakdown">${formatScoreBreakdown(player)}</span><span>${player.score.cardPoints}</span><span>${player.score.markers}</span><strong>${player.score.total}</strong></div>`).join('')}`;
}

function show(viewId) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === viewId));
}

function openRulesDialog() {
  const source = document.querySelector('#rulesView .rules-grid');
  $('rulesDialogContent').replaceChildren(...[...source.children].map((section) => section.cloneNode(true)));
  $('rulesDialog').showModal();
}

function closeRulesDialogWhenClickingBackdrop(event) {
  const dialog = event.currentTarget;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    dialog.close();
  }
}

function setQuickChatPickerOpen(open) {
  $('quickChatPicker').hidden = !open;
  $('quickChatToggle').setAttribute('aria-expanded', String(open));
}

function renderQuickChatPicker() {
  $('quickChatPicker').innerHTML = QUICK_CHAT_PHRASES.map((phrase) => (
    `<button class="quick-chat-choice" type="button" data-phrase-id="${escapeHtml(phrase.id)}">${escapeHtml(phrase.text)}</button>`
  )).join('');
}

function renderQuickChatFeed(state) {
  const playersById = new Map(state.players.map((player) => [player.id, player]));
  const messages = (state.quickChat || [])
    .slice(-3)
    .map((message) => ({ player: playersById.get(message.playerId), text: quickChatPhraseById.get(message.phraseId) }))
    .filter((message) => message.player && message.text);
  const target = $('quickChatFeed');
  target.hidden = messages.length === 0;
  target.innerHTML = messages.map(({ player, text }) => (
    `<span class="quick-chat-message"><strong>${escapeHtml(player.name)}</strong>：${escapeHtml(text)}</span>`
  )).join('');
}

function receiveQuickChat(message) {
  if (!app.state || app.state.room.phase !== 'playing' || !quickChatPhraseById.has(message?.phraseId)) return;
  // 发送者已经乐观显示并会用 HTTP 响应校正，避免同一条消息短暂重复。
  if (message.playerId === app.state.self.id) return;
  if ((app.state.quickChat || []).some((entry) => entry.id === message.id)) return;
  rememberQuickChatArrival(message);
  app.state = { ...app.state, quickChat: [...(app.state.quickChat || []), message].slice(-12) };
  renderGame(app.state);
}

function rememberQuickChatArrival(message, arrivalTime = Date.now()) {
  if (!message?.id) return;
  app.quickChatArrivalTimes.set(message.id, arrivalTime);
  while (app.quickChatArrivalTimes.size > MAX_QUICK_CHAT_ARRIVAL_TIMES) {
    app.quickChatArrivalTimes.delete(app.quickChatArrivalTimes.keys().next().value);
  }
}

function quickChatBubbleStart(message) {
  if (message.id && app.quickChatArrivalTimes.has(message.id)) return app.quickChatArrivalTimes.get(message.id);
  if (Number.isFinite(message.shownAt)) return message.shownAt;
  return Date.parse(message.at);
}

function activeQuickChatByPlayer(state) {
  const now = Date.now();
  const messages = (state.quickChat || []).filter((message) => {
    const age = now - quickChatBubbleStart(message);
    return Number.isFinite(age) && age >= 0 && age < QUICK_CHAT_BUBBLE_MS && quickChatPhraseById.has(message.phraseId);
  });
  const latestByPlayer = new Map();
  messages.forEach((message) => latestByPlayer.set(message.playerId, message));
  clearTimeout(app.quickChatBubbleTimer);
  app.quickChatBubbleTimer = null;
  if (messages.length) {
    const earliestExpiry = Math.min(...messages.map((message) => quickChatBubbleStart(message) + QUICK_CHAT_BUBBLE_MS - now));
    app.quickChatBubbleTimer = setTimeout(() => {
      app.quickChatBubbleTimer = null;
      if (app.state?.room.phase === 'playing') renderGame(app.state);
    }, Math.max(0, earliestExpiry) + 20);
  }
  return latestByPlayer;
}

function quickChatBubbleHtml(message, className = '') {
  if (!message) return '';
  const text = quickChatPhraseById.get(message.phraseId);
  return text ? `<span class="quick-chat-bubble ${className}">${escapeHtml(text)}</span>` : '';
}

function rememberSession(room, token) {
  app.session = { roomId: room.room.id, token, playerId: room.self.id };
  sessionStorage.setItem('noThanksSession', JSON.stringify(app.session));
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function setMessage(id, message) { $(id).textContent = message || ''; }

function savedPlayerName() {
  const name = $('playerName').value.trim();
  if (name) sessionStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
  return name;
}

function clearSession() {
  if (app.events) app.events.close();
  if (app.heartbeat) clearInterval(app.heartbeat);
  stopReplayAutoplay();
  app.events = null;
  app.heartbeat = null;
  app.session = null;
  app.state = null;
  app.quickChatArrivalTimes.clear();
  app.replay = null;
  app.replayStep = -1;
  app.replaySpeed = 1;
  app.replaySource = null;
  sessionStorage.removeItem('noThanksSession');
}

async function touchSession() {
  if (!app.session) return;
  await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/heartbeat`, { method: 'POST', body: JSON.stringify({ token: app.session.token }) });
}

async function refreshRooms() {
  try {
    const payload = await api('/api/rooms');
    const list = $('roomList');
    if (!payload.rooms.length) { list.innerHTML = '<p class="muted">暂时没有可加入的房间。</p>'; return; }
    list.innerHTML = payload.rooms.map((room) => `<div class="room-row"><div><strong>${escapeHtml(room.name)}</strong><small>${room.id} · ${room.players}/${room.maxPlayers} 人 · ${room.phase === 'lobby' ? '等待中' : '进行中'}</small></div><button class="secondary join-room" data-room="${room.id}">加入</button></div>`).join('');
    list.querySelectorAll('.join-room').forEach((button) => button.addEventListener('click', () => joinRoom(button.dataset.room)));
  } catch (error) { setMessage('homeMessage', error.message); }
}

async function createRoom() {
  const playerName = savedPlayerName();
  if (!playerName) return setMessage('homeMessage', '请先填写昵称');
  const name = $('createRoomName').value.trim() || `${playerName}的房间`;
  try {
    const payload = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ playerName, name }) });
    rememberSession(payload.room, payload.token);
    connectRoom();
  } catch (error) { setMessage('homeMessage', error.message); }
}

async function joinRoom(roomId) {
  const playerName = savedPlayerName();
  if (!playerName) return setMessage('homeMessage', '请先填写昵称');
  try {
    const payload = await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body: JSON.stringify({ playerName }) });
    rememberSession(payload.room, payload.token);
    connectRoom();
  } catch (error) { setMessage('homeMessage', error.message); }
}

async function loadState() {
  if (!app.session) return null;
  const state = await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/state?token=${encodeURIComponent(app.session.token)}`);
  app.state = state;
  renderState();
  return state;
}

function connectRoom() {
  if (!app.session) return;
  if (app.events) app.events.close();
  if (app.heartbeat) clearInterval(app.heartbeat);
  app.events = new EventSource(`/api/rooms/${encodeURIComponent(app.session.roomId)}/events?token=${encodeURIComponent(app.session.token)}`);
  app.events.addEventListener('state', (event) => { app.state = JSON.parse(event.data); renderState(); });
  app.events.addEventListener('quick-chat', (event) => receiveQuickChat(JSON.parse(event.data)));
  app.events.addEventListener('removed', (event) => {
    const payload = JSON.parse(event.data || '{}');
    clearSession();
    show('homeView');
    setMessage('homeMessage', payload.message || '你已被移出房间。');
    refreshRooms();
  });
  app.events.onerror = () => setMessage('roomMessage', '与房间的连接暂时中断，正在重连…');
  app.heartbeat = setInterval(() => {
    touchSession().catch((error) => {
      clearSession();
      show('homeView');
      setMessage('homeMessage', `当前窗口会话已失效：${error.message}`);
    });
  }, 10000);
  touchSession().catch(() => {});
  loadState().catch((error) => { clearSession(); show('homeView'); setMessage('homeMessage', error.message); });
}

function renderState() {
  const state = app.state;
  if (!state) return;
  if (state.room.phase === 'lobby') renderRoom(state);
  else if (state.room.phase === 'playing') renderGame(state);
  else renderResult(state);
}

function playerRoleLabel(player) {
  if (player.isBot) return '人机';
  return player.isHost ? '房主' : '玩家';
}

function renderRoom(state) {
  show('roomView');
  $('roomTitle').textContent = state.room.name;
  $('roomCount').textContent = `${state.players.length}/${state.room.maxPlayers}`;
  const self = state.players.find((player) => player.id === state.self.id);
  const isHost = state.self.id === state.room.hostPlayerId;
  const allReady = state.players.length >= 3 && state.players.every((player) => player.ready);
  $('playerList').innerHTML = state.players.map((player) => `<div class="player-row"><span>${escapeHtml(player.name)}</span><span class="player-row-meta"><span class="player-badge ${player.ready ? 'ready' : 'not-ready'}">${playerRoleLabel(player)}${player.id === state.self.id ? ' · 你' : ''} · ${player.ready ? '已准备' : '未准备'}</span>${isHost && player.id !== state.self.id ? `<button class="remove-player-button" data-player-id="${escapeHtml(player.id)}">移除</button>` : ''}</span></div>`).join('');
  $('readyButton').disabled = !self || self.isBot;
  $('readyButton').textContent = self?.ready ? '取消准备' : '准备';
  $('addBotButton').disabled = !isHost || state.players.length >= state.room.maxPlayers;
  $('botLevelSelect').disabled = !isHost || state.players.length >= state.room.maxPlayers;
  $('addBotButton').textContent = state.players.length >= state.room.maxPlayers ? '房间已满' : '加入人机';
  $('startGameButton').disabled = !isHost || !allReady;
  $('startGameButton').textContent = state.players.length < 3 ? `还需 ${3 - state.players.length} 人` : allReady ? '开始游戏' : '等待准备';
  setMessage('roomMessage', state.players.length < 3 ? '等待至少 3 名玩家。' : !allReady ? '等待所有玩家准备。人机已自动准备。' : state.self.id === state.room.hostPlayerId ? '全部准备完成，可以开始游戏。' : '等待房主开始游戏。');
}

function renderGame(state) {
  stopReplayAutoplay();
  app.replay = null;
  app.replayStep = -1;
  app.replaySource = null;
  show('gameView');
  $('gameRoomTitle').textContent = state.room.name;
  $('deckStatus').textContent = `第 ${state.drawCount + 1}/${state.deckSize} 张 · 剩余 ${state.deckRemaining} 张`;
  const current = state.players.find((player) => player.id === state.currentPlayerId);
  const mine = state.self.id === state.currentPlayerId;
  const self = state.players.find((player) => player.id === state.self.id);
  const noMarkers = mine && self?.markers === 0;
  $('turnLabel').textContent = current ? `${current.name}${mine ? ' · 轮到你' : ' · 等待行动'}` : '';
  $('currentCard').textContent = state.currentCard ?? '—';
  $('potCount').textContent = state.pot;
  $('passButton').disabled = !mine || noMarkers;
  $('takeButton').disabled = !mine;
  renderQuickChatFeed(state);
  const quickChatByPlayer = activeQuickChatByPlayer(state);
  const seatPlayers = state.players.filter((player) => player.id !== state.self.id);
  $('tableSeats').innerHTML = seatPlayers.map((player, index) => {
    const position = tableSeatPosition(index, seatPlayers.length);
    const isCurrent = player.id === state.currentPlayerId;
    const bubbleSide = position.x > 50 ? 'bubble-left' : 'bubble-right';
    const resources = `<span class="seat-resources">${player.cards.length} 张牌</span>`;
    const cards = player.cards.length ? formatCardRuns(player.cards).map((run) => `<span class="seat-card">${run}</span>`).join('') : '<span class="seat-cards-empty">未收牌</span>';
    return `<div class="table-seat ${isCurrent ? 'current' : ''}" style="--seat-x:${position.x}%;--seat-y:${position.y}%">${avatarHtml(player)}${quickChatBubbleHtml(quickChatByPlayer.get(player.id), bubbleSide)}<span class="seat-name">${escapeHtml(player.name)}</span>${resources}<div class="seat-cards">${cards}</div></div>`;
  }).join('');
  const selfCards = self.cards.length ? formatCardRuns(self.cards).map((run) => `<span class="seat-card">${run}</span>`).join('') : '<span class="self-cards-empty">尚未收牌</span>';
  const selfScore = currentScore(self.cards, self.markers);
  $('selfPanel').innerHTML = `<div class="self-avatar-wrap">${avatarHtml(self)}${quickChatBubbleHtml(quickChatByPlayer.get(self.id), 'self-chat-bubble')}</div><div class="self-info"><span class="self-name">${escapeHtml(self.name)} <small>你</small></span><div class="self-summary"><span class="self-score">当前分数 <strong>${selfScore}</strong></span><span class="self-markers"><span class="token-icon">●</span>${self.markers} 个标记</span></div><div class="self-cards">${selfCards}</div></div>`;
  renderTableEvent(state.lastEvent, state.players);
  setMessage('gameMessage', mine ? noMarkers ? '你已经没有标记，只能收下这张牌。' : '现在由你决定：拿牌，或放置一个标记。' : '等待当前玩家行动。');
}

function renderTableEvent(event, players) {
  const target = $('tableEvent');
  if (!event || !['pass', 'take'].includes(event.kind)) { target.innerHTML = ''; return; }
  const player = players.find((entry) => entry.id === event.playerId);
  if (!player) { target.innerHTML = ''; return; }
  const isPass = event.kind === 'pass';
  const description = isPass ? `${player.name} 放置了 1 个标记并拒收 ${event.card}` : `${player.name} 收下 ${event.card} 并拿走 ${event.markers} 个标记`;
  target.title = description;
  target.setAttribute('aria-label', description);
  target.innerHTML = `${avatarHtml(player, 'event-avatar')}<span class="event-symbol">${isPass ? '↗' : '↙'}</span><span class="event-card">${event.card}</span>${event.markers ? `<span class="event-token">●${event.markers}</span>` : ''}`;
}

function renderResult(state) {
  clearTimeout(app.quickChatBubbleTimer);
  app.quickChatBubbleTimer = null;
  setQuickChatPickerOpen(false);
  show('resultView');
  const results = state.players.map((player) => ({ ...player, score: player.score || { cardPoints: 0, markers: player.markers, total: 0 } })).sort((a, b) => a.score.total - b.score.total);
  $('resultEyebrow').textContent = 'FINAL SCORES';
  $('resultTitle').textContent = '本局结果';
  $('resultHomeButton').textContent = '回到原房间';
  $('showReplayButton').textContent = '回放对局';
  $('winnerLabel').textContent = `${results[0].name} 获胜，最终得分 ${results[0].score.total}。`;
  renderResultTable(results, state.self.id);
  $('replayPanel').hidden = !app.replay;
  if (app.replay) renderReplay();
}

function cloneReplayState(initialState) {
  return {
    ...initialState,
    deck: [...initialState.deck],
    players: initialState.players.map((player) => ({ ...player, cards: [...player.cards] })),
  };
}

function replayStateAt(record, lastTurnIndex) {
  const state = cloneReplayState(record.initialState);
  for (let index = 0; index <= lastTurnIndex; index += 1) {
    const turn = record.turns[index];
    if (!turn) break;
    const actor = state.players.find((player) => player.id === turn.playerId);
    if (!actor) continue;
    if (turn.action === 'pass') {
      actor.markers -= turn.event.markers;
      state.pot += turn.event.markers;
      const actorIndex = state.players.findIndex((player) => player.id === actor.id);
      state.currentPlayerId = state.players[(actorIndex + 1) % state.players.length].id;
      continue;
    }
    actor.cards.push(turn.event.card);
    actor.markers += turn.event.markers;
    state.pot = 0;
    state.drawIndex += 1;
    if (state.drawIndex >= state.deck.length) {
      state.phase = 'finished';
      state.currentCard = null;
      state.currentPlayerId = null;
    } else {
      state.currentCard = state.deck[state.drawIndex];
      state.currentPlayerId = actor.id;
    }
  }
  return state;
}

function replayPlayerName(record, playerId) {
  return record.players.find((player) => player.id === playerId)?.name || playerId;
}

function replayActionCardNumber(record, turn) {
  if (Number.isInteger(turn.observation?.cardIndex)) return turn.observation.cardIndex + 1;
  if (Number.isInteger(turn.observation?.drawIndex)) return turn.observation.drawIndex + 1;
  return record.initialState.deck.indexOf(turn.event.card) + 1;
}

function nextTakeStepIndex(record, afterStep) {
  return record.turns.findIndex((turn, index) => index > afterStep && turn.action === 'take');
}

function renderReplayDeck(record, state) {
  const deckSize = record.initialState.deck.length;
  const currentIndex = state.phase === 'finished' ? -1 : state.drawIndex;
  $('replayDeckStatus').textContent = currentIndex < 0 ? `已用尽，共 ${deckSize} 张` : `当前第 ${currentIndex + 1}/${deckSize} 张`;
  $('replayDeck').innerHTML = record.initialState.deck.map((card, index) => {
    const status = index === currentIndex ? 'current' : index < state.drawIndex ? 'past' : '';
    return `<span class="replay-deck-card ${status}" title="第 ${index + 1} 张">${card}</span>`;
  }).join('');
}

function renderReplay() {
  const { record } = app.replay;
  const state = replayStateAt(record, app.replayStep);
  const turn = app.replayStep >= 0 ? record.turns[app.replayStep] : null;
  const deckSize = record.initialState.deck.length;
  $('replayStepLabel').textContent = app.replayStep < 0 ? `开局 / ${record.turns.length} 手` : `第 ${app.replayStep + 1} / ${record.turns.length} 手`;
  $('replayPreviousButton').disabled = app.replayStep < 0;
  $('replayNextButton').disabled = app.replayStep >= record.turns.length - 1;
  $('replayJumpTakeButton').disabled = nextTakeStepIndex(record, app.replayStep) < 0;
  $('replayPlayButton').textContent = app.replayTimer ? '暂停播放' : app.replayStep >= record.turns.length - 1 ? '重新播放' : '自动播放';
  if (!turn) {
    $('replayEvent').textContent = `当前第 1/${deckSize} 张牌 ${state.currentCard}，牌旁 ${state.pot} 个标记，${replayPlayerName(record, state.currentPlayerId)} 先行动。`;
  } else if (turn.action === 'pass') {
    $('replayEvent').textContent = `当前第 ${replayActionCardNumber(record, turn)}/${deckSize} 张牌 ${turn.event.card}，牌旁 ${state.pot} 个标记，${replayPlayerName(record, turn.playerId)} 拒收，牌旁标记 +${turn.event.markers}。`;
  } else {
    const nextCard = record.initialState.deck[replayActionCardNumber(record, turn)];
    const nextCardText = nextCard === undefined ? '牌山已用尽。' : `翻开下一张牌为：${nextCard}。`;
    $('replayEvent').textContent = `当前第 ${replayActionCardNumber(record, turn)}/${deckSize} 张牌 ${turn.event.card}，牌旁 ${turn.observation?.pot ?? turn.event.markers} 个标记，${replayPlayerName(record, turn.playerId)} 收下，${nextCardText}`;
  }
  $('replayBoard').innerHTML = state.players.map((player) => {
    const name = replayPlayerName(record, player.id);
    const cards = player.cards.length ? formatCardRuns(player.cards).join('、') : '尚未收牌';
    return `<article class="replay-player ${player.id === state.currentPlayerId ? 'current' : ''}"><strong>${escapeHtml(name)}</strong><span>标记 ${player.markers} · 当前分 ${currentScore(player.cards, player.markers)}</span><span>牌：${cards}</span></article>`;
  }).join('');
  renderReplayDeck(record, state);
}

function stopReplayAutoplay() {
  if (app.replayTimer) clearInterval(app.replayTimer);
  app.replayTimer = null;
}

function advanceReplayStep() {
  if (!app.replay || app.replayStep >= app.replay.record.turns.length - 1) {
    stopReplayAutoplay();
    if (app.replay) renderReplay();
    return;
  }
  app.replayStep += 1;
  renderReplay();
  if (app.replayStep >= app.replay.record.turns.length - 1) {
    stopReplayAutoplay();
    renderReplay();
  }
}

function startReplayAutoplay() {
  if (!app.replay) return;
  if (app.replayStep >= app.replay.record.turns.length - 1) app.replayStep = -1;
  advanceReplayStep();
  if (app.replayStep >= app.replay.record.turns.length - 1) return;
  app.replayTimer = setInterval(advanceReplayStep, Math.round(900 / app.replaySpeed));
  renderReplay();
}

function toggleReplayAutoplay() {
  if (app.replayTimer) {
    stopReplayAutoplay();
    renderReplay();
  } else {
    startReplayAutoplay();
  }
}

async function loadGameRecord() {
  if (app.replay?.source === 'import') return app.replay.record;
  if (app.replay?.roomId === app.session?.roomId) return app.replay.record;
  stopReplayAutoplay();
  const record = await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/record?token=${encodeURIComponent(app.session.token)}`);
  app.replay = { roomId: app.session.roomId, record, source: 'live' };
  app.replaySource = 'live';
  app.replayStep = -1;
  $('replayDeckPanel').hidden = true;
  $('replayDeckButton').textContent = '查看牌山';
  return record;
}

async function showReplay() {
  try {
    await loadGameRecord();
    $('replayPanel').hidden = false;
    renderReplay();
  } catch (error) {
    setMessage('winnerLabel', error.message);
  }
}

function openImportedReplay(record, filename) {
  assertReplayRecord(record);
  stopReplayAutoplay();
  app.replay = { roomId: null, record, source: 'import' };
  app.replaySource = 'import';
  app.replayStep = -1;
  $('resultEyebrow').textContent = 'IMPORTED RECORD';
  $('resultTitle').textContent = '对局回放';
  $('winnerLabel').textContent = `${filename || '已导入记录'} · ${record.room?.name || '不谢牌对局'} · ${record.turns.length} 手。`;
  renderResultTable(resultPlayersForRecord(record));
  $('resultHomeButton').textContent = '返回大厅';
  $('showReplayButton').textContent = '从开局回放';
  $('replayPanel').hidden = false;
  $('replayDeckPanel').hidden = true;
  $('replayDeckButton').textContent = '查看牌山';
  show('resultView');
  renderReplay();
}

async function importReplayFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    openImportedReplay(JSON.parse(await file.text()), file.name);
  } catch (error) {
    setMessage('homeMessage', `无法导入回放：${error.message}`);
  } finally {
    event.target.value = '';
  }
}

async function exportGameRecord() {
  try {
    const record = await loadGameRecord();
    const blob = new Blob([`${JSON.stringify(record, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `no-thanks-${record.room.id}-${record.startedAt.slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    setMessage('winnerLabel', error.message);
  }
}

async function sendAction(action) {
  try { await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/action`, { method: 'POST', body: JSON.stringify({ token: app.session.token, action }) }); }
  catch (error) { setMessage('gameMessage', error.message); }
}

async function sendQuickChat(phraseId) {
  const previousState = app.state;
  const shownAt = Date.now();
  const optimisticMessage = previousState?.room.phase === 'playing' ? {
    playerId: previousState.self.id,
    phraseId,
    at: new Date(shownAt).toISOString(),
    shownAt,
  } : null;
  setQuickChatPickerOpen(false);
  if (optimisticMessage) {
    app.state = {
      ...previousState,
      quickChat: [...(previousState.quickChat || []), optimisticMessage].slice(-12),
    };
    renderGame(app.state);
  }
  try {
    const state = await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/quick-chat`, { method: 'POST', body: JSON.stringify({ token: app.session.token, phraseId }) });
    if (state?.room) {
      const confirmedMessage = [...(state.quickChat || [])].reverse().find((message) => message.playerId === previousState.self.id && message.phraseId === phraseId);
      rememberQuickChatArrival(confirmedMessage, shownAt);
      app.state = state;
      renderState();
    }
  } catch (error) {
    app.state = previousState;
    if (app.state) renderState();
    setMessage('gameMessage', error.message);
  }
}

renderQuickChatPicker();
$('createRoomButton').addEventListener('click', createRoom);
$('refreshRoomsButton').addEventListener('click', refreshRooms);
$('importReplayInput').addEventListener('change', importReplayFile);
$('rulesButton').addEventListener('click', () => show('rulesView'));
$('rulesHomeButton').addEventListener('click', () => { show('homeView'); refreshRooms(); });
$('roomRulesButton').addEventListener('click', openRulesDialog);
$('rulesDialog').addEventListener('click', closeRulesDialogWhenClickingBackdrop);
$('quickChatToggle').addEventListener('click', () => setQuickChatPickerOpen($('quickChatPicker').hidden));
$('quickChatPicker').addEventListener('click', (event) => {
  const button = event.target.closest('.quick-chat-choice');
  if (button) sendQuickChat(button.dataset.phraseId);
});
$('addBotButton').addEventListener('click', async () => {
  try { await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/bot`, { method: 'POST', body: JSON.stringify({ token: app.session.token, level: $('botLevelSelect').value }) }); }
  catch (error) { setMessage('roomMessage', error.message); }
});
$('playerList').addEventListener('click', async (event) => {
  const button = event.target.closest('.remove-player-button');
  if (!button) return;
  try { await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/remove-player`, { method: 'POST', body: JSON.stringify({ token: app.session.token, targetId: button.dataset.playerId }) }); }
  catch (error) { setMessage('roomMessage', error.message); }
});
$('readyButton').addEventListener('click', async () => {
  try { await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/ready`, { method: 'POST', body: JSON.stringify({ token: app.session.token }) }); }
  catch (error) { setMessage('roomMessage', error.message); }
});
$('startGameButton').addEventListener('click', async () => {
  try { await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/start`, { method: 'POST', body: JSON.stringify({ token: app.session.token }) }); }
  catch (error) { setMessage('roomMessage', error.message); }
});
$('passButton').addEventListener('click', () => sendAction('pass'));
$('takeButton').addEventListener('click', () => sendAction('take'));
$('showReplayButton').addEventListener('click', showReplay);
$('exportRecordButton').addEventListener('click', exportGameRecord);
$('replayPreviousButton').addEventListener('click', () => {
  stopReplayAutoplay();
  app.replayStep = Math.max(-1, app.replayStep - 1);
  renderReplay();
});
$('replayNextButton').addEventListener('click', () => {
  stopReplayAutoplay();
  advanceReplayStep();
});
$('replayJumpTakeButton').addEventListener('click', () => {
  stopReplayAutoplay();
  const nextTake = nextTakeStepIndex(app.replay.record, app.replayStep);
  if (nextTake >= 0) {
    app.replayStep = nextTake;
    renderReplay();
  }
});
$('replayPlayButton').addEventListener('click', toggleReplayAutoplay);
$('replaySpeedSelect').addEventListener('change', (event) => {
  app.replaySpeed = Number(event.target.value);
  if (app.replayTimer) {
    stopReplayAutoplay();
    startReplayAutoplay();
  }
});
$('replayDeckButton').addEventListener('click', () => {
  const deckPanel = $('replayDeckPanel');
  deckPanel.hidden = !deckPanel.hidden;
  $('replayDeckButton').textContent = deckPanel.hidden ? '查看牌山' : '收起牌山';
});
async function leaveRoom() {
  if (app.session && app.state?.room.phase === 'lobby') {
    await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/leave`, { method: 'POST', body: JSON.stringify({ token: app.session.token }) }).catch(() => {});
  }
  clearSession();
  show('homeView');
  refreshRooms();
}
$('backHomeButton').addEventListener('click', leaveRoom);
$('resultHomeButton').addEventListener('click', async () => {
  if (app.replay?.source === 'import') {
    stopReplayAutoplay();
    app.replay = null;
    app.replaySource = null;
    app.replayStep = -1;
    show('homeView');
    refreshRooms();
    return;
  }
  try { await api(`/api/rooms/${encodeURIComponent(app.session.roomId)}/return`, { method: 'POST', body: JSON.stringify({ token: app.session.token }) }); }
  catch (error) { setMessage('winnerLabel', error.message); }
});
$('playerName').value = sessionStorage.getItem(PLAYER_NAME_STORAGE_KEY) || '';
$('playerName').addEventListener('input', () => {
  const name = $('playerName').value.trim();
  if (name) sessionStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
  else sessionStorage.removeItem(PLAYER_NAME_STORAGE_KEY);
});
refreshRooms();
if (app.session) connectRoom();
