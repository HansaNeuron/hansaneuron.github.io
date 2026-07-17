/* ═══════════════════════════════════════════════════════════
   Hansa Neuron — shared site JS (i18n, nav, cookie banner)
   Pages define: window.pageTranslations = { de:{...}, en:{...} }
                 window.pageMeta = { de:{title,desc}, en:{title,desc} }
   ═══════════════════════════════════════════════════════════ */

const COMMON_T = {
  de: {
    'nav.leistungen': 'Leistungen',
    'nav.preise':     'Preise',
    'nav.faq':        'FAQ',
    'nav.kontakt':    'Kontakt',
    'nav.cta':        'Kostenloser Website-Check',
    'footer.home':     'Startseite',
    'footer.leistungen':'Leistungen',
    'footer.preise':   'Preise',
    'footer.check':    'Website-Check',
    'footer.faq':      'FAQ',
    'footer.kontakt':  'Kontakt',
    'footer.privacy':  'Datenschutz',
    'footer.impressum': 'Impressum',
    'footer.copy':     '© 2026 Hansa Neuron. Alle Rechte vorbehalten.',
    'footer.disclaimer': 'Hansa Neuron identifiziert technische Sicherheits-, Wartungs- und Compliance-Risiken auf Praxis-Websites. Wir sind keine Rechtsanwaltskanzlei und erbringen keine Rechtsberatung. Rechtliche Bewertungen bleiben der Verantwortung der Praxis und ihrer rechtlichen Berater vorbehalten.',
    'cookie.text':   'Diese Website verwendet ausschließlich technisch notwendige Cookies. Es werden keine Tracking- oder Analyse-Cookies eingesetzt.',
    'cookie.policy': 'Datenschutzerklärung',
    'cookie.accept': 'Verstanden',
  },
  en: {
    'nav.leistungen': 'Services',
    'nav.preise':     'Pricing',
    'nav.faq':        'FAQ',
    'nav.kontakt':    'Contact',
    'nav.cta':        'Free Website Check',
    'footer.home':     'Home',
    'footer.leistungen':'Services',
    'footer.preise':   'Pricing',
    'footer.check':    'Website Check',
    'footer.faq':      'FAQ',
    'footer.kontakt':  'Contact',
    'footer.privacy':  'Privacy Policy',
    'footer.impressum': 'Imprint (Impressum)',
    'footer.copy':     '© 2026 Hansa Neuron. All rights reserved.',
    'footer.disclaimer': 'Hansa Neuron identifies technical security, maintenance and compliance risks on medical practice websites. We are not a law firm and do not provide legal advice. Legal assessments remain the responsibility of the practice and its legal advisers.',
    'cookie.text':   'This website uses only technically necessary cookies. No tracking or analytics cookies are used.',
    'cookie.policy': 'Privacy Policy',
    'cookie.accept': 'Got it',
  }
};

// Default: domain decides; a manual choice persists across pages
const domainDefault = window.location.hostname.endsWith('.com') ? 'en' : 'de';
let currentLang = localStorage.getItem('hn_lang') || domainDefault;

function t(lang, key) {
  const p = window.pageTranslations || {};
  if (p[lang] && p[lang][key] !== undefined) return p[lang][key];
  if (COMMON_T[lang][key] !== undefined) return COMMON_T[lang][key];
  return undefined;
}

function setLang(lang, persist) {
  currentLang = lang;
  if (persist) localStorage.setItem('hn_lang', lang);
  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = t(lang, el.getAttribute('data-i18n'));
    if (v !== undefined) el.innerHTML = v;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const v = t(lang, el.getAttribute('data-i18n-placeholder'));
    if (v !== undefined) el.placeholder = v;
  });

  // Title & meta description
  if (window.pageMeta && window.pageMeta[lang]) {
    document.title = window.pageMeta[lang].title;
    const md = document.querySelector('meta[name="description"]');
    if (md && window.pageMeta[lang].desc) md.setAttribute('content', window.pageMeta[lang].desc);
  }

  // Contact email (if present on page)
  const email = lang === 'en' ? 'info@hansaneuron.com' : 'info@hansaneuron.de';
  const el = document.getElementById('contact-email-link');
  const ev = document.getElementById('contact-email-value');
  if (el) el.href = 'mailto:' + email;
  if (ev) ev.textContent = email;

  // Toggle buttons
  const bde = document.getElementById('btn-de'), ben = document.getElementById('btn-en');
  if (bde) bde.classList.toggle('active', lang === 'de');
  if (ben) ben.classList.toggle('active', lang === 'en');

  // Privacy links follow language
  const privacyHref = lang === 'en' ? 'privacy.html' : 'datenschutz.html';
  document.querySelectorAll('a[data-privacy-link]').forEach(a => { a.href = privacyHref; });

  document.dispatchEvent(new CustomEvent('hn:langchange', { detail: { lang } }));
}

// ── Mobile menu ──────────────────────────────────────
function toggleMenu() {
  document.getElementById('mobileMenu').classList.toggle('open');
}

// ── Cookie banner ────────────────────────────────────
function initCookieBanner() {
  const b = document.getElementById('cookieBanner');
  if (b && !localStorage.getItem('hn_cookie_consent')) b.style.display = 'flex';
}
function acceptCookies() {
  localStorage.setItem('hn_cookie_consent', 'accepted');
  const b = document.getElementById('cookieBanner');
  if (b) b.style.display = 'none';
}

// ── Scroll reveal ────────────────────────────────────
function initReveal() {
  const obs = new IntersectionObserver(
    entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
    }),
    { threshold: 0.12 }
  );
  document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
}

// ── Boot ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setLang(currentLang, false);
  initCookieBanner();
  initReveal();
});
