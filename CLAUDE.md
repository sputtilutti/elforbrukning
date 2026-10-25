# Elfakturor — sammanställningsprojekt

Det här projektet extraherar strukturerad data ur PDF-fakturor för el (elnät + elhandel)
och bygger en sammanställd CSV/kalkylark. Fakturorna gäller en fastighet
(flera anläggningar/byggnader på samma fastighet) från 2020 och framåt.

## Katalogstruktur

Fakturorna ligger i en mapp (typiskt döpt "Förbrukning") med PDF-filer, organiserade i
undermappar per år (`2023/`, `2024/`, `2025/`, `2026/`) plus en `Gamla Fakturor/`-mapp
för äldre format. Skripten söker rekursivt (`glob(<mapp> + "/**/*.pdf", recursive=True)`)
så mappstrukturen i sig spelar ingen roll för extraktionen.

Filnamnskonventionen är oftast `<Bolag> faktura ... - <Anläggningsnamn>.pdf`, t.ex.
`Ellevio faktura 2024-03 - Byggnad B.pdf`. `company_of()` och `anlaggning_of()` i
`parse.py` parsar ut bolag respektive anläggningsnamn ur filnamnet som ett första gissning
(bekräftas/kompletteras sedan av innehållet i själva PDF:en).

## Arbetsflöde

1. **`parse.py`** — läser varje PDF med `pdfplumber`, extraherar text, kör rätt
   bolagsspecifik parser, skriver alla rader till `rows.json` (mellanlager).
2. **`finalize.py`** — läser `rows.json`, normaliserar datum/adress/specifikationstext,
   mappar Anläggnings-ID → läsbart anläggningsnamn, flaggar dubbletter, skriver slutlig
   `fakturor.csv`.

Detta tvåstegsflöde finns för att PDF-extraktionen (steg 1) är långsam och inte behöver
köras om varje gång man justerar formatering/normalisering (steg 2).

`parse.py` är inkrementell: `tmp/parse-index.json` kopplar varje PDF (relativ sökväg → innehållshash) till
raderna i `rows.json`, och bara nya/ändrade filer tolkas. En hash av `parse.py` och `common.py` ligger också
i indexet, så ändrad tolkningskod ger automatiskt en full omtolkning (annars skulle gamla rader vara inaktuella).
`--full` omtolkar allt, `--prune` tar bort rader för filer som försvunnit. Kör alltid mot samma rotmapp.

**Innan du ändrar en parser:** kör `parse.py`, öppna `rows.json` och leta efter rader med
icke-tom `granska`-nyckel — det är din QA-lista över vad som inte gick att extrahera.

**Efter varje ändring:** kör om hela pipen och sortera de extraherade beloppen/kWh-värdena
i stigande/fallande ordning (se sanity-checken i botten av `finalize.py`). Orimligt höga
eller låga värden är den mest effektiva metoden för att hitta regex-buggar i stor skala —
en enskild bugg i kWh-extraktionen (se nedan) missades vid stickprovskontroll men syntes
direkt när alla värden sorterades.

**Kör pipen med `make`** (se `Makefile`, `make` listar kommandona): `make update` = parse → finalize → summarize →
export → granska, `make serve` startar webbsidan, `make spot` uppdaterar spotpriserna, `make test` kör alla tester.
Fakturamappen och spotpris-PDF:en anges som variabler överst i `Makefile` (åsidosätts i `config.mk` eller på
kommandoraden). `granska.py` listar anmärkningar från 2023; luckkontrollen i `finalize.py` gäller bara perioder
från 2023 (`CONTINUITY_FROM`), eftersom äldre data är känt ofullständigt.

## Bolag och fakturaformat

Elnät kommer alltid från **Ellevio** (samma bolag för alla anläggningar). Elhandel har
växlat leverantör över tid och mellan anläggningar: **Fortum**, **Skekraft**, **Tibber**,
**Vattenfall**.

Varje bolag har sitt eget textformat, och flera bolag har bytt format minst en gång under
perioden som täcks. De viktigaste varianterna:

- **Ellevio**: relativt stabilt format. Text kan innehålla `(cid:NNN)`-artefakter istället
  för å/ä/ö i vissa PDF:er (custom font-encoding) — hanteras av `fix_cid()` med en
  hårdkodad CID→tecken-mapping. Specifikationsfältet innehåller ibland ett inbäddat
  användningsdiagram (text) som `strip_chart_junk()` i `finalize.py` försöker rensa bort.
