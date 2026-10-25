# Elfakturor

Extraherar strukturerad data ur PDF-fakturor för el (elnät + elhandel) för en fastighet
och bygger en sammanställd CSV (`fakturor.csv`) som kan öppnas i valfritt
kalkylark. Fakturorna gäller från 2020 och framåt.

## Bolag som hanteras

- **Elnät:** Ellevio
- **Elhandel:** Fortum, Skekraft, Tibber, Vattenfall

Varje bolag har eget format (och vissa har bytt format över tid). Se [CLAUDE.md](CLAUDE.md)
för detaljer om format, kända fallgropar och öppna frågor i datat.

## Krav

- Python 3
- [`pdfplumber`](https://github.com/jsvine/pdfplumber)

Skapa och aktivera en virtualenv, och installera beroendena:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Aktivera miljön (`source .venv/bin/activate`) i varje ny terminalsession innan du kör skripten.

## Snabbstart med make

Du behöver inte komma ihåg ordningen: `make` kör stegen rätt, kontrollerar att allt behövs finns och
skapar virtualenv vid behov.

```bash
make            # visar alla kommandon
make update     # hela flödet efter nya fakturor: parse, finalize, summarize, export och en kontroll av anmärkningar
make serve      # startar webbsidan på http://localhost:8765
```

| Kommando | Vad det gör |
|----------|-------------|
| `make update` | Läser nya/ändrade PDF:er, bygger `fakturor.csv`, `sammanfattning.csv` och `data.json`, visar fakturor med anmärkning (bör vara tomt) |
| `make start` | `update` och sedan `serve` |
| `make full` | Som `update` men tolkar om alla PDF:er |
| `make spot` | Uppdaterar spotpriserna när en ny månad publicerats, och bygger om data |
| `make granska` | Listar fakturor med anmärkning från 2023 (`python3 granska.py --from 2020-01` för äldre) |
| `make test` | Kör alla tester |
| `make setup`, `make demo` | Skapar virtualenv, skapar demodata |

Mappen med fakturor och spotpris-PDF:en anges överst i `Makefile` (`FAKTUROR`, `SPOT_PDF`) och kan
åsidosättas per körning (`make update FAKTUROR="/annan/mapp"`) eller i en egen `config.mk`. Varje steg kan
också köras för sig (`make parse`, `make finalize`, `make summarize`, `make export`).

Under huven kör `make` skripten nedan i ordning. Vill du köra dem för hand går det också.

## Användning

Pipen består av tre steg:

1. **`parse.py`** läser PDF-filer rekursivt i angiven mapp, kör rätt bolagsspecifik parser och skriver
   mellanlagret `rows.json`. Den är **inkrementell**: bara nya eller ändrade filer läses (se nedan).
2. **`finalize.py`** läser `rows.json`, normaliserar datum/adress/specifikation, mappar
   anläggnings-ID till läsbart namn, tolkar kostnadsrader, flaggar dubbletter och skriver
   `fakturor.csv`.
3. **`summarize.py`** läser `fakturor.csv` och skriver `sammanfattning.csv` med viktat snittpris
   (summa kronor / summa kWh) per anläggning och bolag, dels per kalenderår, dels för
   **senaste 12 mån** (12 kalendermånader fram till bolagets sista fakturerade period), samt
   totalt för alla anläggningar. Dubbletter räknas en gång. Elhandel exkl. moms är standard,
   inkl. moms i egen kolumn. `Från`, `Till` och `Dagar täckta` visar vilken tid fakturorna
   faktiskt täcker – under 365 dagar för 12-månadersraden betyder att fakturor saknas.

```bash
python3 parse.py <rotmapp med PDF-fakturor>   # bara nya/ändrade filer tolkas
python3 finalize.py                         # snabbt – kan köras om vid ändrad normalisering
python3 summarize.py                        # viktat snittpris per anläggning, bolag och år
```

Mellanfilerna hamnar i `./tmp/` som standard. Sätt miljövariabeln `WORKDIR` för att
använda en annan katalog (samma värde måste gälla för båda stegen):

```bash
WORKDIR=/sökväg/till/arbetsmapp/ python3 parse.py <mapp>
WORKDIR=/sökväg/till/arbetsmapp/ python3 finalize.py
```

### Lägga till nya fakturor

Lägg PDF:erna i rotmappen (t.ex. i `2026/Elförbrukning 2026-09/`) och kör om pipen. `parse.py` tolkar bara
filerna som är nya eller ändrade och behåller resten, så en körning med några nya fakturor tar under en sekund:

```bash
python3 parse.py <rotmapp>      # t.ex. "Nya: 6, ändrade: 0, oförändrade: 354"
python3 finalize.py && python3 summarize.py && python3 export_data.py
```

- Filerna känns igen på innehållet (hash i `tmp/parse-index.json`), inte på filnamn eller datum.
- **Ändras tolkningskoden** (`parse.py` eller `common.py`) tolkas allt om automatiskt, så gamla resultat inte
  blir inaktuella. `--full` tvingar fram en full tolkning.
- Filer som inte längre finns i mappen **behåller sina rader** (med en varning). `--prune` tar bort dem.
- Använd **samma rotmapp** varje gång, eftersom filnamnen räknas relativt den.
- Filer som inte gick att läsa försöks igen vid nästa körning.

### Indatamapp

PDF-filerna ligger i en mapp med undermappar per år (`2023/`, `2024/`, …) och
`Gamla Fakturor/` för äldre format. Mappstrukturen spelar ingen roll, eftersom
sökningen är rekursiv. Filnamn följer oftast `<Bolag> faktura ... - <Anläggning>.pdf`.

## Filer

| Fil | Innehåll |
|-----|----------|
| `Makefile` | Kör stegen i rätt ordning (`make update`, `make serve` m.m.) |
| `granska.py` | Listar fakturor med anmärkning i `Granska` |
| `parse.py` | PDF-extraktion (inkrementell), en parser per bolag, `process_file()` per PDF |
| `finalize.py` | Normalisering, dubblettflaggning, CSV-skrivning, sanity-checks |
| `costs.py` | Tolkning av kostnadsrader (energi, påslag, avgifter, rabatter, moms) |
| `summarize.py` | Viktat snittpris per anläggning och bolag: per år och senaste 12 mån |
| `avtalstyp.json` | Bolag → `rorligt` eller `fast`, används för att märka avtalsperioder i webbsidan |
| `export_data.py` | Skriver `data.json` (förbrukning och betalt pris per anläggning och månad) till webbverktyget |
| `serve.py` | Lokal webbserver för `web/` utan cache |
| `web/` | Webbverktyget Elpriskollen (`index.html`, `app.js`, `calc.js`, `style.css`, `demo-data.js`) |
| `extract_spotpris.py` | Månadsmedelspris på elbörsen för SE3 → `spotpris_se3.csv` (PDF för 2023–2025, webben för senare) |
| `spotpris_se3.csv` | Spotpris per månad, öre/kWh exkl. moms, från jan 2023 |
| `tests/` | Enhetstester (`python3 -m unittest discover -s tests`) |
| `common.py` | Delade hjälpfunktioner (`sw_num`, `sw_date`, `clean_id`), `MONTHS` och sökvägar |
| `id_name.json` | Din mappning anläggnings-ID → anläggningsnamn (ligger inte i git; utgå från `id_name.example.json`) |

## Output

**Öppna i Google Sheets eller Excel:** använd `tmp/fakturor-sv.csv` och `tmp/sammanfattning-sv.csv`. De har samma
innehåll som de vanliga filerna men i svenskt format (semikolon som skiljetecken, decimalkomma, UTF-8 med BOM). Det
behövs när kalkylarket har svenska inställningar, eftersom ett belopp som `1579.08` (decimalpunkt, som i
`fakturor.csv`) där tolkas som text eller datum. I Google Sheets: *Arkiv → Importera → Ladda upp*, välj
separatortyp *Identifiera automatiskt* (eller *Semikolon*) och låt *Konvertera text till siffror, datum och formler*
vara på. Har kalkylarket engelska inställningar (*Arkiv → Inställningar → Språkversion*, t.ex. USA) går de vanliga
filerna bra. De vanliga filerna (`fakturor.csv`, `sammanfattning.csv`) används av skripten och ska inte ändras.

Anläggnings-ID (18 siffror) tolkas som ett tal i ett kalkylark och kan förlora de sista siffrorna. Använd kolumnen
*Anläggning* (namnet) för att gruppera och filtrera.

`fakturor.csv` med kolumnerna:

`Bolag, Typ (Elnät/Elhandel), Anläggning, Anläggnings-ID, Adress, Fakturanummer,
Fakturadatum, Period start, Period slut, Specifikation kostnader, Total förbrukning (kWh),
Totalsumma (SEK)`, följt av kostnadsuppdelningen för elhandel (se nedan), samt `Källfil, Granska`.

### Kostnadsuppdelning för elhandel (Fortum, Skekraft, Vattenfall)

Kostnadsraderna i specifikationen tolkas av `costs.py` till jämförbara kolumner. Alla belopp
är **exkl. moms** om inget annat anges, och blanka för elnät, Tibber och de kombinerade
Fortum/Ellevio-fakturorna.

| Kolumn | Betydelse |
|--------|-----------|
| `Energipris exkl. moms (öre/kWh)` | Fortum "El", Skekraft "Fast elpris", Vattenfall "Medelspotpris" |
| `Påslag och elcertifikat exkl. moms (öre/kWh)` | Påslag och elcertifikat (Vattenfall: rörliga kostnader + fast påslag) |
| `Rabatt rörligt exkl. moms (SEK)` | Rabatter som gäller per kWh |
| `Fast avgift exkl. moms (SEK)` / `Rabatt fast exkl. moms (SEK)` | Månads-/årsavgift och rabatter på den (Vattenfalls kampanjrabatt räknas hit) |
| `Summa exkl. moms (SEK)`, `Moms (SEK)`, `Summa inkl. moms (SEK)` | Exakta belopp från fakturan |
| `Pris exkl. moms (öre/kWh)` | **Standardjämförelsepriset:** summa exkl. moms / kWh × 100 |
| `Pris inkl. moms (öre/kWh)` | Samma, inkl. moms |
| `Ordinarie pris exkl. moms (öre/kWh)` | Pris utan några rabatter, eftersom rabatter ofta är tidsbegränsade |

### Jämförelse mot spotpris

`finalize.py` läser `spotpris_se3.csv` (se `extract_spotpris.py`) och lägger till tre kolumner
för elhandelsrader:

| Kolumn | Betydelse |
|--------|-----------|
| `Spotpris SE3 exkl. moms (öre/kWh)` | Månadsmedelspris för fakturaperioden (dagsviktat om perioden spänner över flera månader) |
| `Skillnad mot spot exkl. moms (öre/kWh)` | `Pris exkl. moms` minus spotpris, alltså vad bolaget tagit över (eller under) marknadspriset, inklusive fasta avgifter och rabatter |
| `Ordinarie skillnad mot spot exkl. moms (öre/kWh)` | Samma men utan rabatter |

Kolumnerna är blanka före spotdatats början (jan 2023). Saknas en månad i spotfilen efter det
flaggas den i `Granska`. Spotpriset är oviktat månadsmedel, så för rörliga avtal är skillnaden
en approximation. `summarize.py` visar förbrukningsviktat spotpris och skillnad per grupp, men
bara när spotpris finns för *alla* fakturor i gruppen.

`Totalsumma (SEK)` är det som ska betalas och kan vara avrundat till hela kronor (Fortum);
använd `Summa inkl. moms (SEK)` för exakta belopp. Raderna kontrollsummeras: avvikelser och
okända kostnadsrader hamnar i `Granska`.

`finalize.py` kontrollerar också att fakturaperioderna per anläggning och typ (elnät/elhandel)
ansluter till varandra, även vid leverantörsbyte. Luckor och överlapp flaggas i `Granska` på
fakturan som kommer efter, och en sammanfattning skrivs ut. Luckor kan vara legitima (en
anläggning som tagits i eller ur bruk), men bör kontrolleras innan snittpriset används.

`finalize.py` kontrollerar också att fakturaperioderna per anläggning och typ (elnät/elhandel)
ansluter till varandra, även vid leverantörsbyte. Luckor och överlapp flaggas i `Granska` på
fakturan som kommer efter, och en sammanfattning skrivs ut. Luckor kan vara legitima (en
anläggning som tagits i eller ur bruk), men bör kontrolleras innan snittpriset används.

Alla belopp är i SEK. Kolumnen `Granska` samlar varningar per rad (saknade fält,
dubbletter, parsefel); tom `Granska` betyder att raden extraherades utan anmärkning.

## Kvalitetskontroll

- **Före ändring av en parser:** kör `parse.py` och leta i `rows.json` efter rader med
  icke-tom `granska`-nyckel – det är listan över vad som inte gick att extrahera.
- **Efter varje ändring:** kör om hela pipen och titta på de sorterade belopps- och
  kWh-värdena (sanity-checks som skrivs ut av `finalize.py`). Orimligt höga eller låga värden
  avslöjar regex-buggar effektivt.

## Ny anläggning eller nytt format

- Dyker en ny anläggning upp: lägg till dess 13-siffriga anläggnings-ID i din `id_name.json` (kopiera `id_name.example.json` om du saknar den), annars används namnet från filnamnet.
- Dyker ett nytt fakturaformat upp: utöka bolagets parser i `parse.py` och kontrollera
  `granska`-listan enligt ovan.
- Dyker en ny kostnadsrad upp i en elhandelsfaktura (`okänd kostnadsrad` i `Granska`): lägg
  till etiketten i `classify()` i `costs.py` och ett test i `tests/test_costs.py`.

## Webbverktyget Elpriskollen

`web/` är en statisk webbsida (ren HTML/JS, inga beroenden) där du fyller i erbjudanden från
elhandelsbolag och får en jämförelse mot din faktiska förbrukning, med råd i klartext.

```bash
python3 export_data.py                       # skapar $WORKDIR/data.json (./tmp/data.json)
python3 serve.py                             # öppna sedan http://localhost:8765
```

`serve.py` är en liten webbserver som aldrig cachar, så ändringar syns direkt efter en uppdatering. Den gör också
att du slipper börja om varje gång (bara för anrop från din egen dator, aldrig från nätverket):

- **Data läses in automatiskt** från `tmp/data.json` (eller `$WORKDIR/data.json`), så du behöver inte välja filen.
  Läser du in en fil för hand (eller demodatan) sparas den i `tmp/web-data.json` och går före `tmp/data.json`
  vid nästa start, tills du väljer "Läs in data.json från servern" (visas under "Byt data").
- **Inställningar och erbjudanden sparas i `tmp/web-state.json`** (filter, moms, period, alla erbjudanden med
  alla fält) och finns kvar nästa gång du kör servern, oavsett webbläsare, adress eller port. De sparas också i
  webbläsaren som reserv. Filen gäller före webbläsarens kopia. "Exportera" ger en separat säkerhetskopia.

Med en vanlig webbserver (`python3 -m http.server`) eller GitHub Pages sparas inställningar, erbjudanden och inläst
data bara i webbläsaren (`localStorage`, bundet till adress och port). Med En vanlig server skickar dessutom ingen cachekontroll, så webbläsaren kan fortsätta visa gamla versioner
av `app.js` (t.ex. filter som inte går att välja) tills du gör en hård omladdning (Cmd+Shift+R).

Öppna sidan och dra in `data.json` (eller välj filen). Den läses bara i webbläsaren. Du kan också
prova direkt med **demodata** (påhittad förbrukning, verkligt spotpris). Lägg `data.json` i `web/`
om sidan ska läsa in den automatiskt när den serveras.

- **Flikar:** sidan är uppdelad i *Överblick* (säljarjämförelse och alla alternativ bredvid varandra, startsidan),
  *Erbjudanden* (dina sparade erbjudanden, med antal), *Jämförelse* (råd och detaljerad jämförelse),
  *Historik* och *Data* (läs in data). Anläggning, år, bolag och moms väljs i filterraden under flikarna, som visas
  på Överblick, Jämförelse och Historik och är hopfälld på telefon. Sidan öppnas på Data när ingen data finns. Fliken
  syns i adressen (`#historik` m.fl.), så den finns kvar efter omladdning och bakåtknappen fungerar. Pil vänster/höger
  växlar flik med tangentbordet.
- **Erbjudanden:** typ (rörligt månadspris, rörligt timpris eller fast pris), fast påslag, rörliga
  kostnader, elcertifikat, månads- och årsavgift, rabatt (öre/kWh och kr/mån). Fälten motsvarar hur jämförelsesajter som elskling.se och elpriskollen.se redovisar
  erbjudanden. Priser anges **exkl. moms** som standard (sajterna visar komponenterna exkl. moms och
  bara totalen inkl. moms), men kan växlas. De sparas i webbläsaren och kan exporteras/importeras.
- **Kontrollpris:** under varje erbjudande visas jämförpriset räknat som sajterna gör. Du anger själv
  vilken förbrukning (kWh/år, standard 20 000) och vilken månads spotpris sajten räknat på, så ska
  siffran stämma med sajtens (±0,05 öre). Årsavgift kan anges i kr/år eller öre/kWh; öre/kWh görs om
  till kr/år med sajtens förbrukning.
- **En faktura kan inte bli negativ:** kostnaden per anläggning och månad är minst 0 kr. Är en
  kampanjrabatt större än kostnaden (t.ex. 240 kr/mån på en liten anläggning) visas hur mycket av
  rabatten som inte kommer till nytta.
- **Beräkning:** dina senaste 12 (eller 24) månader räknas om för varje erbjudande, anläggning
  för anläggning, med månadsmedelspris för spot.
- **Rabatter slås av och på var för sig (fliken Jämförelse):** *Dina fakturor* kan visas "Som du betalat" (med dina
  rabatter) eller "Utan rabatt (ordinarie)", alltså som det blir när t.ex. din Vattenfall-rabatt har gått ut.
  *Erbjudanden* kan visas "Med rabatt" (deras kampanjer) eller "Utan rabatt". De två påverkar inte varandra,
  så du kan jämföra dina fakturor utan rabatt mot erbjudanden med rabatt.
- **Råd:** bästa val totalt och per anläggning, effekt av rabatter som upphör, fasta avgifters
  andel, fastpris mot marknadspriset, rörliga kostnader mot vad du själv haft,
  varning för timpris (vi räknar med månadsmedel) och för kampanjer som kan gälla per kund.
- **Avtalsperioder i grafen:** prisgrafen skuggar varje period med bolagets namn och om avtalet är
  rörligt eller fast, och markerar bolagsbyten med en streckad linje. Avtalstypen hämtas från
  `avtalstyp.json` (bolag → `rorligt`/`fast`); lägg till ett nytt bolag där, annars visas "okänd typ".
- **Överblick (startsidan):** alla alternativ bredvid varandra: dina nuvarande avtal, alla sparade erbjudanden och
  eventuellt en säljares pris. Kolumnerna svarar på frågan "är det här billigare än vad jag betalar idag?":
  *Kostnad perioden* och *Mot nuvarande* (på din egen förbrukning, de senaste 12 månaderna), *Pris på din förbrukning*
  (samma kostnad per kWh, jämförbart rakt av med dina nuvarande avtal) och *Jämförpris* (det en jämförelsesajt eller
  säljare anger, på en standardförbrukning, för att stämma av mot siffran på sajten eller i samtalet; för dina
  nuvarande avtal räknas det på samma sätt från din senaste faktura, med eller utan rabatt efter ditt val). Billigast markeras. **Visa detaljer** lägger till energipris (spotpris + påslag senaste
  månaden), avgifter per år och rabatt; valet sparas.
- **Säljare på telefon:** skriv in priset säljaren ger (öre/kWh, inkl. eller exkl. moms, rörligt eller fast) och, om du
  vet det, vilken förbrukning (kWh/år) de räknat på (standard 20 000). Priset räknas som ett **totalpris** med alla
  påslag, avgifter och rabatter inbakade per kWh på den förbrukningen, så det visas under **Jämförpris** i tabellen. Du ser direkt hur det står sig: beräknad kostnad mot dina
  nuvarande avtal och sparade erbjudanden, vilket påslag priset motsvarar, och en lista med frågor att ställa. Sidan
  varnar när priset ligger under spotpriset (ofta ett tecken på att det är exkl. moms eller ett fast/introduktionspris),
  och när din förbrukning per anläggning skiljer sig mycket från säljarens (då slår inbakade avgifter och rabatter
  annorlunda och kostnaden är bara en uppskattning). Det du skrivit sparas.
- **Vad ingår i säljarens erbjudande (valfritt):** en expanderbar ruta med samma fält som under Erbjudanden (påslag,
  rörliga kostnader, elcertifikat, månads-/årsavgift, rabatt, anteckning). Detaljerna ändrar inte priset,
  men visas i överblickens rad (avgifter, rabatt), och du får en kontroll av att de stämmer med säljarens
  totalpris (vad detaljerna blir på säljarens förbrukning, med senaste månadens spotpris, mot vad säljaren sa). "Spara som erbjudande"
  lägger erbjudandet under fliken Erbjudanden: med detaljerna om de beskriver energipriset, annars från totalpriset med detaljerna i
  anteckningen. "Rensa" tömmer säljarens erbjudande utan att röra dina sparade erbjudanden.
- **Filter (raden under flikarna):** anläggning, **år**, **elhandelsbolag** och **avtalstyp** (rörligt/fast pris). De gäller både jämförelsen och
  historiken, så du kan t.ex. se vad erbjudandena hade kostat 2024, eller bara under Skekraft-perioden.
  Är ett år eller bolag valt räknas alla månader i urvalet. Med avtalstyp "Fast pris" visar Historik en kontrollrad
  *Fast pris mot rörligt*: vad månaderna med fast pris hade kostat som spot + ett påslag du anger (öre/kWh exkl. moms,
  samma fasta avgifter), och vid vilket påslag rörligt och fast hade kostat lika.
- **Alltid högst 12 månader:** jämförelsen räknar på de senaste 12 månaderna (efter ett filter på år eller bolag de
  månader som finns i urvalet). 12 månader ger en hel säsongscykel, så vinter och sommar vägs rätt. **Alla villkor
  och rabatter antas gälla hela perioden**, så erbjudanden har ingen egen rabattlängd eller bindningstid (äldre
  sparade värden för det ignoreras).
- **Tooltips:** rubrikerna i tabellerna har förklaringar (streckad understrykning) som visas vid hovring,
  tangentbordsfokus (Tab) eller tryck. Escape stänger.
- **Historik och överblick stämmer av mot varandra:** historikens tabeller har kolumnerna *Betalt (kr)* (med dina
  rabatter) och *Utan rabatt (kr)* (samma fakturor till ordinarie pris). Överblickens rad "Dina nuvarande avtal" är det
  ena eller det andra beroende på valet *Dina fakturor* under Jämförelse, för samma period och filter.
- **Historik (fliken Historik):** iakttagelser (dyraste/billigaste månad, 12 månader mot föregående 12,
  vinterandel, rabatters effekt, vilket bolag som legat närmast spot), tabeller per år och per
  elhandelsbolag, diagram över pris mot spot, förbrukning per månad och år mot år, samt en lista
  över alla månader. För "alla anläggningar" visas också en tabell per anläggning.
- **Tester:** `cd web && node --test`.

### GitHub Pages
Publicera bara innehållet i `web/`. **Din riktiga `data.json` får aldrig ligga i det som
publiceras** (sidor på GitHub Pages är i regel publika). Den är utesluten i `.gitignore`;
`demo-data.js` är påhittad och ofarlig. På den publicerade sidan laddar du in din `data.json`
från din egen dator, och den lämnar aldrig webbläsaren.

## Kontroll av kWh mellan elnät och elhandel

Vattenfalls förbrukning tas från de fakturerade kvantiteterna på energiraderna ("Medelspotpris ... kWh"), inte från första
datumintervallet i texten (som gav fel kWh när priset ändrades under perioden). Som kontroll kan Ellevios kWh jämföras med
elhandelsfakturornas kWh för samma månad; avvikelser beror oftast på att ett leverantörsbyte mitt i månaden.
