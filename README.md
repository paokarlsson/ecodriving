# Bromsfri körning

Webbapp som säger till när du ska släppa gasen, så att bilen rullar ner till rätt fart före trafikljus, kurvor, rondeller och sänkta hastighetsgränser – utan att bromsen behövs.

> **Bromsen används alltid vid behov.** Appen planerar bara för det som finns på kartan, inte för bilen framför, fotgängare, köer eller ljus som byter.

## Så fungerar det

1. **Rutt** hämtas med höjddata från OpenRouteService (`api.heigit.org/openrouteservice/v2/...`).
2. **Vägdata** längs rutten hämtas från OpenStreetMap via Overpass: `maxspeed`, trafikljus, stopp- och väjningsplikt och rondeller.
   - Rutten delas i rutor på ca 500 m som sparas i telefonen i 30 dagar. De första 3 km hämtas först i egna, små anrop; därefter går Starta att trycka på och resten hämtas i bakgrunden. När den kommer läggs trafikljus och gränser längre fram till i den pågående körningen (händelsen `osm-complete` i körloggen).
   - Har början inte kommit inom 15 s (t.ex. när alla servrar hänger) går det ändå att starta, med bara kurvor; vägdata läggs till om den kommer.
   - Anropen sprids över tre Overpass-servrar, upp till tre samtidigt. Svarar en server inte inom 5 s (2,5 s för början av rutten), eller svarar med fel, skickas samma fråga till nästa server och första svaret används.
3. **Fartmål** byggs: trafikljus/stopplikt = 0, väjningsplikt ≈ 20 km/h, rondell ≈ 25 km/h, kurva = √(a_lat · R), ny lägre gräns = gränsen.
4. **Fysikmodell** för rullning med släppt gas: `a(v, s) = A + C·v² + g·θ(s)`, där θ är lutningen ur ruttens höjddata. A och C kommer från ett rullprov. Utan rullprov används typvärden från en verklig bil (A = 0,15 m/s², C = 0,00025 1/m: ca 0,2 m/s² vid 70 km/h och 0,3 m/s² vid 110 km/h på plan väg).
5. **Släpp-punkt**: appen räknar baklänges från varje fartmål. Det mål som kräver tidigast släpp styr, och signalen ges 1–2 s (reaktionsmarginal) före släpp-punkten.

## Kom igång