- **Fortum**: två format — ett äldre ("Gamla Fakturor", innan ca sommaren 2023) och ett
  nyare. Det äldre formatet saknar t.ex. explicit "Fakturadatum:"-etikett (datumet står
  på egen rad efter en bar "Faktura"-rad istället) och skriver "Faktura-/OCR-nummer" utan
  kolon. Vissa gamla belopp saknar öresdel ("1 630 kr" istället för "1 630,00 kr").
  **Specialfall:** 9 mycket gamla fakturor (dec 2020 – mars 2021) slår ihop elnät
  (Ellevio) och elhandel (Fortum) i EN faktura/betalning. `parse_bundled()` upptäcker
  detta mönster och delar upp det i två rader — men för dessa saknas detaljerad
  kostnadsspecifikation, bara totalbeloppen per bolag går att utläsa ur texten.
- **Skekraft**: adressfältet innehåller ofta extra text som läckt in från en annan kolumn
  i PDF:en (t.ex. avtalsinformation) — `clean_address()` trunkerar vid `"; SE"`.
- **Tibber**: har inget separat "period"-fält i samma format som övriga — perioden står
  som fritext (t.ex. "mars 2023" eller ett datumintervall) och måste tolkas separat
  (`parse_tibber_period()`).
- **Vattenfall**: nyaste tillskottet i datat, ganska konsekvent format hittills.

## Kända fallgropar (redan lösta, men bra att känna till om nya format dyker upp)

- **kWh-extraktion**: extrahera INTE kvantitet med en enkel regex av typen
  `[\d\s]+(?:,\d+)?\s*kWh` på hela raden — den kan glupskt fånga in siffror från ett
  intilliggande datum (t.ex. "...2023-01-31 2720 kWh" → felaktigt "312720"). Använd istället
  `extract_qty_before_kwh()`, som tokeniserar raden och bara tittar på token direkt före
  det bokstavliga "kWh"-token.
- **Svenska tal**: mellanslag som tusentalsavgränsare, komma som decimalavgränsare
  (`sw_num()` hanterar detta). Kontrollera alltid att en ny regex inte råkar fånga in en
  del av ett anläggnings-ID eller OCR-nummer som "belopp".
- **0-belopp**: en del Vattenfall-fakturor har legitimt `0,00 kr` som totalsumma — QA-koden
  måste kolla `is None`, inte truthiness (`0.0` är falsy i Python men ett giltigt värde här).
- **Anläggnings-ID vs adress**: adressen som står i fakturan kan ändras över tid för samma
  fysiska anläggning (t.ex. "Gård 1" → "Gård 2/3"). Anläggnings-ID:t
  (13-siffrigt) är den stabila nyckeln — använd `id_name.json` (laddas av `common.load_id_name()`; din egen fil ligger inte i git, `id_name.example.json` är mallen) för att
  mappa ID → ett konsekvent, läsbart anläggningsnamn. Om en ny anläggning dyker upp i
  framtida fakturor behöver detta dict uppdateras manuellt (annars faller den tillbaka på
  namnet som gissats ur filnamnet).

## Kända öppna frågor i datat (per senaste körning, 360 filer → 369 rader)

- Ett par av totalt 363 rader saknar detaljerad kostnadsspecifikation: de 9 kombinerade
  Ellevio+Fortum-fakturorna nämnda ovan (endast totalbelopp går att utläsa).
- En misstänkt dubblettfaktura: Fortum-fakturanummer `4200000000001` (2022-10-07,
  2 837 kr) förekommer i två olika PDF-filer med identiskt innehåll — oklart om det är
  samma faktura nedladdad två gånger eller två separata poster.

## Output

`fakturor.csv` — full sammanställning med kolumnerna:
`Bolag, Typ (Elnät/Elhandel), Anläggning, Anläggnings-ID, Adress, Fakturanummer,
Fakturadatum, Period start, Period slut, Specifikation kostnader, Total förbrukning (kWh),
Totalsumma (SEK), <kostnadsuppdelning elhandel, se README>, Källfil, Granska`

`Granska`-kolumnen samlar alla varningar/anmärkningar per rad (saknade fält, dubbletter,
parsefel) — en tom `Granska` betyder att raden extraherades utan anmärkning.

Alla belopp normaliseras till SEK (kr) som enhetlig valuta/enhet.

## Prisjämförelse av elhandel

Syftet med projektet är att jämföra vad elhandelsbolagen kostat. `costs.py` delar upp
specifikationens kostnadsrader (Fortum, Skekraft, Vattenfall) i energipris, påslag/elcertifikat,
fast avgift, rabatter och moms; `summarize.py` ger viktat snittpris per anläggning/bolag/år.
Standard är **exkl. moms** (moms säger inget om bolaget), med inkl. moms i egen kolumn.
Tibber ingår inte. Rabatter är ofta tidsbegränsade, därför finns även "Ordinarie pris".
Fortums "Totalsumma" är avrundad till hela kronor; exakta belopp finns i `Summa inkl. moms`.
Okända kostnadsrader och summor som inte stämmer flaggas i `Granska`.
Perioder som inte ansluter till varandra (luckor/överlapp per anläggning och typ) flaggas i
`Granska`, och `summarize.py` ger ett rullande "Senaste 12 mån"-snitt med `Dagar täckta` som
visar om perioden är komplett.

