# Den ugentlige trigger

Fredagen kommer fra platformen selv. Linjen medbringer sin egen tidsplan i
`.agentics/init.json`, og importen på agentics.dk tilbyder den — tændt som
udgangspunkt:

```json
"schedule": {
  "name": "Ugentlig SEO-rapport",
  "cadence": { "kind": "weekly", "weekday": "friday", "hour": 7, "minute": 0, "timeZone": "Europe/Copenhagen" },
  "task": { "title": "SEO-ugerapport", "description": "…" }
}
```

Der skal altså ikke installeres noget på runner-maskinen. Platformen opretter
opgaven i linjens første station på det aftalte tidspunkt og sender den videre
til en runner, præcis som hvis nogen havde klikket den frem i hånden.

## Sådan ser du og ændrer den

`Projekt → Assembly line → Settings → Schedule`. Der står næste kørsel og
seneste kørsel, og der er fire knapper: **Run now**, **Edit**, **Delete** og en
tænd/sluk-kontakt.

**Run now** kører den samme vej som fredagen gør — samme opgave, samme station,
samme udsendelse. Det er derfor den er værd at trykke på: virker den, virker
fredagen. Den bruger ikke ugens planlagte kørsel op.

Tidszonen er en rigtig IANA-zone, ikke et timetal. `Europe/Copenhagen` betyder
07:00 på det ur der hænger på væggen, også ugen efter en sommertidsomstilling.

## Hvad platformen gør, og hvad den ikke gør

- **Misset fredag indhentes én gang.** Var serveren nede kl. 07:00, kører den så
  snart den er oppe igen — og går derefter videre til næste fredag. Ingen bunke
  af indhentede kørsler. Er slottet mere end 36 timer gammelt, springes det over.
- **En kørsel der stadig er i gang, blokerer den næste.** Så vokser der ikke en
  kø af scanninger oven på hinanden. Tidsplanen venter, og fyrer så snart den
  forrige er færdig.
- **Platformen laver opgaven — runneren laver arbejdet.** Kører der ingen runner
  på projektet, bliver opgaven oprettet og bliver liggende. Det er synligt på
  linjen, men det sker ikke noget.
- **Slukket tidsplan skylder ikke noget.** Tænder du den igen, tælles der fra nu.

## Diskplads på runner-maskinen

Runneren kloner projektets repo til `/tmp/pks-runner-tasks/<taskId>`, og `taskId` er ny
hver gang. Det er en fuld arbejdskopi pr. kørsel, som ikke ryddes op af sig selv. Med et
repo i hundredmegabyte-klassen og en kørsel om ugen er det et par gigabyte om året — og
ligger `/tmp` på en tmpfs, er det RAM.

Kør derfor runneren et sted hvor `/tmp` er disk, og ryd op. En `tmpfiles.d`-regel er nok:

```
d /tmp/pks-runner-tasks 0755 poul poul 14d
```

## Hvis triggeren hellere skal bo et andet sted

Platformens tidsplan er den korte vej, men opgave-endpointet er stadig åbent, og
en trigger udefra er den rigtige løsning hvis fredagen skal afhænge af noget
andet end klokken — en deploy, en import, et andet system.

**systemd-timer på runner-maskinen.** Runneren er allerede registreret på
projektet, og `pks agentics task submit` genbruger den registrerings-token, så
der skal ikke opbevares en ekstra hemmelighed:

```ini
# /etc/systemd/system/seo-ugerapport.service
[Service]
Type=oneshot
User=poul
ExecStart=/usr/local/bin/pks agentics task submit \
  --assembly-line-url https://agentics.dk/p/OWNER/PROJEKT/assembly-lines/LINJE-ID \
  --title "SEO-ugerapport uge %%V" \
  --priority medium
```

```ini
# /etc/systemd/system/seo-ugerapport.timer
[Timer]
OnCalendar=Fri 07:00
Persistent=true

[Install]
WantedBy=timers.target
```

**GitHub Actions.** Opgave-endpointet tager også et OIDC-token fra Actions, hvor
audience er samlebåndets URL — så skal der ingen token opbevares nogen steder:

```yaml
on:
  schedule:
    - cron: '0 7 * * 5'
permissions:
  id-token: write
```

Kører du en af delene, så sluk platformens tidsplan i Settings. Ellers kommer der
to opgaver hver fredag.
