/**
 * Hansa Neuron — Kostenloser Praxis-Website-Check
 * Cloudflare Pages Function: POST /api/check  { url: "example.de" }
 *
 * Performs a technical quick check of a publicly reachable website in two
 * categories:
 *   security   — SSL, https redirect, HSTS, security headers, WordPress
 *                version exposure, mixed content, response time
 *   compliance — technical indicators relating to German law for practice
 *                websites (§ 5 DDG, Art. 13 DSGVO, § 25 TDDDG, BFSG):
 *                Impressum/Datenschutz reachability & content signals,
 *                repealed-law citations, pre-consent third parties,
 *                cookie consent tooling, accessibility basics, form note.
 *
 * Additionally fetches the Impressum and Datenschutz pages linked from the
 * homepage (same host only). Static HTML analysis only — no JS rendering,
 * no active scanning, no legal assessment. Results are technical indicators.
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

// Resolve a link found on the homepage; only same-host http(s) URLs pass (SSRF guard).
function resolveSameHost(href, baseUrl) {
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const base = new URL(baseUrl);
    const strip = h => h.replace(/^www\./, '');
    if (strip(u.hostname) !== strip(base.hostname)) return null;
    u.protocol = 'https:';
    u.hash = '';
    return u.href;
  } catch { return null; }
}

// Fetch a subpage; returns { ok, html } — never throws.
async function fetchSubpage(url) {
  if (!url) return { ok: false, html: '' };
  try {
    const { res } = await timedFetch(url);
    if (!res.ok) return { ok: false, html: '' };
    const html = (await res.text()).slice(0, MAX_BODY);
    return { ok: true, html };
  } catch { return { ok: false, html: '' }; }
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
  const add = (id, category, status, detail) =>
    checks.push(detail === undefined ? { id, category, status } : { id, category, status, detail });
  const sec = (id, status, detail) => add(id, 'security', status, detail);
  const com = (id, status, detail) => add(id, 'compliance', status, detail);

  // ══ SECURITY ═══════════════════════════════════════════════

  // ── 1. HTTPS reachability + timing ─────────────────────────
  let main = null, mainMs = 0;
  try {
    const { res, ms } = await timedFetch('https://' + host + '/');
    main = res; mainMs = ms;
  } catch {
    return jsonResponse({ ok: false, error: 'unreachable', host });
  }
  sec('ssl', main.ok || (main.status >= 200 && main.status < 500) ? 'pass' : 'warn');

  // ── 2. http → https redirect ───────────────────────────────
  try {
    const { res: httpRes } = await timedFetch('http://' + host + '/', { redirect: 'manual' });
    const loc = httpRes.headers.get('location') || '';
    if ([301, 302, 307, 308].includes(httpRes.status) && loc.startsWith('https://')) {
      sec('https_redirect', 'pass');
    } else if (httpRes.status >= 200 && httpRes.status < 300) {
      sec('https_redirect', 'fail');           // site served unencrypted
    } else {
      sec('https_redirect', 'warn');
    }
  } catch {
    // http port closed entirely → effectively forced https
    sec('https_redirect', 'pass');
  }

  // ── 3. Security headers ────────────────────────────────────
  const h = main.headers;
  const hsts = h.get('strict-transport-security');
  sec('hsts', hsts ? 'pass' : 'fail');

  const headerList = [
    ['content-security-policy', 'CSP'],
    ['x-frame-options', 'X-Frame-Options'],
    ['x-content-type-options', 'X-Content-Type-Options'],
    ['referrer-policy', 'Referrer-Policy']
  ];
  const present = headerList.filter(([k]) => h.get(k)).map(([, label]) => label);
  const missing = headerList.filter(([k]) => !h.get(k)).map(([, label]) => label);
  sec('sec_headers', present.length >= 3 ? 'pass' : present.length >= 1 ? 'warn' : 'fail',
      { present, missing, count: present.length, total: headerList.length });

  // ── 4. Homepage body ───────────────────────────────────────
  let html = '';
  try { html = (await main.text()).slice(0, MAX_BODY); } catch { /* ignore */ }
  const lower = html.toLowerCase();

  // WordPress & version exposure
  const isWp = /wp-content|wp-includes|\/wp-json/.test(lower);
  const genMatch = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s*([\d.]*)["']/i);
  if (genMatch) {
    sec('wp_version', 'fail', { version: genMatch[1] || '' });
  } else if (isWp) {
    sec('wp_version', 'pass', { wordpress: true });
  } else {
    sec('wp_version', 'info', { wordpress: false });
  }

  // Mixed content (http:// resources on an https page)
  const mixed = (html.match(/(?:src|href)=["']http:\/\/[^"']+\.(?:js|css|png|jpe?g|gif|svg|webp|woff2?)/gi) || []).length;
  sec('mixed_content', mixed === 0 ? 'pass' : 'fail', mixed ? { count: mixed } : undefined);

  // Response time
  sec('response_time', mainMs < 1500 ? 'pass' : mainMs < 3000 ? 'warn' : 'fail', { ms: mainMs });

  // ══ COMPLIANCE (technical indicators — no legal assessment) ═

  // ── 5. Locate & fetch Impressum / Datenschutz pages ────────
  const baseUrl = main.url || ('https://' + host + '/');
  const impHrefM = html.match(/href=["']([^"']*impressum[^"']*)["']/i);
  const dsHrefM  = html.match(/href=["']([^"']*(?:datenschutz|privacy)[^"']*)["']/i);
  const impUrl = impHrefM ? resolveSameHost(impHrefM[1], baseUrl) : null;
  const dsUrl  = dsHrefM  ? resolveSameHost(dsHrefM[1], baseUrl)  : null;

  const [impPage, dsPage] = await Promise.all([fetchSubpage(impUrl), fetchSubpage(dsUrl)]);

  // ── 6. Impressum (§ 5 DDG) ─────────────────────────────────
  if (!impHrefM) {
    com('imp_page', 'fail', { reason: 'no_link' });
  } else if (!impPage.ok) {
    com('imp_page', 'fail', { reason: 'unreachable' });
  } else {
    com('imp_page', 'pass');
  }

  if (impPage.ok) {
    const imp = impPage.html;
    const impLower = imp.toLowerCase();
    // Cloudflare Email Obfuscation rewrites mailto: links to /cdn-cgi/l/email-protection —
    // treat that as "e-mail present" to avoid false negatives on proxied sites.
    const hasEmail = /mailto:|cdn-cgi\/l\/email-protection|data-cfemail|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(imp);
    const hasPhone = /href=["']tel:|telefon|\+49[\s\d/().-]{6,}|\b0\d{2,4}[\s/-]?\d{3,}/i.test(imp);
    const hasChamber = /kammer|aufsichtsbeh/i.test(impLower);
    const missingParts = [];
    if (!hasEmail)   missingParts.push('email');
    if (!hasPhone)   missingParts.push('phone');
    com('imp_content', missingParts.length === 0 ? 'pass' : 'warn',
        missingParts.length ? { missing: missingParts } : undefined);
    // Chamber/supervisory details: mandatory for chambered professions (doctors,
    // dentists) but not for every business — informational card only when absent.
    if (!hasChamber) com('imp_chamber', 'info');

    // Repealed-law citations — classic Abmahnung target
    const repealed = [];
    if (/§\s*5\s*TMG|Telemediengesetz/i.test(imp)) repealed.push('§ 5 TMG');
    if (/§\s*55\s*RStV|Rundfunkstaatsvertrag/i.test(imp)) repealed.push('§ 55 RStV');
    com('imp_repealed', repealed.length ? 'fail' : 'pass',
        repealed.length ? { cited: repealed } : undefined);
  } else {
    com('imp_content', 'info', { skipped: true });
    com('imp_repealed', 'info', { skipped: true });
  }

  // ── 7. Datenschutzerklärung (Art. 13 DSGVO) ────────────────
  if (!dsHrefM) {
    com('ds_page', 'fail', { reason: 'no_link' });
  } else if (!dsPage.ok) {
    com('ds_page', 'fail', { reason: 'unreachable' });
  } else {
    com('ds_page', 'pass');
  }

  if (dsPage.ok) {
    const dsLower = dsPage.html.toLowerCase();
    const signals = [
      /verantwortlich/.test(dsLower),
      /dsgvo|datenschutz-grundverordnung|gdpr/.test(dsLower),
      /aufsichtsbeh/.test(dsLower),
      /betroffenenrecht|auskunft|widerspruch|löschung|loeschung/.test(dsLower)
    ].filter(Boolean).length;
    com('ds_content', signals >= 3 ? 'pass' : 'warn', { signals, total: 4 });

    // Outdated TTDSG citation (renamed TDDDG on 2024-05-14)
    const citesOld = /ttdsg/.test(dsLower) && !/tdddg/.test(dsLower);
    com('ds_outdated', citesOld ? 'warn' : 'pass');
  } else {
    com('ds_content', 'info', { skipped: true });
    com('ds_outdated', 'info', { skipped: true });
  }

  // ── 8. Cookie consent tooling (§ 25 TDDDG) ─────────────────
  const cmps = ['usercentrics', 'cookiebot', 'borlabs', 'complianz', 'cmplz', 'cookieyes', 'onetrust',
                'osano', 'consentmanager', 'klaro', 'ccm19', 'iubenda', 'termly', 'cookiefirst', 'cookie-consent', 'cookieconsent'];
  const cmpFound = cmps.find(c => lower.includes(c));
  com('cookie_consent', cmpFound ? 'pass' : 'warn', cmpFound ? { tool: cmpFound } : undefined);

  // ── 9. Pre-consent third parties (§ 25 TDDDG) ──────────────
  // Static HTML only — JS-injected embeds are not visible to this check.
  const tpPatterns = [
    [/fonts\.googleapis\.com|fonts\.gstatic\.com/i, 'Google Fonts'],
    [/google\.com\/maps|maps\.googleapis\.com|maps\.google\./i, 'Google Maps'],
    [/youtube\.com\/embed|youtube-nocookie\.com/i, 'YouTube'],
    [/googletagmanager\.com|google-analytics\.com/i, 'Google Analytics/Tag Manager'],
    [/connect\.facebook\.net|facebook\.com\/tr/i, 'Facebook Pixel'],
    [/jameda\./i, 'jameda'],
    [/doctolib\./i, 'Doctolib']
  ];
  const found = tpPatterns.filter(([re]) => re.test(html)).map(([, label]) => label);
  if (found.length === 0) {
    com('third_parties', 'pass');
  } else if (cmpFound) {
    com('third_parties', 'info', { found, tool: cmpFound });
  } else {
    com('third_parties', 'fail', { found });
  }

  // ── 10. Accessibility basics (BFSG) — indicators only ──────
  const hasLang = /<html[^>]+lang=/i.test(html);
  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  // An alt attribute counts even when empty (alt="") — that is correct WCAG
  // practice for decorative images. Only images with NO alt attribute are flagged.
  const imgsWithAlt = imgTags.filter(t => /\balt=["']/i.test(t)).length;
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const altOk = imgTags.length === 0 || imgsWithAlt / imgTags.length >= 0.8;
  const bfsgOk = hasLang && altOk && hasViewport;
  com('bfsg_basics', bfsgOk ? 'pass' : 'warn', {
    lang: hasLang ? '✓' : '✕',
    alt: imgTags.length ? imgsWithAlt + '/' + imgTags.length : '–',
    viewport: hasViewport ? '✓' : '✕'
  });

  // ── 11. Contact form / health data note (Art. 9 DSGVO) ─────
  const hasForm = /<form[\s>]/i.test(html);
  const hasFreeText = /<textarea/i.test(html) || /type=["']file["']/i.test(html);
  if (hasForm && hasFreeText) {
    com('form_health', 'info');
  }

  // ══ Scores (info items excluded; per category) ═════════════
  const scoreFor = cat => {
    const scored = checks.filter(c => c.category === cat && c.status !== 'info');
    if (!scored.length) return 100;
    const pts = scored.reduce((s, c) => s + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
    return Math.round((pts / scored.length) * 100);
  };
  const scores = { security: scoreFor('security'), compliance: scoreFor('compliance') };
  const score = Math.round((scores.security + scores.compliance) / 2);

  return jsonResponse({
    ok: true,
    host,
    finalUrl: main.url,
    score,
    scores,
    checks,
    checkedAt: new Date().toISOString(),
    note: 'Automated technical quick check. Compliance items are technical indicators only — no legal assessment.'
  });
}

// Any non-POST method
export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
}
