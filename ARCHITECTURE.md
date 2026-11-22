# Parkera – arkitektur (testversion v0.6)

## Mål för testversionen
Skriv in en adress → få tre val → tryck **Kör** → navigeringen startar i Apple Maps / Google Maps / Waze.

1. **Till målet** – kör direkt till adressen
2. **Närmaste parkering** – närmaste publika parkering (avgift eller gratis)
3. **Närmaste gratisparkering** – närmaste parkering utan avgift

Plus en lista med fler parkeringar som kan filtreras på avstånd och gratis/avgift.

## Översikt

```
 Telefon / dator (webbläsare, installerbar som app – PWA)
 ┌──────────────────────────────────────────────────────┐
 │  index.html + app.js (UI)                            │
 │  core.js  (ren logik: normalisera, ranka, länkar)    │
 │  sources.js (hämtar data)                            │
 └───────┬───────────────┬───────────────┬──────────────┘
         │ adress→koord  │ parkeringar   │ (valfritt)
         ▼               ▼               ▼
   Nominatim/Photon   OpenStreetMap   Göteborgs Stads
   (OSM-geokodning)   Overpass API    ParkingService API
                                       (kräver gratis APPID)
         │
         ▼  "Kör"
   Djuplänk → Apple Maps / Google Maps / Waze (gör själva navigationen)
```

## Viktiga beslut

| Beslut | Val | Varför |
|---|---|---|
| Plattform | Webbapp (PWA) | En kodbas för iPhone, Android och dator. Kan läggas på hemskärmen. Ingen App Store i testfasen. |
| Hosting | GitHub Pages (statiskt) | Gratis, HTTPS, nås från alla enheter. Ingen server att drifta. |
| Navigation | Djuplänkar till befintliga kartappar | Att bygga egen sväng-för-sväng-navigation är enormt; kartapparna gör det redan bäst. |
| Parkeringsdata v0.1 | OpenStreetMap (Overpass) | Gratis, ingen nyckel, täcker Göteborg, har `fee=yes/no`, `maxstay`, `capacity`. |
| Kommunal data | Göteborgs ParkingService (valfritt) | Officiell data: gratis tidsparkering på gatan + avgiftsparkering. Kräver APPID. |
| Beläggning | Visas om datakällan har fältet | Ingen öppen realtidskälla finns; kommer via partneravtal i v2. |
| Ramverk | Vanilla JS + MapLibre GL | Inget byggsteg. Vektorkarta från OpenFreeMap (gratis, ingen nyckel), färgsatt som Apple Kartor i mapstyle.js. |

## Datamodell (internt)
```js
{ id, name, lat, lon, source: 'osm'|'gbg',
  fee: 'free'|'paid'|'unknown', price, maxStay, capacity, freeSpaces,
  access: 'public'|'customers', operator, distance /* meter från målet */ }
```

## Kända begränsningar i v0.1
- OSM saknar ofta pris och avgiftstider → "okänd avgift" förekommer.
- "Gratis" kan vara tidsbegränsat eller gälla vissa tider – kontrollera alltid skylten.
- Göteborgs API blockerar vanliga anrop från webbläsaren (CORS) – löst med JSONP, som API:t stöder. Om även det fallerar kör appen vidare på OSM.
- Lediga platser från Göteborg visas bara om uppgiften är högst 30 min gammal.
- Ingen betalning i appen ännu.

## Väg framåt
- **v0.2** (klar): Göteborgs Stads data via JSONP, nyckeltest, nyckel via länk.
- **v0.3** (klar): sökförslag medan man skriver (Photon), resultat visas så fort första källan svarar, Overpass-speglar parallellt + cache, "Jag stannar"-val med kostnadsberäkning, maxtid och P-förbud (rules.js), kort 2 aldrig dubblett.
- **v0.4** (klar): "Parkera här" (GPS), ankomsttid, betala-knapp med zonkod, delning, Cloudflare Worker (worker/) som håller nyckeln åt alla.
- **v0.5** (klar): p-hus/anläggningar (PrivateTollParkings) och pendelparkeringar (CommuterParkings) från Göteborgs API; Parkering Göteborg öppnas via iPhone-genväg.
- **v0.6** (klar): Apple-lik vektorkarta (ljust/mörkt läge), parkeringsytor som gröna konturer (Göteborgs WKT i SWEREF 99, OSM-ytor), mörkt läge för hela appen.
- **senare**: Cloudflare Worker som cache/proxy så att användare inte behöver egen nyckel.
- **v0.3**: Avgiftstider/zoner → korrekt "gratis just nu".
- **v1**: Beläggning via operatörspartner, betalning via partner-API, ev. native app (CarPlay/Android Auto).
