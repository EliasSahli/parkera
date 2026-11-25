# Parkera – testversion 0.1

Skriv in vart du ska → få **Till målet**, **Närmaste parkering** och **Närmaste gratis** → tryck **Kör** så startar navigationen i Apple Kartor, Google Maps eller Waze.

Arkitektur: se [ARCHITECTURE.md](ARCHITECTURE.md).

## Lägg upp på GitHub Pages (ca 5 min, gratis)
1. Logga in på github.com → **New repository** → namn `parkera` → Public → Create.
2. Klicka **uploading an existing file** och dra in alla filer och mappar från zip-filen (inte själva zip-filen).
3. **Commit changes**.
4. **Settings → Pages → Branch: main / (root) → Save**.
5. Efter ~1 minut finns appen på `https://<ditt-användarnamn>.github.io/parkera/`.

På iPhone: öppna länken i Safari → Dela → **Lägg till på hemskärmen**. Då beter den sig som en app.

## Göteborgs Stads data (rekommenderat)
Ger kommunal gratis gatuparkering med tidsgräns, avgiftsparkering med pris och ibland antal lediga platser.

1. Gå till https://data.goteborg.se/Account/Register.aspx och skapa ett konto.
2. Logga in → fliken **Mina applikationer** → **Lägg till applikation** → ge den ett namn (t.ex. "Parkera") → **Spara**.
3. Kopiera nyckeln som visas under Mina applikationer.
4. I appen: ⚙︎ → klistra in nyckeln → **Testa** → **Klar**.

Nyckeln sparas bara i din webbläsare. För att slippa klistra på varje enhet: öppna en gång
`https://<användarnamn>.github.io/parkera/?appid=DIN-NYCKEL` på den nya enheten.
Nyckeln sparas och försvinner sedan ur adressfältet.

Tekniskt: webbläsaren blockerar vanliga anrop till data.goteborg.se (CORS), så appen hämtar via JSONP,
som API:t stöder. Ingen egen server behövs.

## Nattlig Göteborgsdata (rekommenderat)
`.github/workflows/gbg-snapshot.yml` hämtar all Göteborgsdata varje natt till `data/gbg.json`.
Appen läser den filen först, så sökningen går direkt och ingen behöver en egen nyckel.

Engångsinställning: repo → **Settings → Secrets and variables → Actions → New repository secret**,
namn `GBG_APPID`, värde = din nyckel. Kör sedan jobbet en gång: **Actions → Göteborgsdata (nattlig) → Run workflow**.

**Laddplatser (NOBIL):** lägg till en till secret med namnet `NOBIL_KEY` och din NOBIL-nyckel som värde. Nattjobbet hämtar då laddstationerna och sparar dem i `data/nobil/`. Enligt NOBIL:s villkor får nyckeln och API-anropen inte synas i appen, så appen läser bara de färdiga filerna. Datan är NOBIL by Enova, CC BY 4.0, och källraden visas i appens sidfot.

## Låt vänner använda Göteborgs data utan nyckel (äldre alternativ)
Lägg upp den lilla servern i `worker/` (instruktioner i `worker/README.md`, ca 5 min, gratis)
och sätt adressen i `config.js`. Tills dess: Dela-knappen under ⚙︎ kan ta med din nyckel i länken.

## Utveckling
```
npm test                     # enhetstester för logiken
python3 -m http.server 8000  # kör lokalt på http://localhost:8000
```
