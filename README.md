# alp-seo-report

En ALP-samlebåndslinje der måler et websites tekniske SEO-tilstand hver uge og skriver
en rapport et menneske gider læse: **bevæger vi os mod målet, hvad har ændret sig siden
sidst, hvad går godt, og hvad bør rettes.**

Linjen er sitet-uafhængig. Alt det site-specifikke — hvad der måles, hvad målet er,
historikken — ligger i det projekt linjen importeres på. Det her repo er værktøjet.

## Importér den

På agentics.dk, med repoet allerede udfyldt:

```
https://agentics.dk/import?repo=https://github.com/pksorensen/alp-seo-report
```

Vælg projektet, importér. Linjen har tre stationer og der skal ikke sættes noget op i
dem: **Ugerapport** er den der arbejder — opgaven lander der, og kun der kører der et
job. **Rapport klar** og **Fejlet** er endestationer uden trigger; opgaven flyttes selv
dertil af linjens to overgange, alt efter om jobbet melder `success` eller `failure`.
Det er hele pointen med at have tre kolonner: tavlen skal kunne svare på "kørte den, og
gik det godt" uden at nogen åbner et job.

Melder jobbet hverken det ene eller det andet — timeout, idle timeout, afbrudt session —
flytter platformen **ikke** opgaven. Den bliver stående på `Ugerapport` med sin
konklusion på kortet, og det er det rigtige signal: agenten nåede aldrig at fælde en dom,
så rapporten kan ikke antages skrevet. Derfor har stationen også besked på altid at
afslutte med `stop_broadcast`, og derfor står dens idle timeout på 30 minutter — scanningen
er tavs i 10-15 minutter ad gangen, og runnerens standard på 2 minutter slår den ihjel
midt i arbejdet.

Importen læser repoet uden token, så linje-repoet skal være offentligt.

Importen tilbyder to ting, begge tændt fra start: en **startopgave**, så den første
rapport kører med det samme, og en **tidsplan** — hver fredag kl. 07:00 dansk tid.

Projektet skal have et git-repo tilknyttet (`gitUrl`), for det er dét repo jobbet
kloner og skriver rapporten tilbage til.

## Hvad projektet skal indeholde

En tracker-mappe — navnet er lige meget, stationen finder den — med:

| Fil | Skal den være der | Hvad den gør |
|---|---|---|
| `config.json` | **ja** | Hvilket site, hvilke sider, hvilke mønstre der tælles som fejl. Feltet `site` er det stationen genkender mappen på. |
| `goal.md` | anbefalet | Det ugerapportens executive summary dømmer imod. Uden den kan stationen ikke svare "bevæger vi os mod målet" og siger det i stedet ligeud. |
| `changes.jsonl` | anbefalet | Én linje pr. udført ændring. Det er den eneste kobling mellem en bevægelse i tallene og en årsag — uden den kan fremgang ikke tilskrives nogen. |
| `templates/a4.html` | nej | Projektets egen A4-skabelon. Findes den, sætter stationen ugens etsides-status i den; findes den ikke, springes trinet over. Design og brand hører til i data-repoet, ikke her — se nedenfor. |
| `snapshots/`, `reports/`, `weekly/` | nej | Oprettes af kørslen. |

### config.json

```json
{
  "site": "https://example.dk",
  "siteName": "Example",
  "crawlDelayMs": 10000,
  "userAgent": "…",
  "moneyPages": ["/", "/category/…/"],
  "plannedLandingPages": ["/den-side-planen-kræver/"],
  "productSampleSize": 15,
  "junkSitemapPaths": ["/kurv/", "/kasse/"],
  "englishTemplateMarkers": ["Buy Online", "Wide selection of"],
  "wrongBrandMarkers": ["example.eu"],
  "siblings": ["https://example.eu"],
  "brandDomains": ["example.dk", "example.eu"]
}
```

`plannedLandingPages` er de sider søgeordsplanen kræver. De scannes selv om de svarer
404 — at siden ikke findes endnu *er* målingen, og som regel den vigtigste.

## Kør det i hånden

```bash
node tools/scan-site.mjs  --data /sti/til/tracker    # ~10 min, honorerer Crawl-delay
node tools/report-site.mjs --data /sti/til/tracker   # → reports/site-<dato>.md
node tools/a4-report.mjs   --data /sti/til/tracker   # → weekly/<dato>-a4.html
node tools/a4-pdf.mjs      --data /sti/til/tracker   # → weekly/<dato>-a4.pdf
```

Ingen npm-afhængigheder, Node 20+. Scanneren er ren HTTP GET mod offentlige sider.

## A4'en

Markdown-rapporten er journalen; A4'en er den man sender videre. Den blev tegnet i
hånden den første uge og ville blive et nyt dokument hver gang en agent tegnede den
forfra — så layoutet er frosset i data-repoet og ugen leverer kun ordene:

| | Hvor | Hvem skriver den |
|---|---|---|
| Designet | `<tracker>/templates/a4.html` | mennesker, sjældent |
| Ugens indhold | `<tracker>/weekly/<dato>-a4.json` | stationen, hver uge |
| Resultatet | `<tracker>/weekly/<dato>-a4.html` | `a4-report.mjs` |
| Trykket | `<tracker>/weekly/<dato>-a4.pdf` | `a4-pdf.mjs`, via den delte browser |

Skabelonen er almindelig HTML med `{{felt}}`, `{{#liste}}…{{/liste}}` og `{{^tom}}…{{/tom}}`.
Et `{{felt}}` uden værdi er en fejl der stopper kørslen — en halvt udfyldt A4 ser færdig
ud og er forkert. Et afsnit uden værdi er derimod bare udeladt: sektionerne *er*
mekanismen for et valgfrit felt. Værdier bliver escaped, og `**sådan**` er den eneste
markup der slipper igennem.

PDF'en trykkes af `a4-pdf.mjs`, og det afgørende er hvor Chromium står: den kalder
[pks-agent-browser](https://browser.agentics.dk), én delt browser som service, i stedet
for at installere en i stationens container ved hver ugentlige provisionering. Kaldet
sender **HTML'en selv** (`html`, ikke `url`), så dokumentet aldrig behøver at ligge
offentligt for at kunne trykkes, og `@page { size: A4 portrait }` i skabelonen bestemmer
papiret.

Trinnet kræver `BROWSER_URL` og `BROWSER_TOKEN` i stationens miljø. Mangler de, springes
det over med exit 0 — HTML'en er stadig gyldig, og linjen skal kunne køre på et projekt
uden browser-service.

## Ugentlig kørsel

Tidsplanen står i `.agentics/init.json` og sættes op af importen. Platformen opretter
selv opgaven hver fredag kl. 07:00 `Europe/Copenhagen` — der skal ikke installeres cron
eller systemd-timer nogen steder.

Den kan ses og ændres under `Assembly line → Settings → Schedule`, hvor der også er en
**Run now**-knap der kører den samme vej som fredagen gør, uden at bruge ugens kørsel op.

Runneren skal stadig køre på projektet: platformen laver opgaven, runneren laver
arbejdet. Se `docs/weekly-trigger.md` — også for hvordan triggeren i stedet kan bo i
en systemd-timer eller i GitHub Actions, hvis fredagen skal afhænge af andet end klokken.

## Hvad den ikke måler

Placeringer, klik og trafik. Der er ingen Search Console-, analytics- eller
rank-tracking-integration, og stationen har besked på at skrive det i hver rapport.
En ugerapport der lyder som om den kender placeringerne, ødelægger attributionen.
