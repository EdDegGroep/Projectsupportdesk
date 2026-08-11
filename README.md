# Deg Supportdesk

Interne ticketing tool voor de Deg supportdesk. Draait als zelfstandige website op GitHub Pages, zonder eigen server. Alle tickets staan in één gedeeld databestand (`data/tickets.json`) in deze repository: iedereen die zich aanmeldt ziet dezelfde stand, elke wijziging wordt als versie bewaard in de Git-geschiedenis, en de beheerder kan het databestand op elk moment downloaden.

## Installatie (eenmalig, ± 10 minuten)

### 1. Repository aanmaken

1. Maak op GitHub een nieuwe **private** repository aan, bijvoorbeeld `deg-supportdesk`.
2. Upload alle bestanden uit deze map: `index.html`, `app.js`, `.nojekyll`, en de map `data/` met `tickets.json`.

> Let op: bij een private repository heeft GitHub Pages een betaald plan nodig (Pro/Team). Werkt dat niet, kies dan een publieke repository — de **data** blijft dan óók publiek zichtbaar, dus doe dat alleen als er geen gevoelige klantinformatie in tickets komt. Voor een interne desk met klantdata: private repo + GitHub Team.

### 2. GitHub Pages aanzetten

1. Ga in de repository naar **Settings → Pages**.
2. Kies bij *Source*: **Deploy from a branch**, branch `main`, map `/ (root)`.
3. Na een minuut staat de desk op `https://<organisatie>.github.io/deg-supportdesk/`.

### 3. Teamsleutel (token) aanmaken

De tool schrijft tickets naar `data/tickets.json` via de GitHub API. Daarvoor is een token nodig:

1. Ga naar **GitHub → Settings (profiel) → Developer settings → Fine-grained personal access tokens → Generate new token**.
2. Naam: `deg-supportdesk`. Vervaldatum: bijvoorbeeld 1 jaar.
3. Bij *Repository access*: **Only select repositories** → kies alléén `deg-supportdesk`.
4. Bij *Permissions → Repository permissions*: zet **Contents** op **Read and write**. Verder niets.
5. Genereer en kopieer het token (`github_pat_…`).

Deel dit token via een veilig kanaal (wachtwoordmanager, niet per mail) met de collega's die de desk gebruiken.

### 4. Aanmelden

Iedere collega opent de URL, vult één keer naam + teamsleutel in, en is klaar. De aanmelding blijft op het apparaat bewaard; daarna opent de desk direct met de gedeelde teamdata. Bij de allereerste aanmelding maakt de tool het databestand automatisch aan als het nog ontbreekt.

## Beheer

- **Databestand downloaden** — tab *Beheer* in de tool, of rechtstreeks `data/tickets.json` uit de repository. Dat bestand is de complete administratie.
- **Geschiedenis** — elke wijziging is een commit ("Supportdesk: bijgewerkt door …"). Via de GitHub-historie van `data/tickets.json` is elke eerdere stand terug te halen.
- **Back-up terugzetten** — tab *Beheer* → *Databestand terugzetten*. Overschrijft de gedeelde data voor iedereen.
- **Token intrekken** — verwijder het token in GitHub Developer settings; niemand kan dan nog schrijven tot er een nieuwe sleutel is gedeeld.

## Hoe gelijktijdig werken werkt

De tool ververst automatisch elke minuut en bij een druk op *Verversen*. Slaan twee mensen tegelijk op, dan voegt de tool beide wijzigingen samen op ticketniveau (nieuwste wijziging per ticket wint) en schrijft het resultaat terug. Verwijderde tickets blijven verwijderd, ook als een collega ze net daarvoor nog zag.

## Goed om te weten

- De teamsleutel staat na aanmelding in de browser van de gebruiker (localStorage) en geeft schrijftoegang tot alléén deze repository. Voor een interne desk is dat een bewuste, beheersbare keuze; zet er geen bredere rechten op.
- De tool draait volledig in de browser; er is geen eigen server en er gaat niets naar andere partijen dan GitHub.
- Werkt de verbinding even niet, dan blijft de desk bruikbaar op de laatst bekende stand; wijzigingen worden opgeslagen zodra de verbinding terug is (mits de pagina open blijft).
