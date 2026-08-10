/**
 * Site-wide Pages Function middleware.
 *
 * Serves an English version of every page to hansaneuron.com by rewriting the
 * (German) HTML server-side, using the same per-page translation data that's
 * already embedded in each page as JSON:
 *
 *   <script type="application/json" id="i18n-meta">{"de":{...},"en":{...}}</script>
 *   <script type="application/json" id="i18n-translations">{"de":{...},"en":{...}}</script>
 *
 * Why this exists: assets/site.js already switches the page to English on the
 * client after load (`domainDefault = hostname.endsWith('.com') ? 'en' : 'de'`),
 * but the raw HTML Cloudflare serves is German. Search engine crawlers and
 * no-JS visitors hitting hansaneuron.com therefore saw German — duplicate
 * content with .de and a broken hreflang="en" promise. This middleware fixes
 * that at the edge, without duplicating page content anywhere.
 *
 * The legal pages (impressum.html/imprint.html, datenschutz.html/privacy.html)
 * are standalone documents, not part of the shared data-i18n template system,
 * so they don't carry i18n-meta/i18n-translations JSON. Instead they exist as
 * separate DE/EN file pairs (matching the site's existing convention). This
 * middleware 308-redirects the German-named paths to their English
 * counterparts on the English hosts, so those paths never serve German under
 * hansaneuron.com.
 *
 * Also handles smaller cross-host fixes on the English hosts:
 *  - `<link rel="canonical">` is rewritten from the .de URL to the matching
 *    .com URL, so each language version self-references correctly.
 *  - `/robots.txt`'s `Sitemap:` line is rewritten to point at hansaneuron.com
 *    instead of hansaneuron.de (same underlying sitemap.xml file).
 *  - Open Graph / Twitter Card tags (og:title, og:description, og:url,
 *    og:locale, twitter:title, twitter:description) are swapped to their
 *    English values from the same i18n-meta JSON used for <title>/<meta
 *    description>. og:image/twitter:image are language-agnostic (same share
 *    image for both hosts) and are left untouched.
 *
 * TEMP SITE NOTE: this copy's COMMON_EN.footer.disclaimer intentionally omits
 * the professional-indemnity-insurance sentence that the root site's version
 * includes — this Temp site had its insurance-related content (trust card,
 * FAQ entry, footer disclaimer, Impressum Berufshaftpflicht section) removed
 * on 2026-07-17 because the policy was not yet finalized. Do not copy the
 * root site's COMMON_EN wholesale here; keep this file's disclaimer in sync
 * with THIS site's assets/site.js COMMON_T.en.footer.disclaimer instead.
 *
 * IMPORTANT: keep COMMON_EN below in sync with the `en` section of COMMON_T in
 * assets/site.js (nav / footer / cookie-banner strings). Workers/Pages
 * Functions cannot eval() the page's own inline JS at request time, so this
 * small, stable set of shared strings is intentionally duplicated here rather
 * than parsed out of site.js.
 */

// German-named legal pages → their English counterparts. Redirected (not
// content-rewritten) because they're separate static documents, not templated
// pages with embedded i18n JSON.
const LEGAL_PAGE_REDIRECTS = {
  '/impressum.html': '/imprint.html',
  '/datenschutz.html': '/privacy.html',
};

const COMMON_EN = {
  'nav.leistungen': 'Services',
  'nav.preise': 'Pricing',
  'nav.faq': 'FAQ',
  'nav.kontakt': 'Contact',
  'nav.cta': 'Free Website Check',
  'footer.home': 'Home',
  'footer.leistungen': 'Services',
  'footer.preise': 'Pricing',
  'footer.check': 'Website Check',
  'footer.faq': 'FAQ',
  'footer.kontakt': 'Contact',
  'footer.privacy': 'Privacy Policy',
  'footer.impressum': 'Imprint (Impressum)',
  'footer.copy': '© 2026 Hansa Neuron. All rights reserved.',
  'footer.disclaimer':
    'Hansa Neuron identifies technical security, maintenance and compliance risks on medical practice websites. We are not a law firm and do not provide legal advice. Legal assessments remain the responsibility of the practice and its legal advisers.',
  'cookie.text': 'This website uses only technically necessary cookies. No tracking or analytics cookies are used.',
  'cookie.policy': 'Privacy Policy',
  'cookie.accept': 'Got it',
};

const ENGLISH_HOSTS = new Set(['hansaneuron.com', 'www.hansaneuron.com']);

