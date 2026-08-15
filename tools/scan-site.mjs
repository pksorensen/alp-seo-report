#!/usr/bin/env node
// Technical SEO scan of one site, driven entirely by that site's config.json.
//
// Measures the same areas mechanically on every run, so that "did anything change?" stops
// being a matter of memory. Writes a dated snapshot; report-site.mjs turns snapshots into
// a diff. The tool is stateless — snapshots, config and change log all live in --data.
//
//   node scan-site.mjs --data ../site/seo-tracker   # full scan, honours Crawl-delay
//   node scan-site.mjs --data … --delay 2000        # faster, for iterating on the script
//   node scan-site.mjs --data … --quick             # money pages + sitemaps, no products
//
// No credentials, no third-party services. Everything here is a public GET.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFetcher, sitemapUrls, sitemapEntries } from './lib/fetch.mjs';
import * as H from './lib/html.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const QUICK = argv.includes('--quick');

// The tool lives in one repo, the site's data in another: --data points at the
// tracker directory (config.json, snapshots/, reports/, changes.jsonl) of the
// site being measured. Defaults to the script's own directory so a checkout that
// keeps both together still works.
const DATA = arg('data', ROOT);

const cfg = JSON.parse(await readFile(join(DATA, 'config.json'), 'utf8'));
const DELAY = Number(arg('delay', cfg.crawlDelayMs));
const DATE = arg('date', new Date().toISOString().slice(0, 10));
const OUT = join(DATA, 'snapshots', 'site', DATE);
const HOST = new URL(cfg.site).host;

const log = (m) => process.stdout.write(`${m}\n`);
const get = makeFetcher({ userAgent: cfg.userAgent, crawlDelayMs: DELAY, log });

// ---------------------------------------------------------------- page-level facts

function auditPage(res) {
  const html = res.body || '';
  const t = H.title(html);
  const ld = H.jsonLd(html);
  const types = ld.flatMap((n) => (Array.isArray(n['@type']) ? n['@type'] : [n['@type']])).filter(Boolean);
  const product = ld.find((n) => String(n['@type']).includes('Product'));

  return {
    url: res.url,
    finalUrl: res.finalUrl,
    status: res.status,
    redirected: res.redirected,
    ttfbMs: res.ms,
    bytes: res.bytes,
    cache: res.headers?.['x-litespeed-cache'] ?? res.headers?.['x-qc-cache'] ?? null,
    title: t,
    titleLength: t?.length ?? 0,
    description: H.metaContent(html, 'description'),
    robots: H.metaContent(html, 'robots'),
    canonical: H.canonical(html),
    hreflangInHead: H.hreflangs(html),
    ...H.headings(html),
    images: H.images(html),
    words: H.visibleWordCount(html),
    links: H.internalLinks(html, HOST),
    chatGptArtifacts: H.chatGptArtifacts(html),
    schemaTypes: [...new Set(types)],
    product: product
      ? {
          name: product.name ?? null,
          sku: product.sku ?? null,
          brand: product.brand ?? null,
          hasAggregateRating: Boolean(product.aggregateRating),
          hasReview: Boolean(product.review),
          price: product.offers?.price ?? product.offers?.[0]?.price ?? null,
        }
      : null,
    flags: {
      // §1 — untranslated Rank Math templates leaking onto Danish pages. Record WHICH
      // field matched: the title template was fixed while the description one was not, so
      // a hit list that only prints titles reads as a false positive.
      englishTemplate: cfg.englishTemplateMarkers.flatMap((m) => [
        ...(t?.includes(m) ? [{ marker: m, field: 'title' }] : []),
        ...(H.metaContent(html, 'description')?.includes(m) ? [{ marker: m, field: 'description' }] : []),
      ]),
      // §1 — the .eu/.de/.fr site title bleeding into .dk titles via WPML.
      wrongBrandInTitle: cfg.wrongBrandMarkers.filter((m) => t?.toLowerCase().includes(m)),
      noindex: /noindex/i.test(H.metaContent(html, 'robots') ?? ''),
    },
  };
}

// ---------------------------------------------------------------- site-level checks

async function checkRobots() {
  const res = await get(`${cfg.site}/robots.txt`);
  const txt = res.body || '';
  return {
    status: res.status,
    hasSitemapDirective: /^\s*sitemap:/im.test(txt),
    crawlDelay: txt.match(/crawl-delay:\s*(\d+)/i)?.[1] ?? null,
    disallow: [...txt.matchAll(/^\s*disallow:\s*(\S+)/gim)].map((m) => m[1]),
    raw: txt.trim(),
  };
}

