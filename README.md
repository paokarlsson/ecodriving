# Bromsfri körning

Webbapp som säger till när du ska släppa gasen, så att bilen rullar ner till rätt fart före trafikljus, kurvor, rondeller och sänkta hastighetsgränser – utan att bromsen behövs.

> **Bromsen används alltid vid behov.** Appen planerar bara för det som finns på kartan, inte för bilen framför, fotgängare, köer eller ljus som byter.

## Så fungerar det

1. **Rutt** hämtas med höjddata från OpenRouteService (`api.heigit.org/openrouteservice/v2/...`).
2. **Vägdata** längs rutten hämtas från OpenStreetMap via Overpass: `maxspeed`, trafikljus, stopp- och väjningsplikt och rondeller.
3. **Fartmål** byggs: trafikljus/stopplikt = 0, väjningsplikt ≈ 20 km/h, rondell ≈ 25 km/h, kurva = √(a_lat · R), ny lägre gräns = gränsen.
4. **Fysikmodell** för rullning med släppt gas: `a(v, s) = A + C·v² + g·θ(s)`. A och C kommer från ett rullprov.
5. **Släpp-punkt**: appen räknar baklänges från varje fartmål. Det mål som kräver tidigast släpp styr, och signalen ges 1–2 s (reaktionsmarginal) före släpp-punkten.

## Kom igång

- Öppna sidan i Chrome (Android) eller Safari (iPhone) och välj *Lägg till på hemskärmen*.
- Skapa en gratis nyckel på [account.heigit.org](https://account.heigit.org) och klistra in den i appen. Nyckeln sparas bara i telefonens webbläsare (`localStorage`) och skickas bara till `api.heigit.org`.
- Gör ett **rullprov** (Inställningar → Kalibrering): i växel, ca 80 → 30 km/h på rak, plan väg, en gång i varje riktning.
- Utan nyckel fungerar kalibreringen och **demorutten**, som simulerar en körning i fyrdubbel fart.

## Kurvor och släpvagn

- **Rekommenderad kurvfart** räknas ur kurvradien och vald sidokraft (standard 0,25 g; 1 g = 9,81 m/s²). Över 50 km/h sänks sidokraften gradvis till 65 % vid 110 km/h.
- **Släpvagnsläge** (hemskärmen, ruttöversikten eller Inställningar): skyltad gräns men högst 80 km/h (inställbart, t.ex. 40 km/h för tung obromsad släpvagn), sidokraft 0,18 g i kurvor och en egen kalibrering. Utan rullprov med släpet uppskattas modellen från bilens värden.

## Utveckling

Ingen byggprocess – rena ES-moduler.

```sh
npm test          # enhetstester (node --test)
npm start         # http://localhost:8080 (sensorer och GPS kräver HTTPS eller localhost)
```

| Fil | Innehåll |
| --- | --- |
| `js/physics.js` | Modellen, baklängesintegrering, släpp-punkt, anpassning av A och C |
| `js/route.js` | Omsampling (10 m), lutning, kartmatchning, kurvfart |
| `js/osm.js` | Overpass-frågor, `maxspeed`, fartmål |
| `js/calibration.js` | Rullprovets inspelning, kvalitetskontroll och beräkning |
| `js/drive.js` | Körmotorn: väljer styrande mål, signaler, pausning, statistik |
| `js/api.js` | OpenRouteService (rutt, geokodning) och Open-Meteo (höjd) |
| `js/sensors.js`, `js/audio.js`, `js/mapview.js` | Webbläsarens sensorer, ljud/röst, karta på canvas |
| `js/app.js` | Vyer och flöden |
| `js/trailer.js` | Släpvagnsläge: maxfart och uppskattad rullmodell |
| `js/demo.js`, `js/sim.js` | Syntetisk demorutt och simulerad bil |

## Publicering

`.github/workflows/pages.yml` kör testerna och publicerar appen på GitHub Pages vid push till `main`. Aktivera en gång under *Settings → Pages → Source: GitHub Actions*.

## Kända begränsningar (version 1)

- Bilar som rullar i växel med motorbroms. Friläge, elbilar/hybrider med regenerering och OBD-II ingår inte.
- Trafikljusens fas är okänd, så appen räknar alltid som om det är rött.
- Stopp- och väjningsplikt-noder på korsande vägar kan ibland hamna på rutten om de ligger inom 10 m från den.
- Följsamhet i sammanfattningen mäts med GPS-farten (fartminskning efter signalen), inte med accelerometern.
- Ingen ”fri körning” – en rutt måste väljas före start.

Vägdata © OpenStreetMap-bidragsgivare.
