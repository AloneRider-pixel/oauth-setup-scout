// Investigation pipeline: given an app name or website, find its real developer/OAuth
// documentation on the live web and turn it into a structured, cited setup guide.
// Every claim in the output is tied to a fetched URL or explicitly marked uncertain.
import { fetchPage, htmlToText, extractLinks, normalizeDomain, slugifyName, withTimeout } from './util.js';
import { hasKey, generateJSON, GUIDE_SCHEMA } from './gemini.js';

const DOC_HINT = /(oauth|openid|authorization|authentication|developer|docs|api[-./ ]|app review|marketplace|verification|consent)/i;
const OAUTH_HINT = /(oauth|openid|authorization|scopes|consent|redirect|callback|client[_ ]?id|app review|verification|marketplace|partner)/i;

const CANDIDATE_PATHS = ['/developers', '/developer', '/docs', '/docs/developers', '/developers/docs', '/dev', '/api', '/api-docs', '/platform', '/build'];
const CANDIDATE_SUBDOMAINS = ['developer', 'developers', 'docs'];

async function tryFetch(url, log, why) {
  try {
    const page = await withTimeout(fetchPage(url), 14000, 'fetch');
    log({ step: 'fetch', url: page.url, status: page.status, why });
    if (page.ok && (page.contentType.includes('html') || page.contentType.includes('json') || page.contentType.includes('text'))) {
      return page;
    }
  } catch (e) {
    log({ step: 'fetch', url, error: String(e.message || e).slice(0, 120), why });
  }
  return null;
}

async function resolveDomain(query, log, useLLM) {
  const direct = normalizeDomain(query);
  if (direct) return { domain: direct, how: 'input was a website/domain' };
  const slug = slugifyName(query);
  if (!slug) throw new Error('Could not understand the app name. Try its website instead.');

  if (useLLM) {
    try {
      const r = await generateJSON({
        system: 'You map product/company names to their official website domain. Reply JSON only.',
        prompt: `What is the official primary domain of the product or company named "${query}"? If unsure, say null. JSON: {"domain": string|null, "confidence": "high"|"low"}`,
        schema: { type: 'OBJECT', properties: { domain: { type: 'STRING', nullable: true }, confidence: { type: 'STRING' } } },
        maxOutputTokens: 2000,
      });
      if (r.domain) {
        const d = normalizeDomain(r.domain);
        if (d) {
          const check = await tryFetch('https://' + d, log, 'verify LLM-suggested domain');
          if (check) return { domain: d, how: 'LLM suggested, verified by fetching the site' };
        }
      }
    } catch (e) {
      log({ step: 'resolve', error: 'LLM domain resolution failed: ' + String(e.message || e).slice(0, 120) });
    }
  }
  // DuckDuckGo instant answer (no key needed)
  try {
    const ddg = await withTimeout(fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query + ' official site')}&format=json&no_html=1`).then(r => r.json()), 8000, 'ddg');
    const cand = normalizeDomain(ddg.AbstractURL || ddg?.Results?.[0]?.FirstURL || '');
    if (cand) {
      const check = await tryFetch('https://' + cand, log, 'verify search-suggested domain');
      if (check) return { domain: cand, how: 'search suggestion, verified by fetching the site' };
    }
  } catch {}
  // Last resort: common TLD guesses
  for (const tld of ['.com', '.io', '.dev', '.ai', '.co', '.app']) {
    const d = slug + tld;
    const check = await tryFetch('https://' + d, log, 'TLD guess');
    if (check) {
      const title = (check.raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].toLowerCase();
      if (title.includes(slug) || check.raw.toLowerCase().includes(slug)) {
        return { domain: d, how: 'guessed domain ' + d + ' and verified it mentions the name' };
      }
    }
  }
  throw new Error(`Could not find an official website for "${query}". Try submitting its URL instead.`);
}

async function collectEvidence(domain, log) {
  const evidence = [];
  const seen = new Set();
  const addPage = async (url, why, depth = 0) => {
    const key = url.replace(/\/$/, '');
    if (seen.has(key) || evidence.length >= 8) return null;
    seen.add(key);
    const page = await tryFetch(url, log, why);
    if (!page) return null;
    const text = htmlToText(page.raw).slice(0, 12000);
    evidence.push({ url: page.url, why, text, html: depth === 0 ? page.raw : null });
    return evidence[evidence.length - 1];
  };

  const home = await addPage('https://' + domain, 'app homepage');
  // Probe well-known developer/doc locations
  const probes = [];
  for (const sub of CANDIDATE_SUBDOMAINS) probes.push(`https://${sub}.${domain}`);
  for (const p of CANDIDATE_PATHS) probes.push(`https://${domain}${p}`);
  const linkPool = [];
  if (home) {
    for (const l of extractLinks(home.html || '', home.url)) {
      if (DOC_HINT.test(l.url) || DOC_HINT.test(l.text)) linkPool.push(l);
    }
  }
  // Fetch probes; stop early once we have enough oauth-flavored material
  for (const u of probes) {
    if (evidence.filter(e => OAUTH_HINT.test(e.text)).length >= 3) break;
    await addPage(u, 'well-known developer/docs location');
  }
  // Follow the most promising doc links (from homepage and any hub pages)
  const scored = linkPool
    .map(l => ({ ...l, s: (OAUTH_HINT.test(l.url) ? 2 : 0) + (OAUTH_HINT.test(l.text) ? 2 : 0) + (DOC_HINT.test(l.url + l.text) ? 1 : 0) }))
    .sort((a, b) => b.s - a.s);
  for (const l of scored.slice(0, 5)) {
    if (evidence.length >= 8) break;
    await addPage(l.url, 'doc link from site: ' + (l.text || l.url).slice(0, 60));
  }
  // If nothing OAuth-flavored found yet, dig one level into a docs hub's links
  if (!evidence.some(e => /oauth/i.test(e.text))) {
    const hub = evidence.find(e => e.html);
    const hubLinks = hub ? extractLinks(hub.html, hub.url).filter(l => OAUTH_HINT.test(l.url) || OAUTH_HINT.test(l.text)) : [];
    for (const l of hubLinks.slice(0, 3)) {
      if (evidence.length >= 8) break;
      await addPage(l.url, 'oauth link inside docs hub');
    }
  }
  return evidence.map(({ url, why, text }) => ({ url, why, text }));
}