async function checkSitemaps() {
  const idx = await get(`${cfg.site}/sitemap_index.xml`);
  const children = sitemapUrls(idx.body || '');
  const out = { indexStatus: idx.status, children: [], totals: {} };

  for (const child of children) {
    const res = await get(child);
    const ct = res.headers?.['content-type'] ?? '';
    const isXml = /xml/i.test(ct) && (res.body || '').trimStart().startsWith('<');
    const entries = isXml ? sitemapEntries(res.body) : [];
    out.children.push({
      url: child,
      status: res.status,
      contentType: ct,
      // The July audit found product-sitemap6.xml serving HTML instead of XML.
      servesXml: isXml,
      urlCount: entries.length,
      newestLastmod: entries.map((e) => e.lastmod).filter(Boolean).sort().at(-1) ?? null,
      oldestLastmod: entries.map((e) => e.lastmod).filter(Boolean).sort()[0] ?? null,
      imageRefs: entries.reduce((n, e) => n + e.images, 0),
      sample: entries.slice(0, 5).map((e) => e.loc),
      entries: entries.map((e) => ({ loc: e.loc, lastmod: e.lastmod })),
    });
  }

  const all = out.children.flatMap((c) => c.entries.map((e) => e.loc)).filter(Boolean);
  out.totals = {
    sitemaps: out.children.length,
    urls: all.length,
    hasCategorySitemap: out.children.some((c) => /product_cat/i.test(c.url)),
    brokenSitemaps: out.children.filter((c) => c.status !== 200 || !c.servesXml).map((c) => c.url),
    junkUrlsInSitemap: all.filter((u) => cfg.junkSitemapPaths.some((p) => u.endsWith(p))),
  };
  return out;
}

async function checkWwwRedirect() {
  // The .dk site's www host is a separate DNS name; where it lands decides whether Danish
  // traffic on that variant reaches the Danish shop at all.
  const res = await get(`https://www.${HOST}/`, { redirect: 'follow' });
  return {
    status: res.status,
    landsOn: res.finalUrl,
    leavesDanishDomain: Boolean(res.finalUrl && !res.finalUrl.includes(HOST)),
    title: H.title(res.body || ''),
  };
}

// ---------------------------------------------------------------- run

