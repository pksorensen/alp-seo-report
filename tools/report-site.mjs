#!/usr/bin/env node
// Renders a site snapshot as a readable Danish status report, and — when an earlier
// snapshot exists — the delta against it, annotated with what we logged in changes.jsonl
// for the period in between. That pairing is the whole attribution mechanism: a movement
// with no logged change beside it is a movement we cannot claim.
//
//   node report-site.mjs --data …                    # newest snapshot vs the one before
//   node report-site.mjs --data … --date 2026-09-15  # a specific snapshot
//   node report-site.mjs --data … --vs 2026-08-15    # against a chosen earlier snapshot

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

// See scan-site.mjs: --data is the measured site's tracker directory.
const DATA = arg('data', ROOT);

const SNAPS = join(DATA, 'snapshots', 'site');
const dates = (await readdir(SNAPS)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
if (!dates.length) { console.error('Ingen snapshots. Kør scan-site.mjs først.'); process.exit(1); }

const date = arg('date', dates.at(-1));
const prevDate = arg('vs', dates[dates.indexOf(date) - 1] ?? null);

const load = async (d) => JSON.parse(await readFile(join(SNAPS, d, 'summary.json'), 'utf8'));
const cur = await load(date);
const prev = prevDate ? await load(prevDate) : null;

// The numbers we follow over time. `good` says which direction is an improvement, so the
// delta column can be read without thinking about each metric's polarity.
const METRICS = [
  ['Sider med engelsk skabelon i title/beskrivelse', (s) => s.areas.titlesAndMeta.pagesWithEnglishTemplate.length, 'down'],
  ['Sider med forkert domæne i title', (s) => s.areas.titlesAndMeta.pagesWithWrongBrandInTitle.length, 'down'],
  ['Sider uden meta-beskrivelse', (s) => s.areas.titlesAndMeta.missingDescription.length, 'down'],
  // null, not 0, when the area is absent: an older snapshot did not measure this,
  // and reporting that as zero turns "we started counting" into "+3, well done".
  ['Planlagte landingssider der findes', (s) => s.areas.landingPages?.live ?? null, 'up'],
  ['Sider med hreflang i <head>', (s) => s.areas.hreflang.pagesWithHeadHreflang, 'up'],
  // The post-sitemap also carries the blog index page, so this is one higher than the
  // number of actual articles in the table further down. Labelled to match.
  ['URL\'er i post-sitemap (inkl. blogoversigten)', (s) => s.areas.content.blogPosts, 'up'],
  ['Blogindlæg med egen tekst', (s) => (s.areas.content.blogPostDetail ?? []).length, 'up'],
  ['Kategorier med egen SEO-tekst', (s) => s.areas.content.categoriesWithOwnCopy?.length ?? 0, 'up'],
  ['Kategorier uden egen tekst', (s) => s.areas.content.categoriesWithThinCopy?.length ?? 0, 'down'],
  ['Blogindlæg uden links til kategori/produkt', (s) => (s.areas.content.blogPostDetail ?? []).filter((p) => !p.commercialLinks?.length).length, 'down'],
  ['Billeder uden alt-tekst (%)', (s) => s.areas.images.emptyAltPct, 'down'],
  ['Ødelagte sitemaps', (s) => s.areas.indexation.brokenSitemaps.length, 'down'],
  ['Kurv/kasse/konto i sitemap', (s) => s.areas.indexation.junkUrlsInSitemap.length, 'down'],
  ['Sitemap-henvisning i robots.txt', (s) => (s.areas.indexation.robots.hasSitemapDirective ? 1 : 0), 'up'],
  ['Produkt-kategori-sitemap findes', (s) => (s.areas.indexation.hasCategorySitemap ? 1 : 0), 'up'],
  ['Produkter med brand i schema', (s) => s.areas.schema.withBrand, 'up'],
  ['Produkter med anmeldelser i schema', (s) => s.areas.schema.withRating, 'up'],
  ['Sider med BreadcrumbList', (s) => s.areas.schema.withBreadcrumb, 'up'],
  ['Produktnavne forurenet af title-tag', (s) => s.areas.schema.nameContaminatedWithTitle.length, 'down'],
  ['TTFB median (ms)', (s) => s.areas.performance.ttfbMedianMs, 'down'],
  ['TTFB p90 (ms)', (s) => s.areas.performance.ttfbP90Ms, 'down'],
  ['Sider med sprogskifter-links til .eu/.de/.fr', (s) => s.areas.linking.pagesLeakingToSiblingDomains.length, 'down'],
  ['Sider uden H1', (s) => s.areas.headings.pagesWithoutH1.length, 'down'],
];

function deltaCell(now, before, good, hasPrev) {
  if (now === null || now === undefined) return '—';
  // No previous snapshot at all is a different thing from a previous snapshot
  // that did not carry this metric — the second one must not read as progress.
  if (before === null || before === undefined) return hasPrev ? 'ny måling' : '—';
  const d = now - before;
  if (d === 0) return 'uændret';
  const better = good === 'up' ? d > 0 : d < 0;
  return `${d > 0 ? '+' : ''}${d} ${better ? '✅' : '⚠️'}`;
}

const changes = existsSync(join(DATA, 'changes.jsonl'))
  ? (await readFile(join(DATA, 'changes.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const inWindow = prev ? changes.filter((c) => c.date > prevDate && c.date <= date) : [];

const cfg = existsSync(join(DATA, 'config.json'))
  ? JSON.parse(await readFile(join(DATA, 'config.json'), 'utf8'))
  : {};
const siteName = cfg.siteName ?? new URL(cur.site).host;

const a = cur.areas;
const L = [];
L.push(`# ${siteName} — teknisk SEO-status ${date}`);
L.push('');
L.push(`**Site:** ${cur.site} · **Sider scannet:** ${cur.pagesScanned} · **Kørt:** ${cur.scannedAt}`);
L.push(prev ? `**Sammenlignet med:** ${prevDate}` : '**Første måling — intet at sammenligne med.**');
L.push('');
L.push('> Alt herunder er maskinelt målt på offentligt tilgængelige sider. Ingen adgange, ingen tredjepartsværktøjer.');
if (!prev && cfg.baselineNote) L.push(`> ${cfg.baselineNote}`);
L.push('');

L.push('## Nøgletal');
L.push('');
L.push(`| Måling | ${date} | ${prevDate ?? 'før'} | Ændring |`);
L.push('|---|---:|---:|---|');
for (const [label, fn, good] of METRICS) {
  const now = fn(cur);
  const before = prev ? fn(prev) : null;
  L.push(`| ${label} | ${now ?? '—'} | ${before ?? '—'} | ${deltaCell(now, before, good, Boolean(prev))} |`);
}
L.push('');

if (prev) {
  L.push('## Hvad blev der lavet i perioden');
  L.push('');
  if (!inWindow.length) {
    L.push('_Intet logget i `changes.jsonl`. Bevæger tallene sig alligevel, er ændringen sket uden om os — find ud af hvem og få den logget, ellers kan fremgangen ikke tilskrives noget._');
  } else {
    L.push('| Dato | Af | Område | Hvad |');
    L.push('|---|---|---|---|');
    for (const c of inWindow) L.push(`| ${c.date} | ${c.by} | ${c.area} | ${c.what} |`);
  }
  L.push('');
}

L.push('## Detaljer');
L.push('');

if (a.landingPages?.planned) {
  L.push('### Planlagte landingssider');
  L.push(`${a.landingPages.live} af ${a.landingPages.planned} sider fra søgeordsplanen findes. En side der ikke er der, kan ikke placere sig — derfor står tallet øverst.`);
  L.push('');
  if (a.landingPages.missing.length) {
    L.push(`**Mangler (${a.landingPages.missing.length}):** ${a.landingPages.missing.map((p) => `\`${p}\``).join(', ')}`);
    L.push('');
  }
  if (a.landingPages.underAnotherUrl?.length) {
    L.push(`**Findes under en anden URL end planen siger:** ${a.landingPages.underAnotherUrl.map((r) => `\`${r.path}\` → \`${r.to.replace(cur.site, '')}\``).join(', ')} — enten skal planen rettes, eller siden skal flyttes.`);
    L.push('');
  }
  if (a.landingPages.thin?.length) {
    L.push(`**Findes, men næsten uden egen tekst:** ${a.landingPages.thin.map((t) => `\`${t.path}\` (~${t.ownWords} ord)`).join(', ')}`);
    L.push('');
  }
}

L.push(`### Titles og beskrivelser`);
L.push(`Forsidens title: \`${a.titlesAndMeta.homepageTitle}\``);
L.push('');
if (a.titlesAndMeta.pagesWithEnglishTemplate.length) {
  const byField = (f) => a.titlesAndMeta.pagesWithEnglishTemplate.filter((p) => p.fields.includes(f));
  L.push(`**${a.titlesAndMeta.pagesWithEnglishTemplate.length} sider kører stadig en engelsk Rank Math-skabelon** — ${byField('title').length} i title, ${byField('description').length} i meta-beskrivelsen. Bemærk at en side godt kan have en pæn dansk title og alligevel være med her; det er så beskrivelsen der er engelsk. Eksempler med den tekst der udløste det:`);
  L.push('');
  for (const p of a.titlesAndMeta.pagesWithEnglishTemplate.slice(0, 8)) {
    L.push(`- \`${p.url.replace(cur.site, '')}\` (${p.fields.join(' + ')}) — "${p.evidence}"`);
  }
  L.push('');
}
if (a.titlesAndMeta.pagesWithWrongBrandInTitle.length) {
  L.push(`**Forkert domæne i title på ${a.titlesAndMeta.pagesWithWrongBrandInTitle.length} sider:**`);
  for (const p of a.titlesAndMeta.pagesWithWrongBrandInTitle.slice(0, 8)) L.push(`- \`${p.url}\` — "${p.title}"`);
  L.push('');
}

if (a.titlesAndMeta.missingDescription.length) {
  L.push(`Uden meta-beskrivelse: ${a.titlesAndMeta.missingDescription.map((u) => `\`${u.replace(cur.site, '')}\``).join(', ')}`);
  L.push('');
}
if (a.headings.pagesWithoutH1.length) {
  L.push(`Uden H1: ${a.headings.pagesWithoutH1.map((u) => `\`${u.replace(cur.site, '')}\``).join(', ')}`);
  L.push('');
}

L.push('### Internationalt (hreflang)');
L.push(a.hreflang.pagesWithHeadHreflang === 0
  ? 'Ingen hreflang i HTML-head på nogen scannet side. De fire domæner peger ikke på hinanden for Google.'
  : `hreflang fundet på ${a.hreflang.pagesWithHeadHreflang} sider.`);
L.push('');
L.push(`**www-varianten:** \`https://www.museliving.dk/\` → \`${a.wwwRedirect.landsOn}\`${a.wwwRedirect.leavesDanishDomain ? ' — den sender dansk trafik væk fra det danske domæne.' : '.'}`);
L.push('');

L.push('### Indeksering');
L.push(`- Produkt-kategori-sitemap: ${a.indexation.hasCategorySitemap ? 'findes ✅' : 'mangler ⚠️'}`);
L.push(`- Sitemap-henvisning i robots.txt: ${a.indexation.robots.hasSitemapDirective ? 'ja ✅' : 'nej ⚠️'} (Crawl-delay: ${a.indexation.robots.crawlDelay ?? 'ingen'})`);
if (a.indexation.brokenSitemaps.length) L.push(`- Ødelagte sitemaps: ${a.indexation.brokenSitemaps.map((u) => `\`${u}\``).join(', ')}`);
if (a.indexation.junkUrlsInSitemap.length) L.push(`- Ligger i sitemap men burde ikke: ${a.indexation.junkUrlsInSitemap.map((u) => `\`${u}\``).join(', ')}`);
if (a.indexation.uncategorised) L.push(`- \`/category/ukategoriseret/\` svarer ${a.indexation.uncategorised.status}${a.indexation.uncategorised.flags.noindex ? ' (noindex ✅)' : ' og er indekserbar ⚠️'}`);
L.push('');

L.push('### Strukturerede data');
L.push(`- Produkter undersøgt: ${a.schema.productsSampled} — med brand: ${a.schema.withBrand}, med anmeldelser: ${a.schema.withRating}`);
L.push(`- Sider med BreadcrumbList: ${a.schema.withBreadcrumb}`);
L.push(`- Forsidens schema-typer: ${a.schema.homepageTypes.join(', ') || 'ingen'}`);
if (a.schema.nameContaminatedWithTitle.length) {
  L.push(`- Produktnavnet i schema er title-tagget, ikke produktnavnet, på ${a.schema.nameContaminatedWithTitle.length} produkter, fx:`);
  for (const p of a.schema.nameContaminatedWithTitle.slice(0, 4)) L.push(`  - "${p.name}"`);
}
L.push('');

L.push('### Billeder');
L.push(`${a.images.emptyAlt + a.images.missingAlt} af ${a.images.totalImgs} billeder (${a.images.emptyAltPct}%) mangler alt-tekst på de scannede sider.`);
L.push('');

L.push('### Indhold');
L.push(`- Blogindlæg i sitemap: ${a.content.blogPosts}${a.content.newestBlogLastmod ? ` (nyeste ændring ${a.content.newestBlogLastmod.slice(0, 10)})` : ''}`);
L.push(`- Standardtekst pr. side anslået til ~${a.content.boilerplateWords} ord; "egen tekst" måles oven på det.`);
if (a.content.categoriesWithOwnCopy?.length) {
  L.push(`- Kategorier med egen SEO-tekst (${a.content.categoriesWithOwnCopy.length}):`);
  for (const c of a.content.categoriesWithOwnCopy.slice(0, 10)) L.push(`  - \`${c.url}\` — ~${c.ownWords} ord`);
}
if (a.content.categoriesWithThinCopy?.length) {
  L.push(`- Kategorier **uden** egen tekst (${a.content.categoriesWithThinCopy.length}): ${a.content.categoriesWithThinCopy.map((c) => `\`${c.url.replace(cur.site, '')}\``).join(', ')}`);
}
if (a.content.chatGptArtifactPages.length) L.push(`- ChatGPT-kopirester (\`data-start\`) stadig i HTML på: ${a.content.chatGptArtifactPages.map((u) => `\`${u}\``).join(', ')}`);
L.push('');

if (a.content.blogPostDetail?.length) {
  L.push('### Bloggen, indlæg for indlæg');
  L.push('');
  L.push('Der bliver produceret blogindhold på sitet lige nu. "Egne links" tæller kun links som ikke står i menu og footer — altså dem indlægget selv har sat — og "kommercielle" dem af dem, der peger på en kategori- eller produktside. Et indlæg der ikke linker videre, sælger ikke noget.');
  L.push('');
  L.push('| Indlæg | Egne ord | H2 | Egne links | heraf kommercielle | Meta-beskrivelse |');
  L.push('|---|---:|---:|---:|---:|---|');
  for (const p of a.content.blogPostDetail) {
    L.push(`| \`${p.url.replace(cur.site, '')}\` | ${p.ownWords} | ${p.h2Count} | ${p.bodyLinks ?? '—'} | ${p.commercialLinks?.length ?? '—'} | ${p.hasDescription ? 'ja' : '**nej**'} |`);
  }
  L.push('');
}