// ---------- Fallback synthesis (no LLM): deterministic, doc-assisted ----------
function fallbackSynthesis(query, domain, evidence, log) {
  const blob = evidence.map(e => e.text).join('\n').toLowerCase();
  const hasOAuth = /oauth|openid connect/.test(blob);
  const mentionsReview = /(app review|marketplace review|verification process|partner program|submit for (review|verification)|approval process)/.test(blob);
  const timeHints = [...new Set((blob.match(/\b\d+\s*(business days?|weeks?|months?|hours?)\b/g) || []))].slice(0, 6);
  const consoleUrl = evidence.map(e => e.url).find(u => /(console|dashboard|developer|portal|apps)/i.test(u)) || null;
  const oauthPage = evidence.map(e => e.url).find(u => /oauth|auth/i.test(u)) || (evidence[0] && evidence[0].url) || null;

  const evidenceRows = [];
  if (hasOAuth && oauthPage) evidenceRows.push({ claim: 'The provider documents an OAuth 2.0 / OpenID Connect flow.', source: oauthPage, support: 'official-docs' });
  if (mentionsReview) evidenceRows.push({ claim: 'The documentation mentions a review, verification, or approval process that may apply before broad distribution.', source: oauthPage || (evidence[0] || {}).url, support: 'official-docs' });
  if (timeHints.length) evidenceRows.push({ claim: 'Time-related phrases found in the docs: ' + timeHints.join(', ') + ' (context not verified).', source: oauthPage || (evidence[0] || {}).url, support: 'official-docs' });
  if (!evidenceRows.length) evidenceRows.push({ claim: 'No OAuth-specific documentation could be located automatically.', source: 'https://' + domain, support: 'uncertain' });

  return {
    app: query, domain,
    summary: `Automatically assembled starter guide for ${query}. Generated without an LLM (doc-assisted mode): it reports what the crawler found in the provider's own pages, and leaves judgments to you. Verify each step before relying on it.`,
    supportsOAuth: hasOAuth,
    difficulty: { score: hasOAuth ? 3 : 4, label: 'Unrated - needs human judgment', rationale: 'Doc-assisted mode does not rate difficulty. Read the evidence below and the linked pages.' },
    timeToFirstToken: 'Unknown from automated scan - look for a "register app" or "console" page in the sources.',
    approvalWait: { label: mentionsReview ? 'Review/approval mentioned in docs' : 'No approval step found in scan', detail: mentionsReview ? 'The docs mention review/verification; the exact trigger and wait were not extracted in this mode.' : 'That does not prove none exists - check the linked docs manually.' },
    steps: [
      { title: 'Open the developer documentation', detail: (oauthPage || ('https://' + domain)) + ' - start here; look for "create app", "register application", or "OAuth".', actor: 'both' },
      { title: 'Create the OAuth app in the provider console', detail: (consoleUrl ? 'Candidate console/developer page: ' + consoleUrl + '. ' : '') + 'Requires a provider account; an agent on your behalf can reach this page but account creation and consent are human steps.', actor: 'human' },
      { title: 'Configure redirect URI and scopes', detail: 'Request the narrowest scopes that cover your use case.', actor: 'both' },
      { title: 'Check review/verification requirements before launch', detail: mentionsReview ? 'Docs mention a review or verification step - read the linked evidence and plan for the wait.' : 'No review requirement surfaced in the automated scan; verify before assuming none.', actor: 'human' },
    ],
    requirements: ['A provider developer account (human step).', 'A public HTTPS redirect/callback URL for your app.'],
    nuances: ['This guide was assembled by a crawler + heuristics, not an LLM: treat it as a map to the real docs, not as finished analysis.'],
    agentCanDo: ['Find and read the provider\'s developer/OAuth docs (done - see investigated URLs).', 'Draft the redirect URLs, scope list, and registration field values for you to paste.'],
    humanMustDo: ['Create the developer account and accept provider terms.', 'Actually register the OAuth app and hold the client secret.', 'Submit any verification/review materials and answer the provider\'s questions.'],
    evidence: evidenceRows,
    uncertainties: ['Difficulty rating and exact approval wait were not determined in doc-assisted mode.', 'Some fetched pages may be login-gated or JS-rendered; the crawler only sees public HTML.'],
  };
}

