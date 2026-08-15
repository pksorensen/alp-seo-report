// Minimal HTML fact-extraction. Deliberately dependency-free: this script must keep
// running years from now without an npm install, and every fact it pulls is a single
// tag or attribute. If we ever need real DOM traversal, that is the moment to add a parser.

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .trim();

const head = (html) => {
  const m = html.match(/<head[\s\S]*?<\/head>/i);
  return m ? m[0] : html.slice(0, 200_000);
};

export function title(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decode(m[1]) : null;
}

export function metaContent(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([\\s\\S]*?)["']`,
    'i',
  );
  const alt = new RegExp(
    `<meta[^>]+content=["']([\\s\\S]*?)["'][^>]*(?:name|property)=["']${name}["']`,
    'i',
  );
  const m = html.match(re) || html.match(alt);
  return m ? decode(m[1]) : null;
}

export function canonical(html) {
  const m = head(html).match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  return m ? decode(m[1]) : null;
}

export function hreflangs(html) {
  const out = [];
  const re = /<link[^>]+rel=["']alternate["'][^>]*>/gi;
  for (const tag of head(html).match(re) || []) {
    const lang = tag.match(/hreflang=["']([^"']+)["']/i);
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (lang && href) out.push({ lang: lang[1], href: decode(href[1]) });
  }
  return out;
}

export function headings(html) {
  const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
    decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '),
  );
  const h2 = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) =>
    decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '),
  );
  return { h1, h2Count: h2.length, h2: h2.slice(0, 12) };
}

export function images(html) {
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  let empty = 0;
  let missing = 0;
  const englishFilenames = new Set();
  for (const t of tags) {
    const alt = t.match(/\balt=["']([^"']*)["']/i);
    if (!alt) missing++;
    else if (!alt[1].trim()) empty++;
    const src = t.match(/\bsrc=["']([^"']+)["']/i);
    if (src) {
      const file = src[1].split('/').pop().split('?')[0];
      // Heuristic: an English-named asset on a Danish shop. Danish product words we
      // expect if the filenames had been localized.
      if (/^[a-z0-9._-]+$/i.test(file) && /(shelf|shelfs|oak|bedside|wine-rack|acoustic|panel|smoked|general)/i.test(file))
        englishFilenames.add(file);
    }
  }
  return {
    total: tags.length,
    emptyAlt: empty,
    missingAlt: missing,
    withAlt: tags.length - empty - missing,
    englishFilenameSamples: [...englishFilenames].slice(0, 8),
  };
}

export function jsonLd(html) {
  const blocks = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  const nodes = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      const push = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(push);
        if (n['@graph']) return n['@graph'].forEach(push);
        nodes.push(n);
      };
      push(parsed);
    } catch {
      nodes.push({ '@type': '__unparseable__' });
    }
  }
  return nodes;
}

export function visibleWordCount(html) {
  const body = (html.match(/<body[\s\S]*?<\/body>/i) || [html])[0];
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decode(text).split(/\s+/).filter((w) => w.length > 1).length;
}

export function internalLinks(html, host) {
  const hrefs = [...html.matchAll(/<a\b[^>]+href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const out = { total: hrefs.length, crossDomain: [], xdomainToken: 0, internalPathCounts: {} };
  for (const h of hrefs) {
    if (h.includes('xdomain_data=')) out.xdomainToken++;
    let path = null;
    if (/^https?:\/\//i.test(h)) {
      const d = h.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
      if (d !== host && /museliving\.(eu|de|fr)$/i.test(d)) out.crossDomain.push(h);
      if (d === host) path = new URL(h).pathname;
    } else if (h.startsWith('/')) {
      path = h.split('?')[0].split('#')[0];
    }
    // Counts, not a set: a page that also links a category from its body text links it
    // twice, and that second occurrence is the only trace of the editorial link. The
    // scan subtracts the site-wide floor per target to recover it.
    if (path) out.internalPathCounts[path] = (out.internalPathCounts[path] ?? 0) + 1;
  }
  out.crossDomain = [...new Set(out.crossDomain)].slice(0, 10);
  return out;
}

export const chatGptArtifacts = (html) => (html.match(/data-start=["']\d+["']/g) || []).length;
