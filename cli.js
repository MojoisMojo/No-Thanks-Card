const readline = require('node:readline');
const fs = require('node:fs/promises');
const path = require('node:path');
const { score } = require('./game-engine');
const { QUICK_CHAT_MESSAGES } = require('./public/assets/quick-chat');

const server = process.env.NO_THANKS_SERVER || `http://127.0.0.1:${process.env.PORT || 8787}`;
const quickChatTextById = new Map(QUICK_CHAT_MESSAGES.map((phrase) => [phrase.id, phrase.text]));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve, reject) => {
  if (rl.closed) return reject(new Error('readline was closed'));
  rl.question(question, resolve);
});
let session = null;
let heartbeatTimer = null;
let eventAbortController = null;
let eventLoop = null;
let latestState = null;
let stateVersion = 0;
const stateWaiters = new Set();

async function api(path, options = {}) {
  const response = await fetch(`${server}${path}`, { headers: { 'content-type': 'application/json' }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function printRooms(rooms) {
  if (!rooms.length) return console.log('\n暂无可加入的房间。');
  console.log('\n可加入的房间：');
  rooms.forEach((room) => console.log(`  ${room.id}  ${room.name}  ${room.players}/${room.maxPlayers} 人  ${room.phase === 'lobby' ? '等待中' : '进行中'}`));
}

function printState(state) {
  console.clear();
  console.log(`不谢牌 · ${state.room.name} · ${state.room.phase === 'lobby' ? '等待大厅' : state.room.phase === 'playing' ? '游戏中' : '已结束'}`);
  console.log(`房间 ${state.room.id} | 牌旁标记 ${state.pot} | 牌进度 ${state.drawCount}/${state.deckSize}`);
  state.players.forEach((player) => {
    const turn = player.id === state.currentPlayerId ? ' <轮到>' : '';
    const own = player.id === state.self.id ? ` | 你的标记 ${player.markers}` : ' | 标记隐藏';
    const score = player.score ? ` | 总分 ${player.score.total}` : '';
    const bot = player.isBot ? ' [人机]' : '';
    console.log(`  ${player.name}${bot}${turn}${own} | 牌: ${player.cards.join(', ') || '-' }${score}`);
  });
  if (state.currentCard) console.log(`\n当前牌: ${state.currentCard}`);
  console.log('\n最近记录：');
  state.log.slice(-6).forEach((entry) => console.log(`  ${entry.text}`));
  const quickChat = (state.quickChat || [])
    .slice(-3)
    .map((message) => ({ player: state.players.find((player) => player.id === message.playerId), text: quickChatTextById.get(message.phraseId) }))
    .filter((message) => message.player && message.text);
  if (quickChat.length) {
    console.log('\n快捷语句：');
    quickChat.forEach(({ player, text }) => console.log(`  ${player.name}：${text}`));
  }
}

function publishState(state) {
  latestState = state;
  stateVersion += 1;
  for (const resolve of stateWaiters) resolve({ state, version: stateVersion });
  stateWaiters.clear();
}

function waitForStateUpdate(lastVersion) {
  if (latestState && stateVersion > lastVersion) return Promise.resolve({ state: latestState, version: stateVersion });
  return new Promise((resolve) => stateWaiters.add(resolve));
}

function stopStateEvents() {
  eventAbortController?.abort();
  eventAbortController = null;
  eventLoop = null;
  latestState = null;
  stateVersion = 0;
  for (const resolve of stateWaiters) resolve(null);
  stateWaiters.clear();
}

async function consumeStateEvents(response, activeSession) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (session === activeSession) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const message = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      let eventName = 'message';
      const data = [];
      for (const line of message.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
        if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
      }
      if (eventName === 'state' && data.length) publishState(JSON.parse(data.join('\n')));
      if (eventName === 'quick-chat' && data.length && latestState) {
        const quickChat = JSON.parse(data.join('\n'));
        if (!(latestState.quickChat || []).some((message) => message.id === quickChat.id)) {
          publishState({ ...latestState, quickChat: [...(latestState.quickChat || []), quickChat].slice(-12) });
        }
      }
    }
  }
}