// English equivalent of preise.html's Service.serviceType ("Website-Sicherheit,
// Compliance & Wartung für Arzt- und Zahnarztpraxen"). Kept as a constant like
// COMMON_EN above since it's schema-only copy, not sourced from a data-i18n key.
const SERVICE_TYPE_EN = 'Website security, compliance and maintenance for medical and dental practices';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // Only touch the English-domain hosts; .de passes straight through untouched.
  if (!ENGLISH_HOSTS.has(url.hostname)) return context.next();

  // German-named legal pages redirect to their English counterpart before we
  // even fetch the (unused) original response.
  const redirectTo = LEGAL_PAGE_REDIRECTS[url.pathname];
  if (redirectTo) {
    url.pathname = redirectTo;
    return Response.redirect(url.toString(), 308);
  }

  const response = await context.next();

  // robots.txt: point its Sitemap: line at this host's own sitemap rather than
  // the German host's (same underlying sitemap.xml file, just requested via
  // the matching host).
  if (url.pathname === '/robots.txt') {
    const text = await response.text();
    const rewritten = text.replace('https://hansaneuron.de/sitemap.xml', 'https://hansaneuron.com/sitemap.xml');
    return new Response(rewritten, response);
  }

  // sitemap.xml: the underlying static file lists only hansaneuron.de <loc>
  // URLs. Google Search Console requires every <loc> in a sitemap to be on
  // the same host as the sitemap itself (a sitemap served from
  // hansaneuron.de can't list hansaneuron.com URLs, and vice versa) - so on
  // the English hosts we rewrite each <loc> (only <loc>, not the hreflang
  // xhtml:link alternates, which are expected/allowed to point cross-domain)
  // to the matching hansaneuron.com URL, swapping the German-named legal
  // pages for their English filenames.
  if (url.pathname === '/sitemap.xml') {
    const text = await response.text();
    const rewritten = text
      .replace(/<loc>https:\/\/hansaneuron\.de\/impressum\.html<\/loc>/, '<loc>https://hansaneuron.com/imprint.html</loc>')
      .replace(/<loc>https:\/\/hansaneuron\.de\/datenschutz\.html<\/loc>/, '<loc>https://hansaneuron.com/privacy.html</loc>')
      .replace(/<loc>https:\/\/hansaneuron\.de\//g, '<loc>https://hansaneuron.com/');
    return new Response(rewritten, response);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const html = await response.text();

  const metaMatch = html.match(/<script type="application\/json" id="i18n-meta">([\s\S]*?)<\/script>/);
  const transMatch = html.match(/<script type="application\/json" id="i18n-translations">([\s\S]*?)<\/script>/);

  // No i18n data on this page (e.g. impressum.html, datenschutz.html) — leave as-is.
  if (!metaMatch || !transMatch) {
    return new Response(html, response);
  }

  let meta, translations, i18nFull;
  try {
    i18nFull = JSON.parse(transMatch[1]);
    meta = JSON.parse(metaMatch[1]).en;
    translations = { ...COMMON_EN, ...i18nFull.en };
  } catch (err) {
    // Malformed i18n JSON on the page — fail safe and serve the original
    // (German) HTML rather than risk a broken page.
    return new Response(html, response);
  }

  // Structured data (JSON-LD): unlike every other piece of text on the page,
  // the embedded schema.org script is authored once in German and shipped
  // unchanged to the English hosts. That's a real SEO defect, not just a
  // cosmetic one: ProfessionalService/Service self-reference the .de URL from
  // a .com page, and a FAQPage schema in German on an English page won't earn
  // (and may actively hurt) rich-result eligibility for English queries. Fix
  // it in place, string-level, before the HTMLRewriter pass below, reusing
  // the same i18n data already loaded above rather than hardcoding new copy.
  let processedHtml = html;
  const ldMatch = processedHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldMatch) {
    try {
      const data = JSON.parse(ldMatch[1]);
      let changed = false;
      if (data['@type'] === 'ProfessionalService') {
        if (data.url === 'https://hansaneuron.de/') {
          data.url = 'https://hansaneuron.com/';
          changed = true;
        }
        if (meta?.desc) {
          data.description = meta.desc;
          changed = true;
        }
      } else if (data['@type'] === 'Service') {
        data.serviceType = SERVICE_TYPE_EN;
        changed = true;
        if (data.provider?.url === 'https://hansaneuron.de/') {
          data.provider.url = 'https://hansaneuron.com/';
          changed = true;
        }
      } else if (data['@type'] === 'FAQPage' && Array.isArray(data.mainEntity) && i18nFull.de && i18nFull.en) {
        // Match each German question in the schema back to its q{n} key via
        // the page's own translation table, then swap in the English pair.
        const deToKey = {};
        Object.keys(i18nFull.de).forEach((k) => {
          if (k.endsWith('.q')) deToKey[i18nFull.de[k]] = k.slice(0, -2);
        });
        data.mainEntity = data.mainEntity.map((item) => {
          const key = deToKey[item.name];
          const enQ = key && i18nFull.en[`${key}.q`];
          const enA = key && i18nFull.en[`${key}.a`];
          if (enQ && enA) {
            changed = true;
            return { '@type': 'Question', name: enQ, acceptedAnswer: { '@type': 'Answer', text: enA } };
          }
          return item; // no English match found — leave this entry as-is rather than drop it
        });
      }
      if (changed) {
        processedHtml = processedHtml.replace(ldMatch[0], `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`);
      }
    } catch (err) {
      // Malformed or unrecognized JSON-LD — leave it untouched rather than risk breaking the page.
    }
  }

  class HtmlLang {
    element(el) {
      el.setAttribute('lang', 'en');
    }
  }
  class Title {
    element(el) {
      if (meta?.title) el.setInnerContent(meta.title);
    }
  }
  class MetaDescription {
    element(el) {
      if (el.getAttribute('name') === 'description' && meta?.desc) {
        el.setAttribute('content', meta.desc);
      }
    }
  }
  class I18nText {
    element(el) {
      const key = el.getAttribute('data-i18n');
      if (key && translations[key] !== undefined) {
        el.setInnerContent(translations[key], { html: true });
      }
    }
  }
  class I18nPlaceholder {
    element(el) {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key && translations[key] !== undefined) {
        el.setAttribute('placeholder', translations[key]);
      }
    }
  }
  class CanonicalLink {
    element(el) {
      const href = el.getAttribute('href');
      if (href && href.startsWith('https://hansaneuron.de/')) {
        el.setAttribute('href', href.replace('https://hansaneuron.de/', 'https://hansaneuron.com/'));
      }
    }
  }
  class OgTitle {
    element(el) {
      if (meta?.title) el.setAttribute('content', meta.title);
    }
  }
  class OgDescription {
    element(el) {
      if (meta?.desc) el.setAttribute('content', meta.desc);
    }
  }
  class OgUrl {
    element(el) {
      const content = el.getAttribute('content');
      if (content && content.startsWith('https://hansaneuron.de/')) {
        el.setAttribute('content', content.replace('https://hansaneuron.de/', 'https://hansaneuron.com/'));
      }
    }
  }
  class OgLocale {
    element(el) {
      el.setAttribute('content', 'en_US');
    }
  }
  class PrivacyLink {
    element(el) {
      el.setAttribute('href', 'privacy.html');
    }
  }
  class ImprintLink {
    element(el) {
      el.setAttribute('href', 'imprint.html');
    }
  }
  class ContactEmailLink {
    element(el) {
      el.setAttribute('href', 'mailto:info@hansaneuron.com');
    }
  }
  class ContactEmailValue {
    element(el) {
      el.setInnerContent('info@hansaneuron.com');
    }
  }

  const rewriter = new HTMLRewriter()
    .on('html', new HtmlLang())
    .on('title', new Title())
    .on('meta[name="description"]', new MetaDescription())
    .on('link[rel="canonical"]', new CanonicalLink())
    .on('meta[property="og:title"]', new OgTitle())
    .on('meta[property="og:description"]', new OgDescription())
    .on('meta[property="og:url"]', new OgUrl())
    .on('meta[property="og:locale"]', new OgLocale())
    .on('meta[name="twitter:title"]', new OgTitle())
    .on('meta[name="twitter:description"]', new OgDescription())
    .on('[data-i18n]', new I18nText())
    .on('[data-i18n-placeholder]', new I18nPlaceholder())
    .on('a[data-privacy-link]', new PrivacyLink())
    .on('a[data-imprint-link]', new ImprintLink())
    .on('#contact-email-link', new ContactEmailLink())
    .on('#contact-email-value', new ContactEmailValue());

  return rewriter.transform(new Response(processedHtml, response));
}
