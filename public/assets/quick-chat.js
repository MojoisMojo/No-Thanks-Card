const QUICK_CHAT_MESSAGES = Object.freeze([
  Object.freeze({ id: 'no-thanks', text: '我不要这张！' }),
  Object.freeze({ id: 'wait', text: '再等等……' }),
  Object.freeze({ id: 'take', text: '这张我收下。' }),
  Object.freeze({ id: 'nice-card', text: '好牌！' }),
  Object.freeze({ id: 'dont-steal', text: '别抢！' }),
  Object.freeze({ id: 'low-markers', text: '我快没标记了。' }),
  Object.freeze({ id: 'thanks', text: '谢谢！' }),
]);

if (typeof module !== 'undefined') module.exports = { QUICK_CHAT_MESSAGES };
if (typeof window !== 'undefined') window.QUICK_CHAT_MESSAGES = QUICK_CHAT_MESSAGES;
