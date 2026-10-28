// Minimal Gemini REST client (no SDK). Free-tier key from env GEMINI_API_KEY.
// Model default: gemini-3.5-flash (free-tier eligible). Override with GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

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
      lastErr = new Error('gemini ' + res.status + ': ' + errText.slice(0, 300));
      lastErr.status = res.status;
      res = null;
      if (lastErr.status === 503 || lastErr.status === 429) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1) * (attempt + 1)));
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
