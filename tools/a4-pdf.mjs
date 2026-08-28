#!/usr/bin/env node
// Trykker ugens A4 til PDF med den delte browser, ikke med en browser i containeren.
//
// `a4-report.mjs` sætter HTML'en; det her er det sidste skridt, hvor den bliver til
// noget man kan sende videre. Pointen er hvor Chromium står: pks-agent-browser kører
// én delt Chromium på Coolify-nettet, så stationens container slipper for at
// installere en ved hver ugentlig provisionering. Kaldet sender **HTML'en selv**
// (`html`, ikke `url`), så dokumentet aldrig behøver at ligge offentligt for at
// kunne trykkes.
//
//   node a4-pdf.mjs --data …                    # nyeste ugerapport
//   node a4-pdf.mjs --data … --date 2026-08-28
//
// Adgangen kommer helst fra føderationen. Kører det her som et job på en linje,
// har runneren allerede givet os `AGENTICS_TOKEN` og `AGENTICS_JOB_ID`, og
// platformen veksler dem til et 5-minutters token udstedt til netop denne
// browser-service — samme model som npm's trusted publishers. Så er der ingen
// langlivet hemmelighed i containeren overhovedet, og ejeren styrer adgangen ét
// sted, i sin tillidsbinding hos browser-servicen.
//
//   BROWSER_URL     fx https://browser.agentics.dk  (den eneste der er påkrævet)
//   BROWSER_TOKEN   statisk API-token, reserven når vi ikke kører som et job
//                   (BROWSER_API_TOKEN accepteres også)
//
// Er der hverken det ene eller det andet, springes trinnet over med besked og
// exit 0: HTML'en er stadig gyldig, og linjen skal kunne køre på et projekt uden
// browser-service.
//
// Afhængighedsfri som resten af tools/: `fetch` er indbygget fra Node 18.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const DATA = arg('data', ROOT);
const WEEKLY = join(DATA, 'weekly');

const die = (msg) => { console.error(msg); process.exit(1); };

// Et manglende opsætningsvalg er ikke en fejl i ugens arbejde. Skriv hvorfor, og
// lad stationen fortsætte — den nævner selv i rapporten at PDF'en mangler.
const skip = (msg) => { console.log(`A4-PDF sprunget over: ${msg}`); process.exit(0); };

// En variabel der stadig står som `${localEnv:…}` er en devcontainer-substitution der
// ikke skete. Behandl den som tom, ellers sender vi teksten som token, får 401, og et
// opsætningsproblem ligner en fejl i ugens arbejde.
const env = (name) => {
    const v = process.env[name];

    return !v || /^\$\{.*\}$/.test(v.trim()) ? '' : v;
};

const base = env('BROWSER_URL').replace(/\/+$/, '');
if (!base) skip('BROWSER_URL er ikke sat.');

// Veksler runnerens jobtoken til et kortlivet token udstedt til præcis denne
// modtager. Platformen tjekker selv at runneren sidder på et aktivt job på en
// station; browser-servicen tjekker bagefter at ejeren har bundet linjen til
// `browser:render`. Går noget af det galt, siger vi hvad — og prøver reserven.
async function federatedToken() {
    const agentics = env('AGENTICS_BASE_URL').replace(/\/+$/, '');
    const runnerToken = env('AGENTICS_TOKEN');
    const jobId = env('AGENTICS_JOB_ID');
    const owner = env('AGENTICS_OWNER');
    const project = env('AGENTICS_PROJECT_NAME');
    if (!agentics || !runnerToken || !jobId || !owner || !project) return null;

    const url = `${agentics}/api/owners/${encodeURIComponent(owner)}/projects/${encodeURIComponent(project)}/federation/token`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${runnerToken}` },
        body: JSON.stringify({ audience: base, scope: ['browser:render'], jobId }),
    }).catch((e) => {
        console.log(`Kunne ikke nå ${url}: ${e.message}`);

        return null;
    });
    if (!res) return null;
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.log(`Fødereret token afvist (${res.status}): ${detail.slice(0, 200)}`);

        return null;
    }

    const body = await res.json().catch(() => ({}));

    return body.access_token || null;
}

const federated = await federatedToken();
const token = federated || env('BROWSER_TOKEN') || env('BROWSER_API_TOKEN');
if (!token) skip('hverken fødereret veksling eller BROWSER_TOKEN er tilgængelig.');

let date = arg('date', null);
if (!date) {
    const found = (await readdir(WEEKLY).catch(() => []))
        .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})-a4\.html$/)?.[1])
        .filter(Boolean)
        .sort();
    if (!found.length) die(`Ingen A4-HTML i ${WEEKLY}. Kør a4-report.mjs først.`);
    date = found.at(-1);
}

const htmlPath = join(WEEKLY, `${date}-a4.html`);
const outPath = join(WEEKLY, `${date}-a4.pdf`);

const html = await readFile(htmlPath, 'utf8')
    .catch((e) => die(`Kan ikke læse ${htmlPath}: ${e.message}\nKør a4-report.mjs først.`));

// `format: "pdf"` printer med `printBackground`, så panelernes farver kommer med, og
// papirstørrelsen kommer fra `@page` i skabelonen. `return: "base64"` fordi vi vil have
// filen på disk i repoet — artifact-store'en i servicen er en 24-timers cache, ikke et arkiv.
const body = JSON.stringify({
    html,
    format: 'pdf',
    return: 'base64',
    waitForFonts: true,
    labels: { tool: 'alp-seo-report', doc: 'a4', date },
});

const res = await fetch(`${base}/v1/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body,
}).catch((e) => die(`Kan ikke nå browser-servicen på ${base}: ${e.message}`));

if (!res.ok) {
    const detail = await res.text().catch(() => '');
    die(`${base}/v1/render svarede ${res.status}: ${detail.slice(0, 400)}`);
}

const result = await res.json();
if (!result.base64) die(`Uventet svar fra /v1/render: ${JSON.stringify(result).slice(0, 400)}`);

const buf = Buffer.from(result.base64, 'base64');

// Et tomt eller afkortet svar ville skrive en fil der ligner en PDF i mappen og fejler
// først når nogen åbner den. Tjek de fire bytes.
if (buf.subarray(0, 4).toString('latin1') !== '%PDF') die('Svaret var ikke en PDF.');

await writeFile(outPath, buf);
console.log(`${outPath} (${buf.length} bytes, ${result.ms} ms, ${federated ? 'fødereret' : 'BROWSER_TOKEN'})`);
