#!/usr/bin/env node
// Renders the week's one-page A4 status from the tracker's own design template.
//
// The markdown report is the record; this is the thing you hand to someone. It was
// hand-built the first week (2026-08-16) and would drift into a different document
// every time an agent redrew it — so the layout is frozen in the tracker's template
// and the week only supplies the words:
//
//   <data>/templates/a4.html          the design, owned by the project (brand, palette)
//   <data>/weekly/<date>-a4.json      this week's slots, written by the station
//   <data>/weekly/<date>-a4.html      the output
//
//   node a4-report.mjs --data …                    # newest weekly report
//   node a4-report.mjs --data … --date 2026-08-28
//
// Dependency-free on purpose, like the rest of tools/: the station's container has
// Node and nothing else. The HTML carries `@page { size: A4 portrait }`, so printing
// it to PDF from a browser is a one-click step — we do not ship a headless renderer.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

// Same contract as scan-site.mjs / report-site.mjs: --data is the tracker directory
// in the measured project's own repository.
const DATA = arg('data', ROOT);
const WEEKLY = join(DATA, 'weekly');

const die = (msg) => { console.error(msg); process.exit(1); };

let date = arg('date', null);
if (!date) {
    const found = (await readdir(WEEKLY).catch(() => []))
        .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
        .filter(Boolean)
        .sort();
    if (!found.length) die(`Ingen ugerapporter i ${WEEKLY}. Kør report-site.mjs først.`);
    date = found.at(-1);
}

const slotsPath = join(WEEKLY, `${date}-a4.json`);
const templatePath = join(DATA, 'templates', 'a4.html');
const outPath = join(WEEKLY, `${date}-a4.html`);

const slots = await readFile(slotsPath, 'utf8')
    .then(JSON.parse)
    .catch((e) => die(`Kan ikke læse ${slotsPath}: ${e.message}\nStationen skal skrive den fil, før A4'en kan sættes.`));
const template = await readFile(templatePath, 'utf8')
    .catch((e) => die(`Kan ikke læse skabelonen ${templatePath}: ${e.message}`));

// ---------------------------------------------------------------------------
// A deliberately small template language: escaped `{{key}}`, `{{#key}}…{{/key}}`
// for arrays and optional blocks, `{{^key}}` for the absent case. Nothing else —
// the moment this needs conditionals or filters, the design has grown a second
// personality and belongs in the template rather than in the data.
// ---------------------------------------------------------------------------

const missing = [];

const escape = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// The slots are plain text so the JSON stays reviewable, but the design leans on a
// bolded clause in almost every paragraph. `**…**` is the only markup allowed in,
// and it is applied after escaping, so no slot can inject a tag.
const render = (value) => escape(value).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

// `required` is false for section keys: `{{#note}}` and `{{^note}}` *are* the
// mechanism for an optional slot, so an absent one is an answer, not an omission.
// A bare `{{key}}` has no such reading — reaching one with nothing behind it means
// the station left a hole in the document.
function lookup(scope, key, path, required) {
    for (let i = scope.length - 1; i >= 0; i--) {
        const frame = scope[i];
        if (frame && typeof frame === 'object' && key in frame) return frame[key];
    }
    if (required) missing.push(`${path}${key}`);

    return undefined;
}

function expand(tpl, scope, path = '') {
    const section = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;

    let out = tpl;
    let m;
    while ((m = out.match(section))) {
        const [whole, kind, key, body] = m;
        const value = lookup(scope, key, path, false);
        let replacement = '';

        if (kind === '^') {
            if (!value || (Array.isArray(value) && !value.length)) replacement = expand(body, scope, path);
        } else if (Array.isArray(value)) {
            replacement = value
                .map((item, i) => expand(body, [...scope, { ...item, index1: i + 1 }], `${path}${key}[${i}].`))
                .join('');
        } else if (value && typeof value === 'object') {
            replacement = expand(body, [...scope, value], `${path}${key}.`);
        } else if (value) {
            replacement = expand(body, scope, path);
        }

        out = out.slice(0, m.index) + replacement + out.slice(m.index + whole.length);
    }

    return out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
        const value = lookup(scope, key, path, true);

        return value === undefined || value === null ? '' : render(value);
    });
}

const html = expand(template, [{ date, ...slots }]);

// A half-filled brand document is worse than none: it looks finished and is wrong.
if (missing.length) {
    die(`Skabelonen mangler felter i ${slotsPath}:\n  ${[...new Set(missing)].join('\n  ')}`);
}

await writeFile(outPath, html);
console.log(`Skrev ${outPath}`);
