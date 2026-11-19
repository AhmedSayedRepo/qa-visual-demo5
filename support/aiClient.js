// Minimal AI client for runtime locator healing. Reads config from the
// environment (baked defaults come from the QA Studio connection you generated
// with). Supports Anthropic's messages API and any OpenAI-compatible /chat/
// completions endpoint (OpenAI, NVIDIA, Groq, DeepSeek, Qwen, Azure, Ollama, ...).
require('dotenv').config();

const PROVIDER = process.env.QA_AI_PROVIDER || 'openai';
const BASE     = process.env.QA_AI_BASE_URL || 'https://api.openai.com/v1';
const MODEL    = process.env.QA_AI_MODEL    || 'gpt-6-sol';
const KEY = process.env.QA_AI_API_KEY || process.env.ANTHROPIC_API_KEY ||
           process.env.OPENAI_API_KEY || process.env.NVIDIA_API_KEY ||
           process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '';
const HEAL = !!KEY;

const SYS = 'You resolve web locators. Given a step intent and a JSON array of ' +
  'candidate DOM elements, reply with ONLY a JSON object {"by":"...","value":"..."} ' +
  'identifying the single best matching element. "by" must be one of: css, id, ' +
  'name, xpath, text. No prose, no code fences.';

function _extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch (e) { return null; }
}

async function pickLocator(intent, dom) {
  if (!HEAL) return null;
  const user = 'Intent: ' + JSON.stringify(intent) + '\n\nCandidates:\n' + dom;
  // Up to 3 attempts with backoff. Node's fetch has NO retry of its own, and a
  // run with several parallel workers healing at once trips transient
  // "fetch failed" network errors and provider 429/529s — confirmed live: the
  // key was set and healing worked for other steps in the SAME run, while
  // these one-shot failures took their tests down with a misleading
  // "Set QA_AI_API_KEY" message (see healer.js).
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let resp, text;
      if (PROVIDER === 'anthropic') {
        resp = await fetch(BASE.replace(/\/$/, '') + '/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': KEY,
                     'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: MODEL, max_tokens: 300, system: SYS,
                                 messages: [{ role: 'user', content: user }] }),
        });
      } else {
        resp = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json',
                     'authorization': 'Bearer ' + KEY },
          body: JSON.stringify({ model: MODEL, temperature: 0,
            messages: [{ role: 'system', content: SYS },
                       { role: 'user', content: user }] }),
        });
      }
      if (resp.status === 429 || resp.status >= 500) {
        throw new Error('provider HTTP ' + resp.status);
      }
      const j = await resp.json();
      if (PROVIDER === 'anthropic') {
        text = j && j.content && j.content[0] && j.content[0].text;
      } else {
        text = j && j.choices && j.choices[0] && j.choices[0].message &&
               j.choices[0].message.content;
      }
      return _extractJson(text);
    } catch (e) {
      lastErr = e.message;
      console.log('[heal] AI call failed (attempt ' + attempt + '/3): ' + e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  console.log('[heal] giving up after 3 attempts: ' + lastErr);
  return null;
}
module.exports = { pickLocator, HEAL, PROVIDER, MODEL };
