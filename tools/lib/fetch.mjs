// Polite fetching. museliving.dk's robots.txt declares `Crawl-delay: 10`, and we honour it
// by default even though this is an authorized audit of the client's own site — a scan that
// gets us rate-limited produces a snapshot that lies about the site.

export function makeFetcher({ userAgent, crawlDelayMs = 10_000, log = () => {} }) {
  let last = 0;

  async function wait() {
    const gap = Date.now() - last;
    if (gap < crawlDelayMs) await new Promise((r) => setTimeout(r, crawlDelayMs - gap));
    last = Date.now();
  }

  return async function get(url, { redirect = 'follow' } = {}) {
    await wait();
    const started = Date.now();
    try {
      const res = await fetch(url, {
        redirect,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'da-DK,da;q=0.9,en;q=0.5',
        },
        signal: AbortSignal.timeout(45_000),
      });
      const body = await res.text();
      const ms = Date.now() - started;
      log(`  ${res.status} ${ms}ms ${url}`);
      return {
        url,
        finalUrl: res.url,
        status: res.status,
        redirected: res.redirected,
        ms,
        bytes: body.length,
        headers: Object.fromEntries(res.headers),
        body,
      };
    } catch (err) {
      log(`  ERR ${url} — ${err.message}`);
      return { url, finalUrl: null, status: 0, error: err.message, ms: Date.now() - started, body: '' };
    }
  };
}

export function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

export function sitemapEntries(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map((block) => {
    const loc = block[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i);
    const mod = block[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i);
    const imgs = (block[1].match(/<image:loc>/gi) || []).length;
    return { loc: loc?.[1] ?? null, lastmod: mod?.[1] ?? null, images: imgs };
  });
}