- Öppna sidan i Chrome (Android) eller Safari (iPhone) och välj *Lägg till på hemskärmen*.
- Skapa en gratis nyckel på [account.heigit.org](https://account.heigit.org) och klistra in den i appen. Nyckeln sparas bara i telefonens webbläsare (`localStorage`) och skickas bara till `api.heigit.org`.
- **Dela med vänner:** en länk med nyckeln som parameter, `https://<användare>.github.io/<repo>/?key=DIN_NYCKEL` (eller `#key=…`), sparar nyckeln i mottagarens telefon och tas sedan bort ur adressfältet. Knappen *Dela appen med nyckeln* under Inställningar skapar länken. Alla som använder länken delar på nyckelns dagskvot.
- Gör ett **rullprov** (Inställningar → Kalibrering): i växel, ca 80 → 30 km/h på rak, plan väg, en gång i varje riktning.
- Utan nyckel fungerar kalibreringen och den korta **testbanan**, som simulerar en körning i fyrdubbel fart.

## Kurvor och släpvagn

- **Kurvradien** räknas hörn för hörn i ruttens linje: varje hörn får den största båge som ryms i linjens geometri (avviker högst 5 m från hörnet och får plats på halva sträckorna till grannhörnen). Glest ritade hörn blir då mjuka kurvor som på den verkliga vägen, tätt ritade kurvor får sin riktiga radie och tvära korsningar förblir skarpa. Kurvor med mindre än 150 m emellan slås ihop.
- **Rekommenderad kurvfart** räknas ur kurvradien och vald sidokraft (standard 0,25 g; 1 g = 9,81 m/s²). Över 50 km/h sänks sidokraften gradvis till 65 % vid 110 km/h.
- **Släpvagnsläge** (bockruta på hemskärmen, i ruttöversikten eller i Inställningar): skyltad gräns men högst 80 km/h. Sidokraft, rullmodell och inlärning är desamma som utan släp.

## Uppmätt kurvkraft (gyro)

- Gyrot mäter bilens vridhastighet kring lodlinjen (oberoende av hur telefonen sitter); sidokraften är `a = v · ω` med farten från GPS.
- Under kurvan visas en mätare med uppmätt mot planerad sidokraft. Sammanfattningen visar varje kurva med kurvradie (R, från kartan) och, när kurvan är mätt, radien bilen faktiskt körde (`kört`, fart delat med vridhastighet vid toppen), och markerar dem där toppen var mer än 15 % över planerat. Appen ställer inga frågor och sidokraften ändras bara i Inställningar.
- Telefoner anger gyrots axlar, enheter och tecken olika (en inspelning visade en webbläsare som lade x-rotationen i `alpha`). Appen lär sig därför vilken kombination av gyrots tre axlar som är "sväng": gyrots vridning summeras mellan två GPS-positioner och jämförs med GPS-kursens ändring (eller ruttens, om kursen saknas) över samma tid, med minsta kvadrat över intervallen. Det kräver ungefär en minuts körning med några svängar och sparas till nästa körning. Att jämföra mätvärde för mätvärde fungerar inte, eftersom GPS-kursen kommer en gång i sekunden och ligger efter. Stötar över ca 70°/s ignoreras.
- Accelerometern (med tyngdkraft, tyngdkraften utjämnad över 20 s) ger en kontroll: i tydliga kurvor ska den visa ungefär samma sidokraft som gyrot. Skiljer de sig mer än en faktor 2–2,5 i fem kurvor varnar appen för lös hållare. Accelerometerns topp per kurva loggas (`accPeakG`).
- Kurvor där gyrot och kartan inte stämmer (t.ex. lös hållare) räknas inte.

## Rullmodellen lär sig under körning

Varje rullning efter en släpp-signal blir ett litet rullprov. Appen hittar rullningen i GPS-farten, klipper bort början (foten lämnar gasen), slutet och allt efter gas (farten ökar) eller broms (inbromsning 0,8 m/s² mer än modellen två sekunder i rad, eller en ihållande stöt i accelerometern). Inbromsningen korrigeras för backen med ruttens höjddata.

Rena rullningar (minst 5 s och 4 km/h, 30–110 km/h, god GPS) vägs ihop med rullprovet: rullprovet väger som ca 7 rullningar och en rullning som högst 3 mätpunkter, så modellen ändras gradvis. Rullningar som bromsar mycket mer än modellen sorteras bort (broms). Rullningar som är lättare än väntat godkänns, eftersom bilar som frikopplar när gasen släpps rullar så; bara en rullning som inte tappar någon fart på plan väg (lutningen borträknad) sorteras bort, eftersom den betyder gas eller fel höjddata. Rullningar som inte börjar vid en släpp-signal loggas men räknas inte, eftersom en halv gaslättning annars skulle se ut som en lätt rullning. Av/på och återställning under Inställningar → Kalibrering.

## Körlogg (JSON)

Varje körning och rullprov sparas i telefonen (de 10 senaste). Under Inställningar → Data → *Visa körloggar*, eller från sammanfattningen:

- **Kopiera för analys**: kompakt JSON, en mätpunkt var 5:e sekund och alla händelser (ca 40 kB per timme), att klistra in i en chatt.
- **Spara fil / Dela**: samma sak med alla mätpunkter (en per sekund).

Innehåll: `kind` (`drive` | `calibration`), `dest`, `trailer`, `settings`, `model` (A, C och källa), `route` (längd, andel med känd gräns, fartmål och kurvor), `stats`, `events` och `samples`.
`samples.rows` har fälten i `samples.fields`: `t` (s från start), `s` (m längs rutten), `lat`, `lon`, `kmh`, `acc` (GPS-noggrannhet, m), `mode`, `limit` (km/h), `g` (sidokraft), `side` (sidokraft med tecken, positiv = trycker åt höger), `rel` (m till släpp-signal), `alt` (m).
Händelser: `coast` (rullning: sträcka, tid, fart, medelinbromsning, avvikelse från modellen, om den användes och varför inte), `release`, `follow`, `reached`, `pause`, `resume`, `offroute`, `reroute`, `curve` (planerad mot uppmätt sidokraft, radie, svängvinkel gyro/karta), `arrived`, `stopped`; för rullprov `cue`, `done`, `failed` och resultatet i `stats`.

## Testbana

Den korta testbanan (på sidan Koppla OpenRouteService, under fältet för nyckeln) kräver ingen nyckel. En simulerad bil kör den i fyrdubbel fart; knappen i körvyn ändrar farten (1×, 4×, 8×, 16×). Appen lär sig inte av testkörningar.

## Rådata och inspelning utan rutt

Varje riktig körning sparar också all rådata i telefonens databas (IndexedDB, eftersom localStorage bara rymmer ca 5 MB):

| Data | Fält | Frekvens |
| --- | --- | --- |
| GPS | `t, lat, lon, alt, acc, altAcc, speed, heading` | varje position (ca 1/s) |
| Rörelse | `t, ax, ay, az` (utan tyngdkraft), `gx, gy, gz` (med tyngdkraft), `alpha, beta, gamma` (gyro, grader/s) | varje sensorhändelse (ca 50–60/s) |
| Kompass | `t, heading` | varje händelse |
| API | ruttsvaret (koordinater med höjd, sträcka, tid) och vägdatan från Overpass | vid planering och ny rutt |

`t` är sekunder sedan starten. *Spara fil* / *Dela* i körloggarna ger loggen med rådatan under `raw`; *Kopiera för analys* är som förut kompakt utan rådata. Rådatan raderas tillsammans med sin logg, och de 10 senaste loggarna sparas.

**Spela in körning utan rutt** (hemskärmen): bara loggning, inga signaler. Visar tid, sträcka, GPS-noggrannhet, antal punkter, sensorfrekvens och sidokraft; gyrots axel lärs in mot GPS-kursen.

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
| `js/rawstore.js` | Rådata (GPS, gyro, accelerometer, kompass, API-svar) i IndexedDB |
| `js/logbook.js` | Körlogg som JSON och lagring av de senaste loggarna |
| `js/coastlearn.js` | Rullningar under körning: hitta, rensa och väga ihop till A och C |
| `js/lateral.js` | Gyro → sidokraft, kurvföljning och inlärning |
| `js/trailer.js` | Släpvagnsläge: högst 80 km/h |
| `js/demo.js`, `js/sim.js` | Testbana och simulerade bilar |

## Publicering

`.github/workflows/pages.yml` kör testerna och publicerar appen på GitHub Pages vid push till `main`. Aktivera en gång under *Settings → Pages → Source: GitHub Actions*.

## Kända begränsningar (version 1)

- Bilar som rullar i växel med motorbroms. Friläge, elbilar/hybrider med regenerering och OBD-II ingår inte.
- Trafikljusens fas är okänd, så appen räknar alltid som om det är rött.
- Stopp- och väjningsplikt-noder på korsande vägar kan ibland hamna på rutten om de ligger inom 10 m från den.
- Följsamhet i sammanfattningen mäts med GPS-farten (fartminskning efter signalen), inte med accelerometern.
- Ingen ”fri körning” – en rutt måste väljas före start.

Vägdata © OpenStreetMap-bidragsgivare.
