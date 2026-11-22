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

- **Kurvradien** räknas hörn för hörn i ruttens linje: varje hörn får den största båge som ryms i linjens geometri (avviker högst 5 m från hörnet och får plats på halva sträckorna till grannhörnen). Glest ritade hörn blir då mjuka kurvor som på den verkliga vägen, tätt ritade kurvor får sin riktiga radie och tvära korsningar förblir skarpa. Kurvor med mindre än 150 m emellan slås ihop.
- **Rekommenderad kurvfart** räknas ur kurvradien och vald sidokraft (standard 0,25 g; 1 g = 9,81 m/s²). Över 50 km/h sänks sidokraften gradvis till 65 % vid 110 km/h.
- **Släpvagnsläge** (hemskärmen, ruttöversikten eller Inställningar): skyltad gräns men högst 80 km/h (inställbart, t.ex. 40 km/h för tung obromsad släpvagn), sidokraft 0,18 g i kurvor och en egen kalibrering. Utan rullprov med släpet uppskattas modellen från bilens värden.

## Uppmätt kurvkraft (gyro)

- Gyrot mäter bilens vridhastighet kring lodlinjen (oberoende av hur telefonen sitter); sidokraften är `a = v · ω` med farten från GPS.
- Under kurvan visas en mätare med uppmätt mot planerad sidokraft. Var toppen mer än 15 % över planerat frågar appen efter kurvan, på rak väg: *Okej* eller *För mycket*. Obesvarade frågor finns i sammanfattningen.
- Svaren justerar sidokraften: *För mycket* sänker direkt till strax under uppmätt, *Okej* höjer 30 % av vägen men högst 0,02 g per svar. Bil och släp lär sig var för sig.
- Telefoner anger gyrots axlar, enheter och tecken olika. Appen lär sig därför vilken kombination av gyrots tre axlar som är "sväng" genom att jämföra med hur rutten svänger (minsta kvadrat, kräver några sekunders kurvkörning) och sparar den till nästa körning. Stötar över ca 70°/s ignoreras.
- Kurvor där gyrot och kartan inte stämmer (t.ex. lös hållare) räknas inte.

## Rullmodellen lär sig under körning

Varje rullning efter en släpp-signal blir ett litet rullprov. Appen hittar rullningen i GPS-farten, klipper bort början (foten lämnar gasen), slutet och allt efter gas (farten ökar) eller broms (inbromsning 0,8 m/s² mer än modellen två sekunder i rad, eller en ihållande stöt i accelerometern). Inbromsningen korrigeras för backen med ruttens höjddata.

Rena rullningar (minst 5 s och 4 km/h, 30–110 km/h, god GPS) vägs ihop med rullprovet: rullprovet väger som ca 7 rullningar och en rullning som högst 3 mätpunkter, så modellen ändras gradvis. Rullningar som avviker mycket från modellen sorteras bort: lättare än väntat (troligen friläge) eller tyngre (broms). Rullningar som inte börjar vid en släpp-signal loggas men räknas inte, eftersom en halv gaslättning annars skulle se ut som en lätt rullning. Bil och släp lär sig var för sig. Av/på och återställning under Inställningar → Kalibrering.

## Körlogg (JSON)

Varje körning och rullprov sparas i telefonen (de 10 senaste). Under Inställningar → Data → *Visa körloggar*, eller från sammanfattningen:

- **Kopiera för analys**: kompakt JSON, en mätpunkt var 5:e sekund och alla händelser (ca 40 kB per timme), att klistra in i en chatt.
- **Spara fil / Dela**: samma sak med alla mätpunkter (en per sekund).

Innehåll: `kind` (`drive` | `calibration`), `dest`, `trailer`, `settings`, `model` (A, C och källa), `route` (längd, andel med känd gräns, fartmål och kurvor), `stats`, `events` och `samples`.
`samples.rows` har fälten i `samples.fields`: `t` (s från start), `s` (m längs rutten), `lat`, `lon`, `kmh`, `acc` (GPS-noggrannhet, m), `mode`, `limit` (km/h), `g` (sidokraft), `side` (sidokraft med tecken, positiv = trycker åt höger), `rel` (m till släpp-signal), `alt` (m).
Händelser: `coast` (rullning: sträcka, tid, fart, medelinbromsning, avvikelse från modellen, om den användes och varför inte), `release`, `follow`, `reached`, `pause`, `resume`, `offroute`, `reroute`, `curve` (planerad mot uppmätt sidokraft, radie, svängvinkel gyro/karta), `answer`, `arrived`, `stopped`; för rullprov `cue`, `done`, `failed` och resultatet i `stats`.

## Demorutter

Hemskärmen har färdiga demorutter mellan riktiga platser (Östersund–Brunflo, Åre–Duved, Slussen–Solna, Lindholmen–Mölndal, Uppsala–Sigtuna). Första gången hämtas rutten med användarens egen nyckel och sparas i telefonen; vägdatan sparas i den vanliga cachen. Sedan kör en simulerad förare rutten (`RealCar` i `js/sim.js`): egen fartmarginal kring gränsen, mjuk acceleration med begränsat ryck, kurvor nära rekommenderad fart, bekväm inbromsning, följer släpp-signaler efter 0,8–1,6 s men inte alltid, trafikljus som är röda eller gröna slumpvis, GPS- och gyrobrus och rullegenskaper som avviker lite från appens modell. Farten ändras med knappen i körvyn (1×, 4×, 8×, 16×). Appen lär sig inte av demokörningar. Den korta testbanan kräver ingen nyckel.

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
| `js/logbook.js` | Körlogg som JSON och lagring av de senaste loggarna |
| `js/coastlearn.js` | Rullningar under körning: hitta, rensa och väga ihop till A och C |
| `js/lateral.js` | Gyro → sidokraft, kurvföljning och inlärning |
| `js/trailer.js` | Släpvagnsläge: maxfart och uppskattad rullmodell |
| `js/demo.js`, `js/demoroutes.js`, `js/sim.js` | Testbana, demorutter på riktiga vägar och simulerade bilar |

## Publicering

`.github/workflows/pages.yml` kör testerna och publicerar appen på GitHub Pages vid push till `main`. Aktivera en gång under *Settings → Pages → Source: GitHub Actions*.

## Kända begränsningar (version 1)

- Bilar som rullar i växel med motorbroms. Friläge, elbilar/hybrider med regenerering och OBD-II ingår inte.
- Trafikljusens fas är okänd, så appen räknar alltid som om det är rött.
- Stopp- och väjningsplikt-noder på korsande vägar kan ibland hamna på rutten om de ligger inom 10 m från den.
- Följsamhet i sammanfattningen mäts med GPS-farten (fartminskning efter signalen), inte med accelerometern.
- Ingen ”fri körning” – en rutt måste väljas före start.

Vägdata © OpenStreetMap-bidragsgivare.
