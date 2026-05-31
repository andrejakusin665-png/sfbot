// netlify/functions/claude.js
// Прокси к Anthropic API. Ключ берётся ТОЛЬКО из переменной окружения
// ANTHROPIC_API_KEY на сервере Netlify — в браузер он не попадает.
//
// Принимает: POST { text: "<кусок текста выписки>" }
// Отдаёт:    { transactions: [ { date, reference, description, amount, type } ] }
//
// Модель и таймауты настраиваются через env (см. README). Дата возвращается
// в ISO (YYYY-MM-DD), сумма — положительным числом. Строгий формат FirstBit
// (DD/MM/YYYY, 12500.00, раскладка Payment/Receipt) собирает фронтенд.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are a bank statement transaction extractor. You receive a raw text chunk from a bank statement (any bank, any country, any layout) and must return every real transaction you find.

Return ONLY a JSON object, no prose, no markdown fences:
{"transactions":[{"date":"YYYY-MM-DD","reference":"","description":"","amount":0,"type":"payment"}]}

Field rules:
- date: ISO YYYY-MM-DD. Infer the correct day/month order from context (locale, other dates, the word order of the statement). If only day+month are present, use the statement's year.
- amount: positive number, dot decimal, no thousands separators (e.g. 12500.00 not 12,500.00 and not "12.500,00").
- type: "payment" if money LEAVES the account (debit, withdrawal, outgoing, purchase, fee, charge); "receipt" if money ENTERS the account (credit, deposit, incoming, refund). Never both.
- reference: the bank's transaction/reference/document number if present, else "".
- description: counterparty name or purpose, trimmed.

Ignore non-transaction lines: page headers, column titles, opening/closing balance, running balance, subtotals, totals, statement metadata, footers. A balance is NOT a transaction.
If the chunk contains no transactions, return {"transactions":[]}.
Output strictly valid JSON and nothing else.`;

const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  },
  body: JSON.stringify(obj),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Вызов Anthropic с ретраями на 429/5xx (экспоненциальная задержка).
async function callAnthropic(apiKey, text, attempt = 0) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
  });

  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const wait = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
    await sleep(wait);
    return callAnthropic(apiKey, text, attempt + 1);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Достаём текст из ответа, чистим возможные ```json ... ``` и парсим.
function parseTransactions(data) {
  const raw = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Иногда модель оборачивает JSON в текст — вытащим первый {...}.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return [];
    parsed = JSON.parse(m[0]);
  }
  return Array.isArray(parsed.transactions) ? parsed.transactions : [];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: "ANTHROPIC_API_KEY не задан в переменных окружения Netlify.",
    });
  }

  let text;
  try {
    ({ text } = JSON.parse(event.body || "{}"));
  } catch {
    return json(400, { error: "Невалидный JSON в теле запроса." });
  }
  if (!text || typeof text !== "string") {
    return json(400, { error: "Поле 'text' обязательно." });
  }

  try {
    const data = await callAnthropic(apiKey, text);
    const transactions = parseTransactions(data);
    return json(200, { transactions });
  } catch (err) {
    return json(err.status && err.status < 500 ? err.status : 502, {
      error: err.message || "Ошибка обращения к Anthropic API.",
    });
  }
};