function startStateEvents() {
  stopStateEvents();
  const activeSession = session;
  const controller = new AbortController();
  eventAbortController = controller;
  eventLoop = (async () => {
    while (session === activeSession && !controller.signal.aborted) {
      try {
        const response = await fetch(`${server}/api/rooms/${encodeURIComponent(activeSession.roomId)}/events?token=${encodeURIComponent(activeSession.token)}`, { signal: controller.signal });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || '事件连接失败');
        }
        await consumeStateEvents(response, activeSession);
      } catch (error) {
        if (controller.signal.aborted || session !== activeSession) return;
        console.log(`\n实时连接暂时中断，正在重连：${error.message}`);
      }
      if (!controller.signal.aborted && session === activeSession) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
}

function keepSessionAlive() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!session) return;
    const activeSession = session;
    api(`/api/rooms/${encodeURIComponent(activeSession.roomId)}/heartbeat`, { method: 'POST', body: JSON.stringify({ token: activeSession.token }) }).catch((error) => {
      if (session !== activeSession) return;
      session = null;
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      stopStateEvents();
      console.log(`\n当前会话已结束：${error.message}`);
    });
  }, 10000);
}

async function exportGameRecord() {
  const record = await api(`/api/rooms/${encodeURIComponent(session.roomId)}/record?token=${encodeURIComponent(session.token)}`);
  const recordsDirectory = path.join(process.cwd(), 'records');
  const timestamp = record.startedAt.replace(/[:.]/g, '-');
  const filename = `no-thanks-${record.room.id}-${timestamp}.json`;
  const outputPath = path.join(recordsDirectory, filename);
  await fs.mkdir(recordsDirectory, { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(`\n对局记录已导出：${outputPath}`);
}

function assertReplayRecord(record) {
  if (!record || record.schemaVersion !== 1 || !Array.isArray(record.players) || !record.initialState || !Array.isArray(record.initialState.deck) || !Array.isArray(record.initialState.players) || !Array.isArray(record.turns) || !record.result || !Array.isArray(record.result.players)) {
    throw new Error('不是可识别的不谢牌对局记录（需要 schemaVersion: 1）');
  }
  const playerIds = new Set(record.players.map((player) => player.id));
  if (!playerIds.size || record.initialState.players.some((player) => !playerIds.has(player.id)) || record.turns.some((turn) => !playerIds.has(turn.playerId) || !['take', 'pass'].includes(turn.action) || !turn.event)) {
    throw new Error('对局记录中的玩家或行动信息不完整');
  }
  return record;
}

function replayStateAt(record, lastTurnIndex) {
  const state = {
    ...record.initialState,
    deck: [...record.initialState.deck],
    players: record.initialState.players.map((player) => ({ ...player, cards: [...player.cards] })),
  };
  for (let index = 0; index <= lastTurnIndex; index += 1) {
    const turn = record.turns[index];
    const actor = state.players.find((player) => player.id === turn?.playerId);
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

function replayName(record, playerId) {
  return record.players.find((player) => player.id === playerId)?.name || playerId;
}

function replayCardNumber(record, turn) {
  return Number.isInteger(turn.observation?.drawIndex) ? turn.observation.drawIndex + 1 : record.initialState.deck.indexOf(turn.event.card) + 1;
}

function printReplay(record, step, sourcePath) {
  const state = replayStateAt(record, step);
  const turn = step >= 0 ? record.turns[step] : null;
  console.clear();
  console.log(`不谢牌 · 离线回放 · ${record.room?.name || path.basename(sourcePath)}`);
  console.log(`来源：${sourcePath}`);
  console.log(`步骤 ${step < 0 ? '开局' : step + 1}/${record.turns.length} | 牌进度 ${state.drawIndex}/${state.deck.length} | 牌旁标记 ${state.pot}`);
  console.log(`当前牌：${state.currentCard ?? '—'}${state.currentPlayerId ? ` | 轮到 ${replayName(record, state.currentPlayerId)}` : ''}`);
  console.log('');
  state.players.forEach((player) => {
    const playerScore = score(player.cards, player.markers);
    console.log(`  ${replayName(record, player.id)}${player.id === state.currentPlayerId ? ' <轮到>' : ''} | 标记 ${player.markers} | 牌 ${[...player.cards].sort((a, b) => a - b).join(', ') || '-'} | 当前分 ${playerScore.total}`);
  });
  console.log('');
  if (!turn) console.log(`开局：${replayName(record, state.currentPlayerId)} 先处理 ${state.currentCard}。`);
  else if (turn.action === 'pass') console.log(`第 ${replayCardNumber(record, turn)} 张 ${turn.event.card}：${replayName(record, turn.playerId)} 拒收，放置 ${turn.event.markers} 个标记。`);
  else console.log(`第 ${replayCardNumber(record, turn)} 张 ${turn.event.card}：${replayName(record, turn.playerId)} 收下，获得 ${turn.event.markers} 个标记。`);
  if (state.phase === 'finished') {
    console.log('\n最终得分：');
    record.result.players
      .slice()
      .sort((left, right) => left.score.total - right.score.total)
      .forEach((player, index) => console.log(`  ${index + 1}. ${replayName(record, player.playerId)}：${player.score.total}`));
  }
}

async function replayFile(filePath) {
  const sourcePath = path.resolve(filePath);
  const record = assertReplayRecord(JSON.parse(await fs.readFile(sourcePath, 'utf8')));
  let step = -1;
  while (true) {
    printReplay(record, step, sourcePath);
    let command;
    try {
      command = (await ask('\n输入 next/prev/take（跳至下一次收牌）/end/quit：')).trim().toLowerCase();
    } catch (error) {
      if (rl.closed || error.message === 'readline was closed') return;
      throw error;
    }
    if (command === 'quit' || command === 'q') return;
    if (command === 'next' || command === 'n' || command === '') step = Math.min(record.turns.length - 1, step + 1);
    else if (command === 'prev' || command === 'p') step = Math.max(-1, step - 1);
    else if (command === 'take' || command === 't') {
      const nextTake = record.turns.findIndex((turn, index) => index > step && turn.action === 'take');
      if (nextTake >= 0) step = nextTake;
    } else if (command === 'end' || command === 'e') step = record.turns.length - 1;
    else console.log('请输入 next、prev、take、end 或 quit。');
  }
}

async function play() {
  let lastPhase = '';
  let renderedVersion = -1;
  while (session) {
    const update = await waitForStateUpdate(renderedVersion);
    if (!update) return;
    const { state, version } = update;
    renderedVersion = version;
    printState(state);
    if (state.room.phase === 'finished') {
      const command = (await ask('\n游戏结束。输入 export 导出 JSON，或直接回车回到原房间：')).trim().toLowerCase();
      if (command === 'export') {
        try { await exportGameRecord(); }
        catch (error) { console.log(`\n导出失败：${error.message}`); }
        renderedVersion -= 1;
        continue;
      }
      try { await api(`/api/rooms/${encodeURIComponent(session.roomId)}/return`, { method: 'POST', body: JSON.stringify({ token: session.token }) }); }
      catch (error) { console.log(`\n${error.message}`); }
      lastPhase = 'finished';
      continue;
    }
    if (state.room.phase === 'lobby') {
      const self = state.players.find((player) => player.id === state.self.id);
      const isHost = state.self.id === state.room.hostPlayerId;
      const rawCommand = (await ask(isHost ? '\n输入 ready/unready 准备状态，bot [beginner|intermediate|advanced] 加入人机，remove <玩家名称> 移除指定玩家，start 开始游戏，或直接回车等待：' : '\n输入 ready/unready 准备状态，或直接回车等待：')).trim();
      const command = rawCommand.toLowerCase();
      if ((command === 'ready' && !self.ready) || (command === 'unready' && self.ready)) {
        try { await api(`/api/rooms/${encodeURIComponent(session.roomId)}/ready`, { method: 'POST', body: JSON.stringify({ token: session.token }) }); }
        catch (error) { console.log(`\n${error.message}`); }
      }
      if (isHost) {
        if (command === 'bot' || command.startsWith('bot ')) {
          const level = command === 'bot' ? 'beginner' : command.slice('bot '.length).trim();
          try { await api(`/api/rooms/${encodeURIComponent(session.roomId)}/bot`, { method: 'POST', body: JSON.stringify({ token: session.token, level }) }); }
          catch (error) { console.log(`\n${error.message}`); }
        }
        if (command.startsWith('remove ')) {
          const name = rawCommand.slice('remove '.length).trim();
          const target = state.players.find((entry) => entry.id !== state.self.id && entry.name === name);
          if (!target) console.log('\n没有找到该玩家。');
          else try { await api(`/api/rooms/${encodeURIComponent(session.roomId)}/remove-player`, { method: 'POST', body: JSON.stringify({ token: session.token, targetId: target.id }) }); }
          catch (error) { console.log(`\n${error.message}`); }
        }
        if (command === 'start') {
          if (state.players.length < 3) console.log('\n至少需要 3 名玩家，可以先输入 bot。');
          else try { await api(`/api/rooms/${encodeURIComponent(session.roomId)}/start`, { method: 'POST', body: JSON.stringify({ token: session.token }) }); }
          catch (error) { console.log(`\n${error.message}`); }
        }
      }
      if (!isHost && lastPhase !== 'lobby') console.log('\n等待至少 3 名玩家和房主开始游戏，按 Ctrl+C 可退出。');
      lastPhase = 'lobby';
      continue;
    }
    lastPhase = 'playing';
    if (state.currentPlayerId === state.self.id) {
      const canPass = state.players.find((player) => player.id === state.self.id)?.markers > 0;
      const chatChoices = QUICK_CHAT_MESSAGES.map((phrase, index) => `${index + 1}.${phrase.text}`).join('  ');
      const action = (await ask(canPass ? `\n输入 take 收牌、pass 拒收，或 chat <编号> 说一句：\n${chatChoices}\n` : `\n你已经没有标记，只能输入 take 收牌，或 chat <编号> 说一句：\n${chatChoices}\n`)).trim().toLowerCase();
      if (action.startsWith('chat ')) {
        const phrase = QUICK_CHAT_MESSAGES[Number(action.slice('chat '.length).trim()) - 1];
        if (!phrase) { console.log('请输入 chat 1 到 chat 7。'); renderedVersion -= 1; continue; }
        try { await api(`/api/rooms/${encodeURIComponent(session.roomId)}/quick-chat`, { method: 'POST', body: JSON.stringify({ token: session.token, phraseId: phrase.id }) }); }
        catch (error) { console.log(`\n${error.message}`); renderedVersion -= 1; }
        continue;
      }
      if (action !== 'take' && action !== 'pass') { console.log('请输入 take 或 pass。'); renderedVersion -= 1; continue; }
      if (!canPass && action === 'pass') { console.log('你已经没有标记，不能拒收。'); renderedVersion -= 1; continue; }
      try { await api(`/api/rooms/${encodeURIComponent(session.roomId)}/action`, { method: 'POST', body: JSON.stringify({ token: session.token, action }) }); }
      catch (error) { console.log(`\n${error.message}`); renderedVersion -= 1; }
    }
  }
}

async function main() {
  const [mode, replayPath] = process.argv.slice(2);
  if (mode === 'replay') {
    if (!replayPath) throw new Error('请指定记录路径，例如：npm run cli -- replay records/xxx.json');
    await replayFile(replayPath);
    rl.close();
    return;
  }
  console.log(`连接服务器：${server}`);
  while (true) {
    try {
      printRooms((await api('/api/rooms')).rooms);
      console.log('\n1. 创建房间  2. 加入房间  3. 刷新  4. 回放本地 JSON  0. 退出');
      const choice = (await ask('选择：')).trim();
      if (choice === '0') break;
      if (choice === '3') continue;
      if (choice === '4') {
        const filePath = await ask('JSON 文件路径：');
        try { await replayFile(filePath.trim()); }
        catch (error) { console.log(`\n回放失败：${error.message}`); }
        continue;
      }
      if (choice === '1') {
        const playerName = await ask('你的昵称：');
        const name = await ask('房间名称：');
        const payload = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ playerName, name }) });
        session = { roomId: payload.room.room.id, token: payload.token };
        keepSessionAlive();
        startStateEvents();
        await play();
      } else if (choice === '2') {
        const roomId = await ask('房间 ID：');
        const playerName = await ask('你的昵称：');
        const payload = await api(`/api/rooms/${encodeURIComponent(roomId.trim())}/join`, { method: 'POST', body: JSON.stringify({ playerName }) });
        session = { roomId: payload.room.room.id, token: payload.token };
        keepSessionAlive();
        startStateEvents();
        await play();
      }
    } catch (error) {
      if (rl.closed || error.message === 'readline was closed') break;
      console.log(`\n错误：${error.message}`);
    }
  }
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  stopStateEvents();
  rl.close();
}

main();