// ---------- LLM synthesis ----------
async function llmSynthesis(query, domain, evidence, log) {
  const pack = (ev) => ev.map(e => `SOURCE: ${e.url}\n${e.text.slice(0, 7000)}`).join('\n\n=====\n\n').slice(0, 45000);

  // Round 2: let the agent choose up to 3 more pages worth reading
  try {
    const more = await generateJSON({
      system: 'You are investigating how a developer creates and gets approval for an OAuth app at a specific provider. You may request up to 3 more URLs to read. Reply JSON only.',
      prompt: `App under investigation: ${query} (${domain}).\n\nEvidence already collected:\n${pack(evidence)}\n\nIf a crucial page is missing (OAuth setup, app registration, app review/verification policy, marketplace listing rules), list up to 3 exact URLs to fetch. Prefer URLs you saw in the evidence. JSON: {"urls": [{"url": string, "why": string}]}`,
      schema: { type: 'OBJECT', properties: { urls: { type: 'ARRAY', items: { type: 'OBJECT', properties: { url: { type: 'STRING' }, why: { type: 'STRING' } }, required: ['url','why'] } } }, required: ['urls'] },
      maxOutputTokens: 3000,
    });
    for (const u of (more.urls || []).slice(0, 3)) {
      try {
        const parsed = new URL(u.url);
        if (!parsed.protocol.startsWith('http')) continue;
        const page = await tryFetch(parsed.href, log, 'LLM-requested: ' + (u.why || '').slice(0, 80));
        if (page) evidence.push({ url: page.url, why: 'LLM-requested: ' + (u.why || '').slice(0, 80), text: htmlToText(page.raw).slice(0, 12000) });
      } catch {}
    }
  } catch (e) {
    log({ step: 'llm-round2', error: String(e.message || e).slice(0, 150) });
  }

  const system = `You are an OAuth integration investigator. You produce a practical setup guide for a developer who needs to create an OAuth app with a provider so their own product's users can connect that provider. Rules:
- Use ONLY the supplied evidence for factual claims. Every factual claim in "evidence" must cite one of the supplied source URLs.
- "support" is one of: official-docs (from the provider's own pages), community (third-party), uncertain (your inference - say so in the claim).
- Rate difficulty 1-5 for a typical developer getting from zero to a working OAuth app IN PRODUCTION for their users (1 = register and go, 5 = gated partner program or mandatory paid audit).
- steps.actor is one of: agent, human, both. "agent" = an AI agent with web access can do it without an account; "human" = needs an account, consent, payment, legal, or provider communication.
- Be concrete: name the console page, the scope choices, the review trigger, the wait.
- If the provider does not support third-party OAuth apps at all, set supportsOAuth=false and explain in summary.`;
  const guide = await generateJSON({
    system,
    prompt: `App under investigation: ${query} (${domain}).\n\nEvidence collected from the live web:\n${pack(evidence)}\n\nProduce the guide JSON.`,
    schema: GUIDE_SCHEMA,
    maxOutputTokens: 12000,
  });
  return guide;
}

export async function investigate(query, onLog = () => {}) {
  const log = [];
  const push = (e) => { log.push(e); onLog(e); };
  const useLLM = hasKey();
  push({ step: 'start', query, mode: useLLM ? 'llm-agent' : 'doc-assisted' });

  const { domain, how } = await resolveDomain(query, push, useLLM);
  push({ step: 'resolved', domain, how });

  let evidence = await collectEvidence(domain, push);
  if (!evidence.length) throw new Error(`Found ${domain} but could not read any developer documentation pages.`);

  let guide;
  if (useLLM) {
    try {
      guide = await llmSynthesis(query, domain, evidence, push);
    } catch (e) {
      push({ step: 'llm-failed', error: String(e.message || e).slice(0, 200), fallback: 'doc-assisted' });
      guide = fallbackSynthesis(query, domain, evidence, push);
      guide.mode = 'doc-assisted';
    }
  } else {
    guide = fallbackSynthesis(query, domain, evidence, push);
  }

  guide.app = guide.app || query;
  guide.domain = domain;
  guide.generatedAt = new Date().toISOString();
  guide.mode = guide.mode || (useLLM ? 'llm-agent' : 'doc-assisted');
  guide.investigated = evidence.map(e => e.url);
  guide.resolution = how;
  return { guide, log };
}