## Spotpris (referens för jämförelse)

`spotpris_se3.csv` har månadsmedelspris för elområde SE3 (öre/kWh, **exkl. moms**, från Energimarknadsbyrån).
Skapas av `extract_spotpris.py <pdf>`: 2023–2025 ur PDF:en "Månadspriser på elbörsen mellan 1996 och 2025",
senare år hämtas från webbsidans rubrik "Elpriset <år>" (`--web-year`). Kör om skriptet när nya månader publicerats.
`finalize.py` läser filen via `common.load_spot()` och skriver spotpris samt "Skillnad mot spot" per elhandelsfaktura
(dagsviktat månadsmedel över fakturaperioden); `summarize.py` viktar dem med kWh. Elområde styrs av `SPOT_AREA` i `common.py`.

## Webbverktyget (web/)

Statisk sida för att jämföra erbjudanden mot förbrukningen. `export_data.py` skriver `data.json`
(anläggning × månad: kWh, betalt, ordinarie, fast avgift, bolag, plus spotpris; inga adresser/ID/filnamn).
All beräkning ligger i `web/calc.js` (ren logik, testad med `node --test`), gränssnittet i `web/app.js`.
Riktiga `data.json` ska aldrig publiceras (GitHub Pages är publikt); `web/demo-data.js` är påhittad.
Räknar i SEK exkl. moms internt; erbjudanden som anges inkl. moms räknas om (momssats ur datat).
Webbsidan kan filtrera på en anläggning och har ett historikavsnitt (`Calc.history` i `calc.js`: månader, år, bolag, iakttagelser).
`data.json` innehåller bara månadsaggregat per anläggning, inte enskilda fakturor.
`avtalstyp.json` anger om bolagets avtal är rörligt eller fast (Skekraft = fastpris 61,1 öre/kWh exkl. moms); `export_data.py` lägger det i `data.json` så grafen kan visa avtalsperioder.
Erbjudanden i webbsidan följer jämförelsesajternas upplägg: komponenter exkl. moms (fast påslag, rörliga kostnader, årsavgift, kampanjrabatt i kr/mån).
`costs.py` skiljer "Rörliga kostnader" (kategori `rorliga`) från "Fast påslag"; `data.json` har `rorliga_exkl` så råden kan jämföra mot dina egna.
Kostnad per anläggning och månad har golvet 0 kr (`compare` i `calc.js`), och `referencePrice` räknar sajternas jämförpris (20 000 kWh/år) som kontroll.
Filter i webbsidan (anläggning/år/bolag) görs av `Calc.filterData`; "räkna över 0 månader" betyder hela urvalet och används automatiskt när år eller bolag är valt.
Varje erbjudande har `kwhBasis` (sajtens förbrukning, standard 20 000) och `spotManad` för kontrollpriset; årsavgift i öre/kWh görs om till kr/år med `kwhBasis`.
Kör webbsidan med `python3 serve.py` (skickar `Cache-Control: no-store`). `web/index.html` har `?v=N` på css/js-filerna: höj N när `app.js`, `calc.js`, `style.css` eller `demo-data.js` ändras, annars kan webbläsare och GitHub Pages visa gamla versioner.
`serve.py` serverar även `tmp/data.json` som `/data.json` och sparar sidans tillstånd (filter, erbjudanden) i `tmp/web-state.json` via `/api/state` (204 = inget sparat, vanligt 404 = ingen sparfunktion). Bara loopback-anrop tillåts, eftersom datat är privat. `persist()` i `app.js` skriver både till `localStorage` och till servern.
Inläst data sparas av `rememberData()` (localStorage + `/api/data` → `tmp/web-data.json`). Startordning i `loadInitialData()`: har användaren valt data för hand (`settings.dataSource === 'manual'`) används den sparade kopian först, annars serverns `data.json`.
Rabatt styrs separat för fakturor (`baselineMode`: betalt/ordinarie) och erbjudanden (`offerMode`: rabatt/ordinarie) i `compare`; inställningarna heter `baseline` och `offerRabatt`. Det äldre gemensamma `mode` delas upp av `normalizeSettings()` i `app.js`.
Överblicken i webbsidan (`Calc.overview`) visar priser för senaste månaden och kostnad över jämförelseperioden. Säljarens pris görs om till ett erbjudande av `Calc.quoteOffer` (rörligt: påslag = pris − månadens spot; fast: fastpris) och kommenteras av `Calc.quoteTips`. Det inskrivna priset ligger i `settings.quote` och sparas som övriga inställningar.
Detaljerna om säljarens erbjudande (`settings.quote.detail`) ändrar inte priset (det är ett totalpris): `Calc.quoteDetails` ger avgifter/rabatt till överblicksraden och `Calc.detailsCheck` jämför dem med totalpriset. `saveQuoteAsOffer()` i `app.js` sparar som erbjudande.
Webbsidan har flikar (`oversikt`, `erbjudanden`, `jamforelse`, `historik`, `data`) styrda av `showTab()` i `app.js`, med flik i adressen (`#historik`). Filterraden (`#filterbar`) visas bara på flikar som påverkas av filtren (`FILTER_TABS`). `renderEmptyStates()` visar ett meddelande i en flik när data saknas eller filtren inte matchar något.
Överblickens tre prisvarianter: `energyOre` (utan avgifter), `allInOre` (din förbrukning senaste månaden, med avgifter och kr/mån-rabatter) och `refOre` (sajtens jämförpris, `referencePrice` med erbjudandets `kwhBasis`/`spotManad`). De är olika av design.
Jämförelser räknar alltid på högst 12 månader (`COMPARE_MONTHS` i `app.js`; `windowMonths` släpper månader som inte finns i urvalet) och alla rabatter/villkor antas gälla hela perioden: `rabattManader` och `bindning` används inte längre i beräkningarna. Rubriker med förklaring byggs med `tipLabel()` (`data-tip`) och visas av en egen tooltip (`setupTooltips()`), inte `title`-attribut.
Säljarens pris är ett totalpris på en standardförbrukning (`settings.quote.kwhBasis`, standard 20 000): i `Calc.overview` får raden `isQuote` och priset ligger i `refOre` (jämförpriskolumnen), inte i `energyOre`/`allInOre`. `quoteTips` varnar när din förbrukning per anläggning avviker mer än en faktor 2 från säljarens, och `detailsCheck` jämför detaljerna på samma underlag (`referencePrice` med säljarens förbrukning).
Överblickens standardkolumner: kostnad perioden, mot nuvarande, pris på din förbrukning (`yearCost / total förbrukning`) och jämförpris (`refOre`). Energipris, avgifter och rabatt ligger bakom "Visa detaljer" (`settings.showDetails`). `allInOre` (pris senaste månaden) finns kvar i `Calc.overview` men visas inte.
`data.json` har fakturans delar per månad och anläggning (`energi_exkl`, `paslag_exkl` = påslag + rörliga kostnader + elcertifikat, `fast_brutto_exkl`, `rabatt_rorlig_exkl`, `rabatt_fast_exkl`; summerar till `betalt_exkl`). `Calc.currentOffer` gör dina nuvarande avtal till ett erbjudande av senaste månadens fakturor (rörligt: påslag = pris - spot, fast: fastpris), så att överblicken kan räkna ett jämförpris för dem med `referencePrice` (med eller utan rabatt efter `baselineMode`). Äldre `data.json` utan delarna ger inget jämförpris (kör `make export`).
Historikens kostnadskolumner heter `Betalt (kr)` (`betalt_exkl`) och `Utan rabatt (kr)` (`ordinarie_exkl`) och ska stämma med överblickens rad för nuvarande avtal (`baselineMode` betalt resp. ordinarie) för samma period och filter.
`finalize.py` och `summarize.py` skriver även `fakturor-sv.csv` och `sammanfattning-sv.csv` (semikolon, decimalkomma, UTF-8 med BOM, `write_csv_sv` i `common.py`) för import i ett kalkylark med svenska inställningar. De vanliga CSV-filerna har decimalpunkt och är de som skripten läser, så de ska inte ändras.

Vattenfall: `parse_vattenfall` summerar kvantiteterna på "Medelspotpris"-raderna (en rad per prisperiod) som förbrukning; det första datumintervallet gav fel kWh när priset ändrades i perioden (maj 2026: 634 i stället för 835). Kontrollera elnäts-kWh mot elhandels-kWh per månad; avvikelser vid leverantörsbyte (t.ex. Byggnad B nov 2024, Fortum till 7 nov) är väntade.
Webbsidans filter har även `typ` (avtalstyp rörligt/fast; `Calc.filterData`). `Calc.fastVsRorligt` ger kontrollraden i Historik: månader med fast pris mot spot + påslag (`settings.paslag`, öre/kWh exkl. moms) och påslaget där de är lika.
