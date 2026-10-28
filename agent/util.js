// Fetch + HTML-to-text utilities shared by the investigation pipeline.
const UA = 'OAuthSetupScout/1.0 (research bot; contact: take-home demo)';

export function withTimeout(promise, ms, label = 'op') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout')), ms)),
  ]);
}

export async function fetchPage(url, { timeoutMs = 12000, maxBytes = 400000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5' },
    });
    const ctype = res.headers.get('content-type') || '';
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size > maxBytes) { try { await reader.cancel(); } catch {} break; }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return { ok: res.ok, status: res.status, url: res.url, contentType: ctype, raw };
  } finally {
    clearTimeout(t);
  }
}

export function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
  return s.trim();
}

export function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 500) {
    try {
      const u = new URL(m[1], baseUrl);
      if (!u.protocol.startsWith('http')) continue;
      const text = htmlToText(m[2]).slice(0, 120);
      links.push({ url: u.origin + u.pathname, text });
    } catch {}
  }
  const seen = new Set();
  return links.filter(l => (seen.has(l.url) ? false : (seen.add(l.url), true)));
}

export function normalizeDomain(input) {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z0-9]/.test(s)) return null;
  if (s.includes('.') || s.includes('/')) {
    s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
  }
  return null; // plain name, no domain
}

export function slugifyName(input) {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}