async function main() {
  await mkdir(OUT, { recursive: true });
  log(`${cfg.siteName ?? new URL(cfg.site).host} — SEO-scanning ${DATE}  (delay ${DELAY}ms${QUICK ? ', quick' : ''})\n`);

  log('robots.txt');
  const robots = await checkRobots();

  log('sitemaps');
  const sitemaps = await checkSitemaps();

  log('www redirect');
  const www = await checkWwwRedirect();

  // Page set: the money pages, every product category, and a deterministic product sample
  // (evenly spaced through the catalogue so the same slots are re-measured next run).
  const catSitemap = sitemaps.children.find((c) => /product_cat/i.test(c.url));
  const categories = (catSitemap?.entries ?? []).map((e) => e.loc);
  const productUrls = sitemaps.children
    .filter((c) => /product-sitemap/i.test(c.url))
    .flatMap((c) => c.entries.map((e) => e.loc))
    .filter(Boolean)
    .sort();

  const step = Math.max(1, Math.floor(productUrls.length / cfg.productSampleSize));
  const productSample = QUICK
    ? []
    : Array.from({ length: Math.min(cfg.productSampleSize, productUrls.length) }, (_, i) => productUrls[i * step]);

  // Blog posts are scanned in full rather than sampled: there are few of them, and the
  // content workstream that restarted on 2026-07-29 is exactly what we need to judge.
  const blogPosts = (sitemaps.children.find((c) => /post-sitemap/i.test(c.url))?.entries ?? [])
    .map((e) => e.loc)
    .filter(Boolean);

  const pageSet = [
    ...cfg.moneyPages.map((p) => new URL(p, cfg.site).href),
    // Scanned even when they 404 — "does this page exist yet" is itself the measurement.
    ...(cfg.plannedLandingPages ?? []).map((p) => new URL(p, cfg.site).href),
    ...blogPosts,
    ...categories,
    ...productSample,
  ].filter((v, i, a) => a.indexOf(v) === i);

  log(`\npages (${pageSet.length})`);
  const pages = [];
  for (const url of pageSet) pages.push(auditPage(await get(url)));

  // ------------------------------------------------------------- roll up the audit areas

  const ok = pages.filter((p) => p.status === 200);
  const products = ok.filter((p) => p.product);

  // Every page carries ~900 words of header/mega-menu/footer boilerplate, so a raw word
  // count says nothing about editorial copy. The thinnest category page is our best
  // estimate of that floor; what matters is how much a page adds on top of it.
  const categoryPages = ok.filter((p) => p.url.includes('/category/'));
  const boilerplateWords = categoryPages.length ? Math.min(...categoryPages.map((p) => p.words)) : 0;
  const ownCopy = (p) => Math.max(0, p.words - boilerplateWords);

  // Includes non-200 pages: the planned-landing-page check asks whether a URL responds
  // at all, so it must be able to look up the ones that did not.
  const byPath = new Map(pages.map((p) => [new URL(p.url).pathname, p]));

  // Same trick for links: the mega-menu and footer link to the same targets from every
  // page, so a raw link count is identical everywhere and discriminates nothing. For each
  // target, the smallest number of links any page has to it is the boilerplate floor;
  // anything above the floor is a link the page itself placed. Counting rather than
  // set-differencing matters because the categories a post *should* link to in its body
  // are exactly the ones already sitting in the mega-menu.
  const linkFloor = {};
  for (const p of ok) for (const h of Object.keys(p.links.internalPathCounts ?? {})) linkFloor[h] = Infinity;
  for (const p of ok) {
    for (const h of Object.keys(linkFloor)) {
      linkFloor[h] = Math.min(linkFloor[h], p.links.internalPathCounts?.[h] ?? 0);
    }
  }
  const bodyLinks = (p) => {
    const self = new URL(p.url).pathname;
    return Object.entries(p.links.internalPathCounts ?? {})
      .filter(([h, n]) => h !== self && n - (linkFloor[h] ?? 0) > 0)
      .map(([h]) => h);
  };
  // Commercial = category, product, or one of the standalone landing pages (`/smal-vinreol/`
  // and friends), but never another blog post — post-to-post links are useful, they just
  // are not what "does this article sell anything" asks.
  const blogPaths = new Set(blogPosts.map((u) => new URL(u).pathname));
  const isCommercial = (h) =>
    !blogPaths.has(h) &&
    (h.includes('/category/') || h.includes('/vare/') || /vinreol|vinkaelder|akustikpanel|moebler|sengebord/i.test(h));
  const summary = {
    date: DATE,
    scannedAt: new Date().toISOString(),
    site: cfg.site,
    pagesScanned: pages.length,
    areas: {
      titlesAndMeta: {
        homepageTitle: ok.find((p) => p.url === `${cfg.site}/`)?.title ?? null,
        pagesWithEnglishTemplate: ok
          .filter((p) => p.flags.englishTemplate.length)
          .map((p) => ({
            url: p.url,
            fields: [...new Set(p.flags.englishTemplate.map((f) => f.field))],
            evidence: p.flags.englishTemplate[0].field === 'title' ? p.title : p.description,
          })),
        pagesWithWrongBrandInTitle: ok.filter((p) => p.flags.wrongBrandInTitle.length).map((p) => ({ url: p.url, title: p.title })),
        missingDescription: ok.filter((p) => !p.description).map((p) => p.url),
        titleTooLong: ok.filter((p) => p.titleLength > 65).length,
      },
      hreflang: {
        pagesWithHeadHreflang: ok.filter((p) => p.hreflangInHead.length).length,
        sample: ok.find((p) => p.hreflangInHead.length)?.hreflangInHead ?? [],
      },
      content: {
        blogPosts: sitemaps.children.find((c) => /post-sitemap/i.test(c.url))?.urlCount ?? 0,
        newestBlogLastmod: sitemaps.children.find((c) => /post-sitemap/i.test(c.url))?.newestLastmod ?? null,
        boilerplateWords,
        categoriesWithOwnCopy: categoryPages
          .filter((p) => ownCopy(p) >= 150)
          .map((p) => ({ url: p.url, ownWords: ownCopy(p) }))
          .sort((a, b) => b.ownWords - a.ownWords),
        categoriesWithThinCopy: categoryPages
          .filter((p) => ownCopy(p) < 150)
          .map((p) => ({ url: p.url, ownWords: ownCopy(p) })),
        chatGptArtifactPages: ok.filter((p) => p.chatGptArtifacts > 0).map((p) => p.url),
        blogPostDetail: ok
          .filter((p) => blogPosts.includes(p.url) && !/\/blog\/?$/.test(p.url))
          .map((p) => ({
            url: p.url,
            title: p.title,
            ownWords: ownCopy(p),
            h1: p.h1[0] ?? null,
            h2Count: p.h2Count,
            // Does the post link into the commercial pages it is meant to support? Only
            // links outside the site-wide navigation count — those are the post's own.
            bodyLinks: bodyLinks(p).length,
            commercialLinks: bodyLinks(p).filter(isCommercial),
            hasDescription: Boolean(p.description),
          }))
          .sort((a, b) => b.ownWords - a.ownWords),
      },
      images: {
        totalImgs: ok.reduce((n, p) => n + p.images.total, 0),
        emptyAlt: ok.reduce((n, p) => n + p.images.emptyAlt, 0),
        missingAlt: ok.reduce((n, p) => n + p.images.missingAlt, 0),
        get emptyAltPct() {
          return this.totalImgs ? Math.round(((this.emptyAlt + this.missingAlt) / this.totalImgs) * 100) : 0;
        },
      },
      indexation: {
        robots,
        hasCategorySitemap: sitemaps.totals.hasCategorySitemap,
        brokenSitemaps: sitemaps.totals.brokenSitemaps,
        junkUrlsInSitemap: sitemaps.totals.junkUrlsInSitemap,
        uncategorised: ok.find((p) => p.url.includes('ukategoriseret')) ?? null,
        noindexedPages: ok.filter((p) => p.flags.noindex).map((p) => p.url),
      },
      schema: {
        productsSampled: products.length,
        withBrand: products.filter((p) => p.product.brand).length,
        withRating: products.filter((p) => p.product.hasAggregateRating).length,
        withBreadcrumb: ok.filter((p) => p.schemaTypes.includes('BreadcrumbList')).length,
        nameContaminatedWithTitle: products
          .filter((p) => /\||museliving/i.test(p.product.name ?? ''))
          .map((p) => ({ url: p.url, name: p.product.name })),
        homepageTypes: ok.find((p) => p.url === `${cfg.site}/`)?.schemaTypes ?? [],
      },
      performance: {
        ttfbMedianMs: median(ok.map((p) => p.ttfbMs)),
        ttfbP90Ms: percentile(ok.map((p) => p.ttfbMs), 90),
        slowPages: ok.filter((p) => p.ttfbMs > 2000).map((p) => ({ url: p.url, ms: p.ttfbMs, cache: p.cache })),
        medianHtmlKb: Math.round(median(ok.map((p) => p.bytes)) / 1024),
      },
      linking: {
        pagesLeakingToSiblingDomains: ok.filter((p) => p.links.crossDomain.length).map((p) => ({ url: p.url, to: p.links.crossDomain })),
        xdomainTokenLinks: ok.reduce((n, p) => n + p.links.xdomainToken, 0),
      },
      headings: {
        pagesWithoutH1: ok.filter((p) => p.h1.length === 0).map((p) => p.url),
        pagesWithMultipleH1: ok.filter((p) => p.h1.length > 1).map((p) => p.url),
        homepageH1: ok.find((p) => p.url === `${cfg.site}/`)?.h1 ?? [],
      },
      wwwRedirect: www,
      // The pages the keyword plan says must exist. Most of them do not yet, and a page
      // that is not there cannot rank — so this is the one number that tracks the plan
      // itself rather than the state of what is already published.
      landingPages: {
        planned: (cfg.plannedLandingPages ?? []).length,
        live: (cfg.plannedLandingPages ?? []).filter((p) => byPath.get(p)?.status === 200).length,
        missing: (cfg.plannedLandingPages ?? []).filter((p) => byPath.get(p)?.status !== 200),
        // Several planned URLs exist under a different slug and 301 to it. That is a page
        // that exists, not a page that is missing — but the plan and the site disagree
        // about its address, and one of the two has to give.
        underAnotherUrl: (cfg.plannedLandingPages ?? [])
          .filter((p) => byPath.get(p)?.status === 200 && byPath.get(p)?.redirected)
          .map((p) => ({ path: p, to: byPath.get(p).finalUrl })),
        thin: (cfg.plannedLandingPages ?? [])
          .filter((p) => byPath.get(p)?.status === 200 && ownCopy(byPath.get(p)) < 150)
          .map((p) => ({ path: p, ownWords: ownCopy(byPath.get(p)) })),
      },
    },
    sitemapTotals: sitemaps.totals,
  };

  await writeFile(join(OUT, 'pages.jsonl'), pages.map((p) => JSON.stringify(p)).join('\n') + '\n');
  await writeFile(
    join(OUT, 'sitemaps.json'),
    JSON.stringify({ ...sitemaps, children: sitemaps.children.map(({ entries, ...c }) => ({ ...c, entries: entries.length })) }, null, 2),
  );
  await writeFile(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  log(`\nWrote ${OUT}`);
}

const median = (a) => percentile(a, 50);
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

await main();
