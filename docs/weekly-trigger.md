# Den ugentlige trigger

Agentics-platformen har ingen scheduler. Der er ikke noget cron-felt på en linje, en
station eller et projekt — jobs opstår kun når nogen opretter en opgave. Så fredagen
skal komme udefra.

Det er ikke et hul der skal lukkes for at få det her til at virke; det er bare et sted,
triggeren skal bo. Den naturlige plads er den maskine der i forvejen kører runneren.

## systemd-timer på runner-maskinen (anbefalet)

Runneren er allerede registreret på projektet, og `pks agentics task submit` genbruger
den registrerings-token. Der skal altså ikke opbevares en ekstra hemmelighed.

`/etc/systemd/system/seo-ugerapport.service`:

```ini
[Unit]
Description=Opret ugens SEO-rapport-opgave

[Service]
Type=oneshot
User=poul
ExecStart=/usr/local/bin/pks agentics task submit \
  --assembly-line-url https://agentics.dk/p/OWNER/PROJEKT/assembly-lines/LINJE-ID \
  --title "SEO-ugerapport uge %%V" \
  --description "Ugentlig kørsel." \
  --priority medium
```

`/etc/systemd/system/seo-ugerapport.timer`:

```ini
[Unit]
Description=SEO-ugerapport hver fredag

[Timer]
OnCalendar=Fri 07:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now seo-ugerapport.timer
systemctl list-timers seo-ugerapport.timer
```

`Persistent=true` betyder at en fredag hvor maskinen var slukket, indhentes ved næste
opstart. Det er det man vil have: rapporten er ugentlig, ikke punktlig.

## Alternativ: GitHub Actions

Hvis man hellere vil have triggeren til at bo hos GitHub, tager opgave-endpointet også
et OIDC-token fra Actions, hvor audience er samlebåndets URL. Så skal der ingen token
opbevares nogen steder:

```yaml
on:
  schedule:
    - cron: '0 7 * * 5'
permissions:
  id-token: write
```

Det kræver til gengæld at runneren stadig kører på maskinen, ellers ligger opgaven bare
og venter i `todo`. Timeren på runner-maskinen fejler mere ærligt: er maskinen nede,
kommer opgaven slet ikke.
