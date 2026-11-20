// Core conversation model (producer-only). Owns the semantics of an exchange
// so renderers never have to guess: user text, assistant text or an explicit
// aborted state, with timestamps captured when events happen.
// Requirements: R1 (cancelled exchange shows what happened, no summary) and
// R3 (session language fixed by the first exchange). No model calls here.

export const EXCHANGE_STATUS = {
  pending: 'pending',
  answered: 'answered',
  aborted: 'aborted',
};

// Fixed surface markers for an aborted exchange (R1). Renderers print them
// verbatim; they are data, not presentation decisions.
export const ABORTED_YOU_SUFFIX = '(operation cancelled)';
export const ABORTED_PI_MARKER = 'No response (operation aborted)';

// Minimal stopword heuristic for R3: the session language is decided once,
// from the first exchange whose text is detectable. Good enough to keep
// summaries stable; consumers may override with their own detector.
const ES_HINTS = ['que', 'de', 'el', 'la', 'los', 'las', 'para', 'con', 'por', 'una', 'uno', 'como', 'pero', 'esta', 'este', 'si', 'no', 'y', 'o', 'hacer', 'puede'];
const EN_HINTS = ['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'not', 'you', 'are', 'what', 'how', 'can', 'should', 'make', 'add'];

export function detectLanguage(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0) return null;
  let es = 0;
  let en = 0;
  for (const w of words) {
    if (ES_HINTS.includes(w)) es += 1;
    if (EN_HINTS.includes(w)) en += 1;
  }
  if (es === en) return null;
  return es > en ? 'es' : 'en';
}

export function userText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

export function assistantText(message) {
  if (!message || message.role !== 'assistant') return '';
  return userText(message);
}

export function createExchangeLog({ detect = detectLanguage } = {}) {
  const exchanges = [];
  let language = null;
  let nextId = 1;

  const log = {
    // A user message starts (or reopens) the pending exchange.
    beginUser(text, ts) {
      const exchange = {
        id: nextId++,
        status: EXCHANGE_STATUS.pending,
        user: { text: String(text ?? ''), ts: ts ?? null, cancelled: false },
        assistant: null,
      };
      exchanges.push(exchange);
      if (!language) {
        const detected = detect(exchange.user.text);
        if (detected) language = detected;
      }
      return exchange;
    },

    // The assistant answered: data goes in verbatim, never summarized.
    setAssistant(text, ts) {
      const current = log.pending();
      if (!current) return null;
      current.assistant = { text: String(text ?? ''), ts: ts ?? null, marker: null };
      current.status = EXCHANGE_STATUS.answered;
      return current;
    },

    // R1: the exchange was cancelled. Record exactly what happened; the
    // aborted exchange carries fixed markers and triggers no summary.
    abort(ts) {
      const current = log.pending();
      if (!current) return null;
      current.user.cancelled = true;
      current.assistant = { text: null, ts: ts ?? null, marker: ABORTED_PI_MARKER };
      current.status = EXCHANGE_STATUS.aborted;
      return current;
    },

    pending() {
      for (let i = exchanges.length - 1; i >= 0; i -= 1) {
        if (exchanges[i].status === EXCHANGE_STATUS.pending) return exchanges[i];
      }
      return null;
    },

    language() {
      return language;
    },

    exchanges() {
      return exchanges.map((e) => structuredClone(e));
    },

    summary() {
      const counts = { pending: 0, answered: 0, aborted: 0 };
      for (const e of exchanges) counts[e.status] += 1;
      return { count: exchanges.length, status: counts, language };
    },
  };
  return log;
}
