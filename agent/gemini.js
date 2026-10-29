// Minimal Gemini REST client (no SDK). Free-tier key from env GEMINI_API_KEY.
// Model default: gemini-3.5-flash-lite. The plain 'gemini-3.5-flash' alias resolves to a
// preview flash model whose free-tier quota is tiny (5 RPM / 20 RPD, shared per project),
// which caused production 429s. Flash-Lite has far more free-tier headroom (15 RPM / 500 RPD)
// and supports the same JSON-schema structured output. Override with GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

function sanitizeGeminiError(status, errText) {
  // Log only classified, non-secret diagnostics: status, quota metric/limit/model, retry hint.
  let msg = '';
  try {
    const j = JSON.parse(errText);
    const e = j.error || {};
    msg = e.status || '';
    const m = String(e.message || '');
    const q = m.match(/Quota exceeded for metric: ([^,]+), limit: ([0-9,]+)(?:, model: ([^\s,.]+))?/i);
    const r = m.match(/retry in ([0-9.]+)s/i);
    if (q) msg += (msg ? ' ' : '') + 'quota metric=' + q[1] + ' limit=' + q[2] + (q[3] ? ' model=' + q[3] : '');
    else msg += (msg ? ' ' : '') + m.slice(0, 120);
    if (r) msg += ' retryIn=' + r[1] + 's';
  } catch { msg = String(errText || '').slice(0, 120); }
  msg = msg.replace(/key=[^&\s]+/gi, 'key=[redacted]').slice(0, 200);
  return 'gemini ' + status + ': ' + msg;
}


export function hasKey() {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 10);
}

export async function generateJSON({ system, prompt, schema, maxOutputTokens = 8192, temperature = 0.2 }) {
  const key = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
    },
  };
  let res, lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) break;
      const errText = await res.text().catch(() => '');
      lastErr = new Error(sanitizeGeminiError(res.status, errText));
      lastErr.status = res.status;
      res = null;
      if (lastErr.status === 503 || lastErr.status === 429) {
        await new Promise(r => setTimeout(r, [8000, 20000, 45000][attempt] || 45000));
        continue;
      }
      throw lastErr;
    } catch (e) {
      if (e === lastErr) throw e;
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  if (!res) throw lastErr;
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('gemini empty response');
  return JSON.parse(text);
}

export const GUIDE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    app: { type: 'STRING' },
    domain: { type: 'STRING' },
    summary: { type: 'STRING' },
    supportsOAuth: { type: 'BOOLEAN' },
    difficulty: { type: 'OBJECT', properties: {
      score: { type: 'INTEGER' }, label: { type: 'STRING' }, rationale: { type: 'STRING' } }, required: ['score','label','rationale'] },
    timeToFirstToken: { type: 'STRING' },
    approvalWait: { type: 'OBJECT', properties: { label: { type: 'STRING' }, detail: { type: 'STRING' } }, required: ['label','detail'] },
    steps: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      title: { type: 'STRING' }, detail: { type: 'STRING' }, actor: { type: 'STRING' } }, required: ['title','detail','actor'] } },
    requirements: { type: 'ARRAY', items: { type: 'STRING' } },
    nuances: { type: 'ARRAY', items: { type: 'STRING' } },
    agentCanDo: { type: 'ARRAY', items: { type: 'STRING' } },
    humanMustDo: { type: 'ARRAY', items: { type: 'STRING' } },
    evidence: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      claim: { type: 'STRING' }, source: { type: 'STRING' }, support: { type: 'STRING' } }, required: ['claim','source','support'] } },
    uncertainties: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['app','domain','summary','supportsOAuth','difficulty','timeToFirstToken','approvalWait','steps','requirements','nuances','agentCanDo','humanMustDo','evidence','uncertainties'],
};
