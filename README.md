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

Vælg projektet, importér. Linjen har én station, `Ugerapport`; der skal ikke sættes noget
op i den. Importen læser repoet uden token, så linje-repoet skal være offentligt.

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
```

Ingen npm-afhængigheder, Node 20+. Scanneren er ren HTTP GET mod offentlige sider.

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
