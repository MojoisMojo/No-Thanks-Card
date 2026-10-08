const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BOT_LEVELS, createBotMemory, decideBotAction, formatBotName, observeBotEvent } = require('./bot-strategies');
const { buildDecisionEnvironment, buildMatchSetup, buildPublicActionEvent } = require('./bot-context');
const { applyAction: applyGameAction, createGame, score } = require('./game-engine');
const { createGameRecord, decisionObservation, finishGameRecord, recordTurn } = require('./game-record');
const { QUICK_CHAT_MESSAGES } = require('./public/assets/quick-chat');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30000);
const SESSION_SWEEP_MS = 5000;
const QUICK_CHAT_COOLDOWN_MS = 1200;
const MAX_QUICK_CHAT_MESSAGES = 12;
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const quickChatMessageIds = new Set(QUICK_CHAT_MESSAGES.map((message) => message.id));

function id(prefix) {
  return `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
}

function addLog(room, text, event = null) {
  const at = new Date().toISOString();
  room.log.push({ at, text });
  if (event) room.lastEvent = { ...event, at };
  if (room.log.length > 40) room.log.shift();
}

function playerForToken(room, token) {
  return room.players.find((player) => player.token === token && (player.isBot || player.sessionState === 'active'));
}

function publicPlayer(player, viewerId, room) {
  const result = {
    id: player.id,
    name: player.name,
    isBot: player.isBot,
    botLevel: player.isBot ? player.botLevel : null,
    ready: player.ready,
    sessionState: player.isBot ? 'bot' : player.sessionState,
    isHost: player.id === room.hostPlayerId,
    cards: [...player.cards].sort((a, b) => a - b),
    markersHidden: player.id !== viewerId,
  };
  if (player.id === viewerId) result.markers = player.markers;
  if (room.phase === 'finished') result.score = score(player.cards, player.markers);
  return result;
}

function stateFor(room, viewerId) {
  const viewer = room.players.find((player) => player.id === viewerId);
  return {
    room: {
      id: room.id,
      name: room.name,
      phase: room.phase,
      maxPlayers: room.maxPlayers,
      hostPlayerId: room.hostPlayerId,
      recordAvailable: Boolean(room.gameRecord?.result),
      createdAt: room.createdAt,
    },
    self: viewer ? { id: viewer.id, name: viewer.name, token: viewer.token } : null,
    players: room.players.map((player) => publicPlayer(player, viewerId, room)),
    currentPlayerId: room.currentPlayerId,
    currentCard: room.phase === 'playing' ? room.currentCard : null,
    pot: room.pot,
    drawCount: room.drawIndex,
    deckSize: room.deck.length,
    deckRemaining: Math.max(0, room.deck.length - room.drawIndex),
    lastEvent: room.lastEvent || null,
    quickChat: room.quickChat.slice(-MAX_QUICK_CHAT_MESSAGES),
    log: room.log.slice(-18),
  };
}

function listRooms() {
  return [...rooms.values()]
    .filter((room) => room.phase === 'lobby' && humanPlayers(room).length > 0)
    .map((room) => ({
      id: room.id,
      name: room.name,
      phase: room.phase,
      players: room.players.length,
      maxPlayers: room.maxPlayers,
      createdAt: room.createdAt,
    }));
}

function emit(room) {
  for (const [token, response] of room.subscribers) {
    const player = playerForToken(room, token);
    if (!player || response.writableEnded) continue;
    response.write(`event: state\ndata: ${JSON.stringify(stateFor(room, player.id))}\n\n`);
  }
}

function emitQuickChat(room, message) {
  const payload = `event: quick-chat\ndata: ${JSON.stringify(message)}\n\n`;
  for (const response of room.subscribers.values()) {
    if (!response.writableEnded) response.write(payload);
  }
}

function fail(response, status, message) {
  sendJson(response, status, { error: message });
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 64) reject(new Error('请求体过大'));
    });
    request.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('请求体必须是 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function roomFrom(parts) {
  return rooms.get(parts[2]);
}

function requirePlayer(room, token, response) {
  if (!room) {
    fail(response, 404, '房间不存在');
    return null;
  }
  const player = room.players.find((entry) => entry.token === token);
  if (!player) {
    fail(response, 401, '房间凭证无效');
    return null;
  }
  if (!player.isBot && (player.sessionState !== 'active' || Date.now() - player.lastSeenAt > SESSION_TTL_MS)) {
    expirePlayerSession(room, player);
    fail(response, 410, '房间会话已失效，请重新加入');
    return null;
  }
  if (!player.isBot) player.lastSeenAt = Date.now();
  return player;
}

function createRoom(name) {
  const room = {
    id: id('room'),
    name: name.trim().slice(0, 40) || '未命名房间',
    phase: 'lobby',
    maxPlayers: 5,
    hostPlayerId: null,
    players: [],
    deck: [],
    drawIndex: 0,
    currentCard: null,
    currentPlayerId: null,
    pot: 0,
    lastEvent: null,
    quickChat: [],
    log: [],
    subscribers: new Map(),
    botTimer: null,
    botMemories: new Map(),
    gameRecord: null,
    createdAt: new Date().toISOString(),
  };
  rooms.set(room.id, room);
  return room;
}

function humanPlayers(room) {
  return room.players.filter((player) => !player.isBot);
}

function activeHumanPlayers(room) {
  return room.players.filter((player) => !player.isBot && player.sessionState === 'active');
}

function deleteRoom(room) {
  if (room.botTimer) clearTimeout(room.botTimer);
  room.botTimer = null;
  for (const response of room.subscribers.values()) {
    if (!response.writableEnded) response.end();
  }
  room.subscribers.clear();
  rooms.delete(room.id);
}

function assignHumanHost(room) {
  room.hostPlayerId = humanPlayers(room)[0]?.id || null;
}

function addPlayer(room, name) {
  const cleanName = String(name || '').trim().slice(0, 24);
  if (!cleanName) throw new Error('昵称不能为空');
  if (room.players.some((player) => player.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('房间内昵称已被使用');
  }
  if (room.players.length >= room.maxPlayers) throw new Error('房间已满');
  if (room.phase !== 'lobby') throw new Error('游戏已经开始');
  const player = { id: id('player'), token: crypto.randomBytes(18).toString('hex'), name: cleanName, markers: 11, cards: [], isBot: false, ready: false, sessionState: 'active', lastSeenAt: Date.now(), lastQuickChatAt: 0 };
  room.players.push(player);
  if (!room.hostPlayerId) {
    room.hostPlayerId = player.id;
    player.ready = true;
  }
  addLog(room, `${player.name} 加入了房间`);
  return player;
}

function addBot(room, botLevel = BOT_LEVELS.BEGINNER) {
  if (room.players.length >= room.maxPlayers) throw new Error('房间已满');
  if (room.phase !== 'lobby') throw new Error('游戏已经开始');
  if (!Object.values(BOT_LEVELS).includes(botLevel)) throw new Error('人机等级无效');
  let number = 1;
  let name = formatBotName(botLevel, number);
  while (room.players.some((player) => player.name === name)) {
    number += 1;
    name = formatBotName(botLevel, number);
  }
  const player = { id: id('bot'), token: crypto.randomBytes(18).toString('hex'), name, markers: 11, cards: [], isBot: true, botLevel, ready: true, sessionState: 'bot', lastSeenAt: null };
  room.players.push(player);
  addLog(room, `${player.name} 加入了房间`);
  return player;
}

function gameStateFromRoom(room) {
  return {
    phase: room.phase,
    deck: room.deck,
    drawIndex: room.drawIndex,
    currentCard: room.currentCard,
    currentPlayerId: room.currentPlayerId,
    pot: room.pot,
    players: room.players.map((player) => ({ id: player.id, markers: player.markers, cards: player.cards })),
  };
}

function applyGameState(room, game) {
  room.phase = game.phase;
  room.deck = game.deck;
  room.drawIndex = game.drawIndex;
  room.currentCard = game.currentCard;
  room.currentPlayerId = game.currentPlayerId;
  room.pot = game.pot;
  const gamePlayers = new Map(game.players.map((player) => [player.id, player]));
  for (const player of room.players) {
    const gamePlayer = gamePlayers.get(player.id);
    if (!gamePlayer) continue;
    player.markers = gamePlayer.markers;
    player.cards = gamePlayer.cards;
  }
}

function startGame(room) {
  if (room.players.length < 3 || room.players.length > 5) throw new Error('需要 3-5 名玩家才能开始');
  if (room.players.some((player) => !player.ready)) throw new Error('需要所有玩家准备后才能开始');
  const initialState = createGame(room.players.map((player) => player.id), { randomInt: crypto.randomInt });
  applyGameState(room, initialState);
  room.botMemories = new Map(room.players
    .filter((player) => player.isBot)
    .map((player) => [player.id, createBotMemory({
      level: player.botLevel,
      matchSetup: buildMatchSetup(initialState, player.id),
    })]));
  room.gameRecord = createGameRecord(room, initialState);
  room.quickChat = [];
  addLog(room, `游戏开始，共 ${room.deck.length} 张牌，起始玩家是 ${room.players.find((p) => p.id === room.currentPlayerId).name}`, { kind: 'start' });
}

function returnToLobby(room) {
  if (room.botTimer) clearTimeout(room.botTimer);
  room.botTimer = null;
  room.players = room.players.filter((player) => player.isBot || player.sessionState === 'active');
  if (!room.players.some((player) => player.id === room.hostPlayerId && !player.isBot)) {
    assignHumanHost(room);
  }
  room.phase = 'lobby';
  room.deck = [];
  room.drawIndex = 0;
  room.currentCard = null;
  room.currentPlayerId = null;
  room.pot = 0;
  room.lastEvent = null;
  room.quickChat = [];
  room.botMemories.clear();
  for (const player of room.players) {
    player.markers = 11;
    player.cards = [];
    player.ready = player.isBot;
  }
  addLog(room, '本局结束，已回到房间');
}

function playAction(room, player, action) {
  const beforeAction = gameStateFromRoom(room);
  const actionIndex = room.gameRecord?.turns.length || 0;
  const observation = decisionObservation(beforeAction, player.id, actionIndex);
  const { state, event } = applyGameAction(beforeAction, player.id, action);
  const publicEvent = buildPublicActionEvent(beforeAction, { actionIndex, playerId: player.id, action, event });
  applyGameState(room, state);
  recordTurn(room.gameRecord, { playerId: player.id, action, observation, event: { ...event, ...publicEvent } });
  for (const bot of room.players.filter((entry) => entry.isBot)) {
    room.botMemories.set(bot.id, observeBotEvent({
      level: bot.botLevel,
      memory: room.botMemories.get(bot.id),
      event: publicEvent,
    }));
  }
  if (event.kind === 'pass') {
    addLog(room, `${player.name} 拒收了 ${event.card}，放置 1 个标记`, event);
    return;
  }
  addLog(room, `${player.name} 收下了 ${event.card}，拿走 ${event.markers} 个标记`, event);
  if (event.finished) {
    finishGameRecord(room.gameRecord, state);
    addLog(room, '牌库用尽，游戏结束', { kind: 'finished' });
  }
}

function chooseBotAction(room, bot) {
  return decideBotAction({
    level: bot.botLevel,
    env: buildDecisionEnvironment(gameStateFromRoom(room), bot.id, room.gameRecord?.turns.length || 0),
    memory: room.botMemories.get(bot.id),
  });
}

function sendQuickChat(room, player, phraseId) {
  if (room.phase !== 'playing') throw new Error('只能在对局中发送快捷语句');
  if (player.isBot) throw new Error('人机不能发送快捷语句');
  if (!quickChatMessageIds.has(phraseId)) throw new Error('快捷语句无效');
  const now = Date.now();
  if (now - player.lastQuickChatAt < QUICK_CHAT_COOLDOWN_MS) throw new Error('说得太快了，请稍后再发');
  player.lastQuickChatAt = now;
  const message = { id: id('chat'), playerId: player.id, phraseId, at: new Date(now).toISOString() };
  room.quickChat.push(message);
  if (room.quickChat.length > MAX_QUICK_CHAT_MESSAGES) room.quickChat.shift();
  return message;
}

function scheduleBot(room) {
  if (room.botTimer || room.phase !== 'playing') return;
  const bot = room.players.find((player) => player.id === room.currentPlayerId);
  if (!bot || !bot.isBot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.phase !== 'playing' || room.currentPlayerId !== bot.id) return;
    playAction(room, bot, chooseBotAction(room, bot));
    emit(room);
    scheduleBot(room);
  }, 650);
}

function removePlayer(room, player, reason, removalMessage = null) {
  const subscriber = room.subscribers.get(player.token);
  if (subscriber && removalMessage && !subscriber.writableEnded) {
    subscriber.write(`event: removed\ndata: ${JSON.stringify({ message: removalMessage })}\n\n`);
  }
  room.players = room.players.filter((entry) => entry.id !== player.id);
  if (subscriber && !subscriber.writableEnded) subscriber.end();
  room.subscribers.delete(player.token);
  addLog(room, `${player.name} ${reason}`);
  if (humanPlayers(room).length === 0) {
    deleteRoom(room);
    return false;
  }
  if (room.hostPlayerId === player.id || !room.players.some((entry) => entry.id === room.hostPlayerId && !entry.isBot)) {
    assignHumanHost(room);
  }
  return true;
}

function expirePlayerSession(room, player) {
  if (player.isBot || player.sessionState !== 'active') return;
  player.sessionState = 'expired';
  if (activeHumanPlayers(room).length === 0) {
    deleteRoom(room);
    return;
  }
  if (room.phase === 'lobby') {
    if (removePlayer(room, player, '的会话已过期')) emit(room);
    return;
  }
  addLog(room, `${player.name} 的会话已过期`);
  if (room.currentPlayerId === player.id) {
    playAction(room, player, 'take');
    addLog(room, `${player.name} 会话失效，本回合自动收牌`);
    emit(room);
    scheduleBot(room);
  }
}

function expireSessions() {
  const now = Date.now();
  for (const room of rooms.values()) {
    const expired = room.players.filter((player) => !player.isBot && player.sessionState === 'active' && now - player.lastSeenAt > SESSION_TTL_MS);
    for (const player of expired) {
      if (!rooms.has(room.id)) break;
      expirePlayerSession(room, player);
    }
    if (rooms.has(room.id) && room.phase === 'lobby' && room.players.length > 0) emit(room);
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[ext] || 'application/octet-stream';
}

function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) return fail(response, 404, '找不到资源');
  fs.readFile(filePath, (error, data) => {
    if (error) return fail(response, 404, '找不到资源');
    response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const parts = requestUrl.pathname.split('/').filter(Boolean);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return response.end();
  }
  try {
    const body = request.method === 'POST' ? await readJson(request) : {};
    if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname.startsWith('/assets/'))) return serveStatic(request, response, requestUrl.pathname);
    if (request.method === 'GET' && requestUrl.pathname === '/api/rooms') return sendJson(response, 200, { rooms: listRooms() });
    if (request.method === 'POST' && requestUrl.pathname === '/api/rooms') {
      const room = createRoom(body.name || '不谢牌局');
      const player = addPlayer(room, body.playerName || '房主');
      emit(room);
      return sendJson(response, 201, { room: stateFor(room, player.id), token: player.token });
    }
    if (!parts[0] || parts[0] !== 'api' || parts[1] !== 'rooms') return serveStatic(request, response, requestUrl.pathname);
    const room = roomFrom(parts);
    const token = requestUrl.searchParams.get('token') || body.token;
    if (request.method === 'GET' && parts.length === 4 && parts[3] === 'state') {
      const player = requirePlayer(room, token, response);
      if (!player) return;
      return sendJson(response, 200, stateFor(room, player.id));
    }
    if (request.method === 'GET' && parts.length === 4 && parts[3] === 'record') {
      const player = requirePlayer(room, token, response);
      if (!player) return;
      if (!room.gameRecord?.result) throw new Error('对局尚未结束，暂不能导出回放记录');
      return sendJson(response, 200, room.gameRecord);
    }
    if (request.method === 'GET' && parts.length === 4 && parts[3] === 'events') {
      const player = requirePlayer(room, token, response);
      if (!player) return;
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      room.subscribers.set(token, response);
      response.write(`event: state\ndata: ${JSON.stringify(stateFor(room, player.id))}\n\n`);
      const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(': heartbeat\n\n'); }, 15000);
      response.on('close', () => { clearInterval(heartbeat); room.subscribers.delete(token); });
      return;
    }
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'heartbeat') {
      const player = requirePlayer(room, token, response);
      if (!player) return;
      return sendJson(response, 200, { alive: true, ttlMs: SESSION_TTL_MS });
    }
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'join') {
      if (!room) return fail(response, 404, '房间不存在');
      const player = addPlayer(room, body.playerName);
      emit(room);
      return sendJson(response, 201, { room: stateFor(room, player.id), token: player.token });
    }
    const player = requirePlayer(room, body.token || token, response);
    if (!player) return;
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'leave') {
      if (room.phase !== 'lobby') throw new Error('游戏开始后不能离开房间');
      if (removePlayer(room, player, '离开了房间')) emit(room);
      return sendJson(response, 200, { left: true });
    }
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'bot') {
      if (player.id !== room.hostPlayerId) throw new Error('只有房主可以加入人机');
      addBot(room, body.level || BOT_LEVELS.BEGINNER);
      emit(room);
      return sendJson(response, 201, stateFor(room, player.id));
    }
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'remove-player') {
      if (room.phase !== 'lobby') throw new Error('只能在等待大厅移除玩家');
      if (player.id !== room.hostPlayerId) throw new Error('只有房主可以移除玩家');
      const target = room.players.find((entry) => entry.id === body.targetId);
      if (!target) throw new Error('指定玩家不存在');
      if (target.id === room.hostPlayerId) throw new Error('房主不能移除自己');
      removePlayer(room, target, '被房主移出了房间', '你已被房主移出房间');
      emit(room);
      return sendJson(response, 200, stateFor(room, player.id));
    }
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'ready') {
      if (room.phase !== 'lobby') throw new Error('只能在房间内准备');
      player.ready = !player.ready;
      addLog(room, `${player.name}${player.ready ? ' 已准备' : ' 取消准备'}`);
      emit(room);
      return sendJson(response, 200, stateFor(room, player.id));
    }
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'start') {
      if (player.id !== room.hostPlayerId) throw new Error('只有房主可以开始');
      startGame(room);
      emit(room);
      scheduleBot(room);
      return sendJson(response, 200, stateFor(room, player.id));
    }
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'return') {
      if (room.phase !== 'finished') throw new Error('当前不在结算中');
      returnToLobby(room);
      emit(room);
      return sendJson(response, 200, stateFor(room, player.id));
    }
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'action') {
      playAction(room, player, body.action);
      emit(room);
      scheduleBot(room);
      return sendJson(response, 200, stateFor(room, player.id));
    }
    if (request.method === 'POST' && parts.length === 4 && parts[3] === 'quick-chat') {
      const message = sendQuickChat(room, player, body.phraseId);
      emitQuickChat(room, message);
      return sendJson(response, 200, stateFor(room, player.id));
    }
    return fail(response, 404, '接口不存在');
  } catch (error) {
    return fail(response, 400, error.message || '请求失败');
  }
});

setInterval(expireSessions, SESSION_SWEEP_MS);

server.listen(PORT, HOST, () => {
  console.log(`No Thanks! LAN server listening on http://127.0.0.1:${PORT}`);
  console.log(`LAN clients can open http://<this-machine-ip>:${PORT}`);
});
