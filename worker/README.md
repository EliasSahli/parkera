# Parkeras server (Cloudflare Worker)

Låter alla använda Göteborgs Stads data utan egen nyckel. Gratis upp till 100 000 anrop per dag.

## Lägg upp (ca 5 minuter, i webbläsaren)
1. Skapa ett gratis konto på https://dash.cloudflare.com/sign-up
2. **Workers & Pages → Create → Create Worker** → namn: `parkera` → **Deploy**.
3. **Edit code** → ta bort allt → klistra in hela `worker.js` → **Deploy**.
4. Gå tillbaka till workern → **Settings → Variables and Secrets → Add**
   - Type: **Secret**, Name: `GBG_APPID`, Value: din nyckel från data.goteborg.se → **Deploy**.
5. Kopiera workerns adress, t.ex. `https://parkera.DITTNAMN.workers.dev`
6. Kontrollera: öppna `https://parkera.DITTNAMN.workers.dev/health` – ska visa `{"ok":true,"key":true}`.
7. Skicka adressen till Claude, som lägger in den i `config.js`. (Eller ändra `PROXY_URL` själv.)

## Säkerhet
- Nyckeln ligger bara som hemlighet i Cloudflare, aldrig i koden eller webbläsaren.
- Servern svarar bara för koordinater i Göteborgsområdet och bara till appens adress.
- Svar cachas 60 sekunder, så att samma sökning inte belastar Göteborgs API.
