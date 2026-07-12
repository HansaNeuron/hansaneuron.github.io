/**
 * Hansa Neuron — Kostenloser Praxis-Website-Check
 * Cloudflare Pages Function: POST /api/check  { url: "example.de" }
 *
 * Performs a technical quick check of a publicly reachable website:
 * SSL, https redirect, security headers, WordPress version exposure,
 * cookie consent tooling, Impressum/Datenschutz links, mixed content,
 * response time. Technical checks only — no legal assessment.
 */

const UA = 'Mozilla/5.0 (compatible; HansaNeuronCheck/1.0; +https://hansaneuron.de/website-check.html)';
const FETCH_TIMEOUT_MS = 12000;
const MAX_BODY = 400000;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function normalizeHost(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^\/+/, '');
  s = s.split(/[/?#]/)[0];           // host only
  s = s.split('@').pop();            // strip credentials
  s = s.split(':')[0];               // strip port
  if (!s || !s.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  if (s.length > 253) return null;
  // Reject raw IPs & internal names (SSRF guard)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  if (/^(localhost|.*\.(local|internal|lan|home|localdomain))$/.test(s)) return null;
  return s;
}

async function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      ...opts,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', ...(opts.headers || {}) },
      signal: ctrl.signal
    });
    return { res, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort in-memory rate limit (per isolate). A Cloudflare WAF
// rate-limiting rule on /api/check remains the authoritative control.
const RL_WINDOW_MS = 60000, RL_MAX = 8;
const rlHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  if (rlHits.size > 5000) rlHits.clear();
  const rec = (rlHits.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  rec.push(now);
  rlHits.set(ip, rec);
  return rec.length > RL_MAX;
}

export async function onRequestPost({ request }) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip)) return jsonResponse({ ok: false, error: 'rate_limited' }, 429);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: 'bad_request' }, 400); }

  const host = normalizeHost(body.url);
  if (!host) return jsonResponse({ ok: false, error: 'invalid_url' }, 400);

  const checks = [];
  const add = (id, status, detail) => checks.push(detail === undefined ? { id, status } : { id, status, detail });

  // ── 1. HTTPS reachability + timing ─────────────────────────
  let main = null, mainMs = 0;
  try {
    const { res, ms } = await timedFetch('https://' + host + '/');
    main = res; mainMs = ms;
  } catch {
    return jsonResponse({ ok: false, error: 'unreachable', host });
  }
  add('ssl', main.ok || (main.status >= 200 && main.status < 500) ? 'pass' : 'warn');

  // ── 2. http → https redirect ───────────────────────────────
  try {
    const { res: httpRes } = await timedFetch('http://' + host + '/', { redirect: 'manual' });
    const loc = httpRes.headers.get('location') || '';
    if ([301, 302, 307, 308].includes(httpRes.status) && loc.startsWith('https://')) {
      add('https_redirect', 'pass');
    } else if (httpRes.status >= 200 && httpRes.status < 300) {
      add('https_redirect', 'fail');           // site served unencrypted
    } else {
      add('https_redirect', 'warn');
    }
  } catch {
    // http port closed entirely → effectively forced https
    add('https_redirect', 'pass');
  }

  // ── 3. Security headers ────────────────────────────────────
  const h = main.headers;
  const hsts = h.get('strict-transport-security');
  add('hsts', hsts ? 'pass' : 'fail');

  const headerList = [
    ['content-security-policy', 'CSP'],
    ['x-frame-options', 'X-Frame-Options'],
    ['x-content-type-options', 'X-Content-Type-Options'],
    ['referrer-policy', 'Referrer-Policy']
  ];
  const present = headerList.filter(([k]) => h.get(k)).map(([, label]) => label);
  const missing = headerList.filter(([k]) => !h.get(k)).map(([, label]) => label);
  add('sec_headers', present.length >= 3 ? 'pass' : present.length >= 1 ? 'warn' : 'fail',
      { present, missing, count: present.length, total: headerList.length });

  // ── 4. Body-based checks ───────────────────────────────────
  let html = '';
  try { html = (await main.text()).slice(0, MAX_BODY); } catch { /* ignore */ }
  const lower = html.toLowerCase();

  // WordPress & version exposure
  const isWp = /wp-content|wp-includes|\/wp-json/.test(lower);
  const genMatch = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s*([\d.]*)["']/i);
  if (genMatch) {
    add('wp_version', 'fail', { version: genMatch[1] || '' });
  } else if (isWp) {
    add('wp_version', 'pass', { wordpress: true });
  } else {
    add('wp_version', 'info', { wordpress: false });
  }

  // Cookie consent tooling (heuristic)
  const cmps = ['usercentrics', 'cookiebot', 'borlabs', 'complianz', 'cmplz', 'cookieyes', 'onetrust',
                'osano', 'consentmanager', 'klaro', 'ccm19', 'iubenda', 'termly', 'cookiefirst', 'cookie-consent', 'cookieconsent'];
  const cmpFound = cmps.find(c => lower.includes(c));
  add('cookie_consent', cmpFound ? 'pass' : 'warn', cmpFound ? { tool: cmpFound } : undefined);

  // Impressum & Datenschutz links
  add('impressum', /href=["'][^"']*impressum/i.test(html) || /\bimpressum\b/.test(lower) ? 'pass' : 'warn');
  add('datenschutz', /href=["'][^"']*(datenschutz|privacy)/i.test(html) ? 'pass' : 'warn');

  // Mixed content (http:// resources on an https page)
  const mixed = (html.match(/(?:src|href)=["']http:\/\/[^"']+\.(?:js|css|png|jpe?g|gif|svg|webp|woff2?)/gi) || []).length;
  add('mixed_content', mixed === 0 ? 'pass' : 'fail', mixed ? { count: mixed } : undefined);

  // Response time
  add('response_time', mainMs < 1500 ? 'pass' : mainMs < 3000 ? 'warn' : 'fail', { ms: mainMs });

  // ── Score (info items excluded) ────────────────────────────
  const scored = checks.filter(c => c.status !== 'info');
  const pts = scored.reduce((s, c) => s + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  const score = Math.round((pts / scored.length) * 100);

  return jsonResponse({
    ok: true,
    host,
    finalUrl: main.url,
    score,
    checks,
    checkedAt: new Date().toISOString(),
    note: 'Automated technical quick check. No legal assessment.'
  });
}

// Any non-POST method
export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
}
