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

- Öppna sidan i Chrome (Android) eller Safari (iPhone) och installera den. På Android och i Chrome/Edge på datorn visar startsidan en knapp *Installera*; på iPhone visar den hur man väljer *Dela → Lägg till på hemskärmen*. Samma ruta finns under Inställningar så länge appen inte är installerad. Installerad startar appen i helskärm och öppnas utan täckning.
- Skapa en gratis nyckel på [account.heigit.org](https://account.heigit.org) och klistra in den i appen. Nyckeln sparas bara i telefonens webbläsare (`localStorage`) och skickas bara till `api.heigit.org`.
- **Dela med vänner:** en länk med nyckeln som parameter, `https://<användare>.github.io/<repo>/?key=DIN_NYCKEL` (eller `#key=…`), sparar nyckeln i mottagarens telefon och tas sedan bort ur adressfältet. Knappen *Dela appen med nyckeln* under Inställningar skapar länken. Alla som använder länken delar på nyckelns dagskvot.
- Gör ett **rullprov** (Inställningar → Kalibrering): i växel, ca 80 → 30 km/h på rak, plan väg, en gång i varje riktning.
- Utan nyckel fungerar kalibreringen och den korta **testbanan**, som simulerar en körning i fyrdubbel fart.

## Sökning

- Söker i Sverige via OpenRouteService adressökning (Pelias): adresser, orter, byar och namngivna platser i OpenStreetMap. Kategorier som "bensinstation" fungerar inte.
- Medan man skriver (från 3 tecken, efter en kort paus) används `autocomplete`, som klarar början av ord. Sök-knappen gör en vanlig sökning med upp till 10 träffar.
- Varje träff visar typ (adress, ort, plats …) och avstånd fågelvägen från din position.

## Kurvor

- **Kurvradien** räknas hörn för hörn i ruttens linje: varje hörn får den största båge som ryms i linjens geometri (avviker högst 5 m från hörnet och får plats på halva sträckorna till grannhörnen). Glest ritade hörn blir då mjuka kurvor som på den verkliga vägen, tätt ritade kurvor får sin riktiga radie och tvära korsningar förblir skarpa. Kurvor med mindre än 150 m emellan slås ihop.
- **Rekommenderad kurvfart** räknas ur kurvradien och vald sidokraft (standard 0,25 g; 1 g = 9,81 m/s²). Över 50 km/h sänks sidokraften gradvis till 65 % vid 110 km/h.

## Uppmätt kurvkraft (gyro)

- Gyrot mäter bilens vridhastighet kring lodlinjen (oberoende av hur telefonen sitter); sidokraften är `a = v · ω` med farten från GPS.
- Under kurvan visas en mätare med uppmätt mot planerad sidokraft. Sammanfattningen visar varje kurva med kurvradie (R, från kartan) och, när kurvan är mätt, radien bilen faktiskt körde (`kört`, fart delat med vridhastighet vid toppen), och markerar dem där toppen var mer än 15 % över planerat. Appen ställer inga frågor och sidokraften ändras bara i Inställningar.
- Telefoner anger gyrots axlar, enheter och tecken olika (en inspelning visade en webbläsare som lade x-rotationen i `alpha`). Appen lär sig därför vilken kombination av gyrots tre axlar som är "sväng": gyrots vridning summeras mellan två GPS-positioner och jämförs med GPS-kursens ändring (eller ruttens, om kursen saknas) över samma tid, med minsta kvadrat över intervallen. Det kräver ungefär en minuts körning med några svängar och sparas till nästa körning. Att jämföra mätvärde för mätvärde fungerar inte, eftersom GPS-kursen kommer en gång i sekunden och ligger efter. Stötar över ca 70°/s ignoreras.
- Accelerometern (med tyngdkraft, tyngdkraften utjämnad över 20 s) ger en kontroll: i tydliga kurvor ska den visa ungefär samma sidokraft som gyrot. Skiljer de sig mer än en faktor 2–2,5 i fem kurvor varnar appen för lös hållare. Accelerometerns topp per kurva loggas (`accPeakG`).
- Kurvor där gyrot och kartan inte stämmer (t.ex. lös hållare) räknas inte.

## Rullmodellen lär sig under körning

Varje rullning efter en släpp-signal blir ett litet rullprov. Appen hittar rullningen i GPS-farten, klipper bort början (foten lämnar gasen), slutet och allt efter gas (farten ökar) eller broms (inbromsning 0,8 m/s² mer än modellen två sekunder i rad, eller en ihållande stöt i accelerometern). Inbromsningen korrigeras för backen med ruttens höjddata.

Rena rullningar (minst 5 s och 4 km/h, 30–110 km/h, god GPS) vägs ihop med rullprovet: rullprovet väger från början som ca 7 rullningar och en rullning som högst 3 mätpunkter, så modellen ändras gradvis. Nyare rullningar väger mer: för varje ny rullning väger alla tidigare 7 % mindre (halveras efter ca 10 rullningar), och rullprovet tappar vikt på samma sätt men aldrig under 15 % av sin fulla vikt. Då följer modellen däckbyten, årstider och last. Rullningar som bromsar mycket mer än modellen sorteras bort (broms). Rullningar som är lättare än väntat godkänns, eftersom bilar som frikopplar när gasen släpps rullar så; bara en rullning som inte tappar någon fart på plan väg (lutningen borträknad) sorteras bort, eftersom den betyder gas eller fel höjddata. Rullningar som inte börjar vid en släpp-signal loggas men räknas inte, eftersom en halv gaslättning annars skulle se ut som en lätt rullning. Av/på och återställning under Inställningar → Kalibrering.

**Under rullningen** jämförs bilens faktiska inbromsning (backen borträknad) med modellen. Efter 3 s rullning börjar avvikelsen läggas på A, gradvis tills hela avvikelsen gäller efter 8 s (högst −0,25 till +0,4 m/s²). Den justerade modellen styr bromsvarningen (”broms kan behövas” när farten ligger mer än ca 4 km/h över rullkurvan) och fartkurvan, som då visar ”rullkurva · justerad”. Justeringen gäller bara den pågående rullningen; när den tar slut gäller den sparade modellen igen och rullningen lärs in som vanligt. Loggen får händelsen `liveCoast` och fältet `coastAdj` i varje prov.

## Ny rutt vid annan väg

- Bilen räknas som utanför rutten när den i 4 s har varit längre bort än 15 m + 2 × GPS-noggrannheten (25–40 m), så att en parallell väg syns vid god GPS. Över ca 30 km/h och med god GPS räknas det också som avvikelse när GPS-kursen skiljer sig mer än 60° från ruttens riktning, t.ex. i en avfart.
- Den nya rutten börjar i färdriktningen (GPS-kursen, eller riktningen från en position minst 20 m bakåt), så att den inte vänder bilen. Hittar tjänsten ingen sådan rutt görs ett försök utan riktning.
- Misslyckas omberäkningen (t.ex. utan täckning) försöker appen igen så länge bilen är utanför rutten, efter 5, 10, 20, 40 och sedan var 60:e sekund. Felet visas bara första gången.

## OBD-dosa (frivillig)

En ELM327-kompatibel dosa med Bluetooth 4.0/BLE (t.ex. Vgate iCar Pro BLE) kan anslutas under Inställningar → OBD-dosa. Det kräver Web Bluetooth, alltså Chrome på Android (eller Chrome/Edge på datorn); Safari på iPhone saknar det, och dosor med Bluetooth 3.0 eller Wi-Fi går inte att nå från en webbsida. Dosan ska inte parkopplas i telefonens Bluetooth-inställningar, den väljs i Chromes lista.

- **Test vid anslutning:** dosan startas (`ATZ`, `ATE0`, `ATS0`, `ATSP0` …) och appen läser vilka värden bilen redovisar (`0100`, `0120`, `0140`). Kortet visar dosa, protokoll och om fart, varvtal, gaspedal, bränsle och avstängt bränsle finns. Det som saknas tas från GPS som förut.
- **Övrigt:** appen läser alla mode 01-värden bilen redovisar (`0100` … `01C0`), ett varannat varv så att pedalen fortfarande läses ofta. Kylvätsketemperatur (`05`) och motorlast (`04`) läses varannan gång, resten i tur och ordning. Ett värde som inte svarar tre gånger i rad hoppas över en stund och prövas sedan igen (efter 30 s, sedan dubbelt så länge varje gång, högst 10 min). Kylvätska och last visas bara om de lästs den senaste minuten. Kända värden avkodas (t.ex. `intakeC`, `mapKpa`, `stft1Pct`, `ltft1Pct`, `timingDeg`, `baroKpa`, `moduleV`, `ambientC`, `oilC`, `catB1S1C`, `fuelLevelPct`, `odometerKm`, `torqueActualPct`); övriga sparas som hex (`pidXX`). Kylvätska, last och övrigt visas live i OBD-kortet under Inställningar, och kylvätska och last i körvyn.
- **Gaspedalen** läses i första hand som relativ pedal (`5A`), annars pedal D (`49`), relativt gasspjäll (`45`) eller gasspjäll (`11`). Givarna visar sällan 0 utan fot, så viloläget lärs in som det lägsta värdet; gasen räknas som släppt under 3 % och nedtryckt över 8 %.
- **Farthållare:** med farthållaren på visar pedalgivaren 0 fast motorn drar. Appen känner igen det på att pedalen är släppt men bränsleflödet ligger klart över tomgång (minst dubbla tomgången och 1 l/h över den, tomgången mäts när bilen står still) i 3 s, över 25 km/h och utan avstängt bränsle. Då räknas gasen som på: signalen räknas inte som följd, ingen motorbroms visas och rullningen mäts inte förrän farthållaren slås av (bränslet går ner till tomgång eller stängs av). Gasraden visar *Farthållare*, och vid släpp *Slå av farthållaren – rulla*.
- **Momentan förbrukning** (l/100 km, under 10 km/h l/h) visas i körvyn bredvid varvtalet, ur bränsleflödet (`5E`) eller luftflödet (`10`), utjämnad över ca 3 s; 0 när bränslet är avstängt.
- **I körvyn** visas pedalen som en båge i ringen (grön när gasen är släppt), varvtalet, och *Motorbroms* eller *Bränsle av* (bränslesystemets status `03` = 4 med släppt gas). När gasen släpps efter en signal visas *Gas släppt efter 0,6 s*. Med pedalen avgör den, inte GPS-farten, om signalen följdes, och en rullning avbryts när gasen trycks ned igen.
- **Rullmodellen:** rullningar där pedalen visar att gasen var helt släppt hela tiden räknas även om de inte började vid en släpp-signal, och gas under rullningen avbryter mätningen.
- **Sammanfattningen** visar reaktionstid (median), bränsle (bränsleflöde `5E`, annars beräknat ur luftflödet `10` för bensin), sträcka med motorbroms eller avstängt bränsle, och en stapel per signal med tiden till släppt gas.
- Tappas anslutningen fortsätter appen med GPS och ansluter igen av sig själv (efter 3, 6, 12 … högst 30 s). Med *Anslut automatiskt när körningen startar* ansluter appen till den sparade dosan vid Starta om webbläsaren minns den (`getDevices`); annars ansluter man med OBD-knappen i körvyn.
- Körloggen får fälten `pedal`, `rpm`, `obdKmh`, `pedalRaw`, `gas`, `fuelLh`, `maf` och `fuelCut`, händelserna `obd` (ansluten/tappad) och `follow` med `byPedal`, och sammanfattningen `obd`. Rådatan får tabellen `obd` (`t, kmh, rpm, pedal, pedalRaw, maf, fuelLh, fuelCut, released, fuelLhCar, cruise`) med varje värde från dosan (ca 4 per sekund), och `obdx` (`t, pid, value, A, B, C, D`) med varje övrigt värde: avkodat och svarets databytes.

## Körlogg (JSON)

Varje körning och rullprov sparas i telefonen (de 10 senaste). Under Inställningar → Data → *Visa körloggar*, eller från sammanfattningen:

- **Kopiera för analys**: kompakt JSON att klistra in i en chatt. Körningar upp till 15 minuter får alla mätpunkter (en per sekund); längre körningar en mätpunkt var 5:e sekund plus varje byte av läge (ca 50 kB per timme). Alla händelser är alltid med.
- **Spara fil / Dela**: samma sak med alla mätpunkter (en per sekund).

Innehåll: `kind` (`drive` | `calibration`), `dest`, `settings`, `model` (A, C och källa), `route` (längd, andel med känd gräns, fartmål och kurvor), `stats`, `events` och `samples`.
`samples.rows` har fälten i `samples.fields`: `t` (s från start), `s` (m längs rutten), `lat`, `lon`, `kmh`, `acc` (GPS-noggrannhet, m), `mode`, `limit` (km/h), `g` (sidokraft), `side` (sidokraft med tecken, positiv = trycker åt höger), `rel` (m till släpp-signal), `alt` (m), `pedal` (%), `rpm`, `obdKmh`, `heading` (GPS-kurs, grader), `lonG` (kraft längs bilen, g, positiv = gas), `coastAdj` (m/s²), `pedalRaw` (givarens värde, %), `gas` (1 = nedtryckt, 0 = släppt), `fuelLh` (l/h), `maf` (g/s), `fuelCut` (1 = bränslet avstängt), `gasRec` (rekommenderat gaspådrag, %), `gasLo`/`gasHi` (rekommendationens gränser), `gasKind` (`release`, `hold` eller `accel`), `coolant` (kylvätska, °C), `load` (motorlast, %), `cruise` (1 = farthållaren drar), `fuelL100` (momentan förbrukning, l/100 km) och `other` (övriga OBD-värden som lästs sedan förra mätpunkten, `{namn: värde}`; i kompakt logg följer de med till nästa mätpunkt som behålls). Tomma fält i slutet av en rad utelämnas (saknas = null). Händelsen `obd` vid anslutning har också dosans version, bränsletyp och vilka PID:er bilen redovisar (`pids`, hex).
Händelser: `coast` (rullning: sträcka, tid, fart, medelinbromsning, avvikelse från modellen, om den användes och varför inte), `release`, `follow`, `reached`, `pause`, `resume`, `offroute`, `reroute` (med färdriktning och antal försök), `rerouteFailed`, `curve` (planerad mot uppmätt sidokraft, radie, svängvinkel gyro/karta), `arrived`, `stopped`; för rullprov `cue`, `done`, `failed` och resultatet i `stats`.

## Testbana

Den korta testbanan (på sidan Koppla OpenRouteService, under fältet för nyckeln) kräver ingen nyckel. En simulerad bil kör den i fyrdubbel fart; knappen i körvyn ändrar farten (1×, 4×, 8×, 16×). Appen lär sig inte av testkörningar.

## Rådata

Varje riktig körning sparar också all rådata i telefonens databas (IndexedDB, eftersom localStorage bara rymmer ca 5 MB):

| Data | Fält | Frekvens |
| --- | --- | --- |
| GPS | `t, lat, lon, alt, acc, altAcc, speed, heading` | varje position (ca 1/s) |
| Rörelse | `t, ax, ay, az` (utan tyngdkraft), `gx, gy, gz` (med tyngdkraft), `alpha, beta, gamma` (gyro, grader/s) | varje sensorhändelse (ca 50–60/s) |
| Kompass | `t, heading` | varje händelse |
| API | ruttsvaret (koordinater med höjd, sträcka, tid) och vägdatan från Overpass | vid planering och ny rutt |
| Utan rutt | `osmnet`: vägnätet som användes (celler, fel, alla element); `horizon`: varje väg framåt med geometri och mål | vid varje hämtning och omräkning |
| OBD | se OBD-dosa ovan | varje värde från dosan |

`t` är sekunder sedan starten. *Spara fil* / *Dela* i körloggarna ger loggen med rådatan under `raw`; *Kopiera för analys* är som förut kompakt utan rådata. Rådatan raderas tillsammans med sin logg, och de 10 senaste loggarna sparas.

## Kör utan rutt

*Kör utan rutt* på startsidan ger samma körvy som med rutt, utan resmål och utan OpenRouteService-nyckel. Allt loggas som vid en vanlig körning (logg och rådata), och rullmodellen, gyrot och pedalmodellen lär sig som vanligt.

- **Vägnätet** runt bilen (alla körbara vägar, ca 1,3 km åt varje håll) hämtas från Overpass i samma rutor som vägdatan för rutter, närmast först, och sparas i telefonen i 30 dagar (eget förråd, `osmnet1.`). Vägnät längre bort än ca 2,6 km släpps under körningen.
- **Vägen framåt** (`js/horizon.js`): bilen matchas mot närmaste väg som går åt färdriktningen (enkelriktat respekteras). Därifrån följer appen samma väg, annars samma vägnamn, annars den väg som går rakt fram (högst 45° sväng och minst 30° rakare än nästa). In- och utfarter (`service`, `track`) räknas inte som val. Vägen framåt slutar efter 1,5 km, i en T-korsning, där två vägar är lika raka, strax in i en rondell eller där vägen tar slut.
- Vägen framåt blir en vanlig rutt för körmotorn: trafikljus, stopp, väjning, rondeller, kurvor och sänkta gränser ger släpp-signaler som med rutt. När bilen lämnar vägen framåt (mer än 20 m + GPS-noggrannheten, eller kursen skiljer mer än 50°) räknas en ny fram direkt; den förlängs när mindre än 700 m återstår. Ett mål som redan har gett signal känns igen på platsen och signaleras inte igen, och en pågående rullning fortsätter.
- Utan känd väg (vägnätet saknas, eller bilen står still) visas hastighetsgränsen om den är känd men inga mål.
- **Körvyn**: tid och sträcka i stället för kvar, ringen säger *Utan rutt*, raden under ringen visar vägens namn och gräns, och kartan visar vägarna runt bilen, ditt spår (blått, ca 3 km) och vägen framåt streckad.
- **Sammanfattningen** visas alltid: sträcka, tid, snittfart, signaler, bränsle och motorbroms.
- Loggen har `kind: "free"`, händelserna `network` (hämtat vägnät) och `horizon` (ny väg framåt: namn, orsak till slutet, längd och mål), och `stats.horizons` (antal omräkningar).

## Rekommenderat gaspådrag (OBD)

Med OBD-dosan visas en gasrad under ringen, både med och utan rutt: stapeln är gaspedalen (grön inom rekommendationen, orange utanför), det gröna fältet och strecket är det rekommenderade pådraget, och en kort rad säger vad som gäller (`js/gasadvice.js`).

- **Släpp** (0 %): under rullning, när mindre än 150 m återstår till släpp-signalen (ingen idé att gasa upp farten man snart ska rulla av), och när farten är mer än 3 km/h över gränsen eller kurvfarten.
- **Accelerera lugnt**: mer än 6 km/h under gränsen. Pedalen som håller farten plus det som ger ca 0,9 m/s² (0,1 g), ± 5 %.
- **Håll farten**: pedalen som håller farten vid gränsen, ± 3 %.
- Uppför och nedför (ruttens höjddata, medellutningen över ±150 m eftersom höjddatan har hopp på flera meter) läggs till som acceleration. Under 8 km/h ges ingen rekommendation.
- **Inlärning:** vid jämn fart (under 0,15 m/s² ändring) med gas lär appen sig pedalen per 10 km/h; vid tydlig acceleration hur många procent extra pedal en m/s² kräver. Innan det finns minst fem mätningar används typvärden (ca 12 % vid 50 km/h och 14 % per m/s²), och raden säger *(typvärde)*. Modellen sparas efter varje körning.
- Sammanfattningen visar andelen av tiden (med OBD och i rörelse) inom rekommendationen; loggen har fältet `gasRec` per mätpunkt och `stats.gasWithinPct`.

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
| `js/demo.js`, `js/sim.js` | Testbana och simulerade bilar |
| `js/horizon.js` | Vägen framåt utan rutt ur OSM:s vägnät |
| `js/gasadvice.js` | Rekommenderat gaspådrag och pedalmodellen |

## Publicering

`.github/workflows/pages.yml` kör testerna och publicerar appen på GitHub Pages vid push till `main`. Aktivera en gång under *Settings → Pages → Source: GitHub Actions*.

## Kända begränsningar (version 1)

- Bilar som rullar i växel med motorbroms. Friläge och elbilar/hybrider med regenerering ingår inte.
- Trafikljusens fas är okänd, så appen räknar alltid som om det är rött.
- Stopp- och väjningsplikt-noder på korsande vägar kan ibland hamna på rutten om de ligger inom 10 m från den.
- Följsamhet i sammanfattningen mäts med GPS-farten (fartminskning efter signalen), inte med accelerometern.
- Ingen ”fri körning” – en rutt måste väljas före start.

Vägdata © OpenStreetMap-bidragsgivare.