L.push('### Hastighed');
L.push(`- TTFB median ${a.performance.ttfbMedianMs} ms, p90 ${a.performance.ttfbP90Ms} ms, median HTML ${a.performance.medianHtmlKb} KB`);
if (a.performance.slowPages.length) {
  L.push(`- Sider over 2 s (cache-miss):`);
  for (const p of a.performance.slowPages.slice(0, 8)) L.push(`  - \`${p.url.replace(cur.site, '')}\` — ${p.ms} ms (cache: ${p.cache ?? 'ukendt'})`);
}
L.push('');

if (a.linking.pagesLeakingToSiblingDomains.length) {
  L.push('### Linkning til søsterdomænerne');
  const to = a.linking.pagesLeakingToSiblingDomains[0].to;
  L.push(`Alle ${a.linking.pagesLeakingToSiblingDomains.length} scannede sider har sprogskifteren, og den peger på ${to.map((u) => `\`${u}\``).join(', ')} — altså forsiden af hvert domæne, ikke den tilsvarende side. ${a.linking.xdomainTokenLinks} links bærer WPML's \`?xdomain_data=\`-parameter.`);
  L.push('Sammen med at der ikke findes hreflang betyder det, at Google ikke får at vide hvilke sider på tværs af de fire domæner der svarer til hinanden. Tallet her falder ikke af sig selv; det er hreflang-rækken ovenfor der er kuren.');
  L.push('');
}

// A tracker that has never been reported on has no reports/ — the first run on a
// new project must create it rather than fall over.
await mkdir(join(DATA, 'reports'), { recursive: true });
const out = join(DATA, 'reports', `site-${date}.md`);
await writeFile(out, L.join('\n') + '\n');
console.log(out);
