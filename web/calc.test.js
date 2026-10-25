const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./calc.js');

// Två anläggningar, tre månader, 100 kWh/månad. Spot 50 öre alla månader.
function dataset(extra = {}) {
  const manader = [];
  ['2025-01', '2025-02', '2025-03'].forEach((m) => {
    ['A', 'B'].forEach((a) => manader.push({
      manad: m, anlaggning: a, bolag: 'Nu', kwh: 100, betalt_exkl: 100, ordinarie_exkl: 120, fast_exkl: 20,
    }));
  });
  return { momssats: 0.25, anlaggningar: ['A', 'B'], manader,
    spot: { '2025-01': 50, '2025-02': 50, '2025-03': 50 }, ...extra };
}
const offer = (o) => ({ id: 'x', namn: 'X', typ: 'rorligt', ...o });

test('num tolkar svenskt decimalkomma och tomt', () => {
  assert.equal(C.num('1,5'), 1.5);
  assert.equal(C.num(''), 0);
  assert.equal(C.num('abc', null), null);
});

test('inklusive moms räknas om till exklusive', () => {
  const o = C.toExkl(offer({ paslag: 12.5, manadsavgift: 125, inklMoms: true }), 0.25);
  assert.equal(o.paslag, 10);
  assert.equal(o.avgift, 100);
});

test('monthCost: rörligt = spot + påslag + elcert, plus månadsavgift', () => {
  const o = C.toExkl(offer({ paslag: 10, elcert: 2, manadsavgift: 30 }), 0.25);
  assert.equal(C.monthCost(o, 100, 50, 0, true), 100 * 62 / 100 + 30);
});

test('monthCost: fastpris ignorerar spot', () => {
  const o = C.toExkl(offer({ typ: 'fast', fastpris: 70, manadsavgift: 0 }), 0.25);
  assert.equal(C.monthCost(o, 100, 999, 0, true), 70);
});

test('rabatt gäller i alla månader när den är på, och inte alls när den är av', () => {
  const o = C.toExkl(offer({ paslag: 0, rabattKr: 10 }), 0.25);
  [0, 1, 11].forEach((idx) => assert.equal(C.monthCost(o, 100, 50, idx, true), 50 - 10));
  assert.equal(C.monthCost(o, 100, 50, 0, false), 50);
});

test('äldre sparade rabattlängder och bindningstider ignoreras: alla villkor antas gälla hela perioden', () => {
  const gammal = C.toExkl(offer({ paslag: 0, rabattKr: 10, rabattManader: 2, bindning: 3 }), 0.25);
  assert.equal(gammal.rabattManader, undefined);
  assert.equal(C.monthCost(gammal, 100, 50, 5, true), 50 - 10);     // gäller även efter "2 månader"
});

test('windowMonths slutar vid senaste månaden med spotpris och innehåller bara månader som finns i datat', () => {
  const d = dataset();
  assert.deepEqual(C.windowMonths(d, 3), ['2025-01', '2025-02', '2025-03']);
  assert.deepEqual(C.windowMonths(d, 12), ['2025-01', '2025-02', '2025-03']);   // fler än tre månader finns inte
  const long = twoYears();
  const w = C.windowMonths(long, 12);
  assert.equal(w.length, 12);
  assert.deepEqual([w[0], w[11]], ['2024-01', '2024-12']);
});

test('windowMonths efter filter på år eller bolag följer urvalet och sticker aldrig ut över det', () => {
  const d = twoYears();
  assert.equal(C.windowMonths(C.filterData(d, { year: '2023' }), 12).length, 12);
  const gamla = C.filterData(d, { bolag: 'Gamla' });                              // bara 2023
  assert.deepEqual(C.windowMonths(gamla, 12)[0], '2023-01');
  const delvis = C.filterData(d, { year: '2024' });
  delvis.manader = delvis.manader.filter((m) => m.manad <= '2024-06');            // 2024 hittills, sex månader
  assert.deepEqual(C.windowMonths(delvis, 12), ['2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06']);
});

test('compare summerar baslinje och erbjudanden över samma månader', () => {
  const r = C.compare(dataset(), [offer({ paslag: 10 })], { months: 3, mode: 'rabatt' });
  assert.equal(r.total.kwh, 600);
  assert.equal(r.total.baseline, 600);            // betalt: 6 × 100
  assert.equal(r.total.costs.x, 600 * 60 / 100);  // 600 kWh × 60 öre
  const o = C.compare(dataset(), [offer({ paslag: 10 })], { months: 3, mode: 'ordinarie' });
  assert.equal(o.total.baseline, 720);            // ordinarie: 6 × 120
});

test('månad utan spotpris eller förbrukning utesluts för alla alternativ', () => {
  const d = dataset();
  d.manader = d.manader.filter((m) => !(m.anlaggning === 'B' && m.manad === '2025-02'));
  const r = C.compare(d, [offer({ paslag: 10 })], { months: 3, mode: 'rabatt' });
  assert.equal(r.perAnl.B.monthsUsed.length, 2);
  assert.equal(r.perAnl.B.kwh, 200);
  assert.equal(r.perAnl.B.costs.x, 200 * 60 / 100);
});

test('bestPerAnl väljer nuvarande avtal när det är billigast', () => {
  const r = C.compare(dataset(), [offer({ paslag: 80 })], { months: 3, mode: 'rabatt' });
  assert.equal(C.bestPerAnl(r).A.id, null);
});

test('råd: tydlig besparing, ingen besparing och saknad data', () => {
  const view = { inkl: false };
  const good = C.advice(dataset(), [offer({ paslag: -10, namn: 'Billig' })], { months: 3, mode: 'rabatt' }, view);
  assert.equal(good[0].level, 'good');
  assert.match(good[0].text, /Billig/);
  const none = C.advice(dataset(), [offer({ paslag: 90 })], { months: 3, mode: 'rabatt' }, view);
  assert.equal(none[0].level, 'warn');
  const empty = C.advice({ ...dataset(), manader: [] }, [], {}, view);
  assert.match(empty[0].text, /Ingen förbrukningsdata/);
});

test('råd varnar när rabatterna ändrar rangordningen', () => {
  const offers = [
    offer({ id: 'k', namn: 'Kampanj', paslag: 0, rabattOre: 30, rabattManader: 1 }),
    offer({ id: 'o', namn: 'Stabil', paslag: -5 }),
  ];
  const tips = C.advice(dataset(), offers, { months: 3, mode: 'rabatt' }, { inkl: false });
  assert.ok(tips.some((t) => /Rangordningen beror på rabatterna/.test(t.text)), JSON.stringify(tips));
});

test('fastpris över snittspot ger varning och nämner bindningstid', () => {
  const tips = C.advice(dataset(), [offer({ typ: 'fast', fastpris: 80, bindning: 12, namn: 'Fast' })],
    { months: 3, mode: 'rabatt' }, { inkl: false });
  const t = tips.find((x) => /fastpris/.test(x.text));
  assert.equal(t.level, 'warn');
  assert.match(t.text, /12 månader/);
});

test('moms visas inkl. i texten när view.inkl är sant', () => {
  const ex = C.advice(dataset(), [offer({ paslag: 0 })], { months: 3, mode: 'rabatt' }, { inkl: false })[0].text;
  const inc = C.advice(dataset(), [offer({ paslag: 0 })], { months: 3, mode: 'rabatt' }, { inkl: true })[0].text;
  assert.notEqual(ex, inc);
});

test('priceSeries ger viktat betalt pris och spotpris per månad', () => {
  const s = C.priceSeries(dataset(), ['2025-01']);
  assert.equal(s[0].betalt, 100);
  assert.equal(s[0].spot, 50);
});

// --- Historik ---
function twoYears() {
  const manader = [], spot = {};
  for (let i = 0; i < 24; i++) {
    const y = 2023 + Math.floor(i / 12), m = (i % 12) + 1;
    const month = `${y}-${String(m).padStart(2, '0')}`;
    spot[month] = 50;
    const bolag = i < 12 ? 'Gamla' : 'Nya';
    // Gamla betalar 60 öre/kWh, Nya 55 öre/kWh. A förbrukar 100 kWh, B 50 kWh per månad.
    [['A', 100], ['B', 50]].forEach(([a, kwh]) => manader.push({
      manad: month, anlaggning: a, bolag, kwh, betalt_exkl: kwh * (i < 12 ? 0.6 : 0.55) + 10,
      ordinarie_exkl: kwh * (i < 12 ? 0.6 : 0.55) + 20, fast_exkl: 10,
    }));
  }
  return { momssats: 0.25, anlaggningar: ['A', 'B'], manader, spot };
}

test('history: en anläggning filtrerar rader, alla summerar per månad', () => {
  const d = twoYears();
  const a = C.history(d, 'A', { inkl: false });
  assert.equal(a.months.length, 24);
  assert.equal(a.months[0].kwh, 100);
  const all = C.history(d, '', { inkl: false });
  assert.equal(all.months[0].kwh, 150);
  assert.equal(all.perAnl.length, 2);
  assert.equal(all.perAnl[1].namn, 'B');
});

test('history: år och avtalsperioder aggregeras med viktat spotpris', () => {
  const h = C.history(twoYears(), 'A', { inkl: false });
  assert.deepEqual(h.years.map((y) => [y.year, y.months]), [['2023', 12], ['2024', 12]]);
  assert.equal(h.years[0].kwh, 1200);
  assert.equal(h.years[0].spotW, 50);
  assert.equal(h.bolag.map((b) => b.namn).join(), 'Gamla,Nya');
  assert.ok(Math.abs(h.bolag[0].paidOre - 70) < 1e-9);     // (60 öre * 100 kWh + 10 kr) / 100 kWh
  assert.ok(Math.abs(h.bolag[0].diff - 20) < 1e-9);        // 70 - 50
  assert.ok(Math.abs(h.bolag[1].diff - 15) < 1e-9);
});

test('history: iakttagelser om år-mot-år och bolag', () => {
  const tips = C.history(twoYears(), 'A', { inkl: false }).tips;
  assert.ok(tips.some((t) => /Senaste 12 månaderna mot de 12 före/.test(t.text)));
  const best = tips.find((t) => t.level === 'good');
  assert.match(best.text, /har Nya legat lägst/);
  assert.ok(tips.some((t) => /november till mars/.test(t.text)));
});

test('history: tom data ger varning, och moms påverkar texten', () => {
  const e = C.history({ ...twoYears(), manader: [] }, '', {});
  assert.equal(e.tips[0].level, 'warn');
  const ex = C.history(twoYears(), 'A', { inkl: false }).tips[0].text;
  const inc = C.history(twoYears(), 'A', { inkl: true }).tips[0].text;
  assert.notEqual(ex, inc);
});

test('history: månad utan spotpris ger null och ingår inte i spotsnittet', () => {
  const d = twoYears();
  delete d.spot['2023-01'];
  const h = C.history(d, 'A', {});
  assert.equal(h.months[0].spot, null);
  assert.equal(h.months[0].diff, null);
  assert.equal(h.years[0].spotW, 50);
});

test('history: bolagsjämförelsen räknar bort fasta avgifter', () => {
  const h = C.history(twoYears(), 'A', { inkl: false });
  // Gamla: (60 öre * 100 kWh + 10 kr - 10 kr fast) / 100 kWh = 60 öre, spot 50 => +10
  assert.ok(Math.abs(h.bolag[0].rorligDiff - 10) < 1e-9);
  assert.ok(Math.abs(h.bolag[1].rorligDiff - 5) < 1e-9);
});

test('periods: bolagsbyten ger gränser och avtalstyp följer med', () => {
  const d = twoYears();
  d.manader.forEach((m) => { m.avtalstyp = m.bolag === 'Gamla' ? 'fast' : 'rorligt'; });
  const h = C.history(d, 'A', {});
  assert.deepEqual(h.periods.map((p) => [p.bolag, p.typ, p.from, p.to, p.months]),
    [['Gamla', 'fast', 0, 11, 12], ['Nya', 'rorligt', 12, 23, 12]]);
  assert.equal(h.periods[0].typLabel, 'fast pris');
  assert.equal(h.bolag.find((b) => b.namn === 'Nya').typ, 'rorligt');
});

test('periods: saknad avtalstyp blir okänd', () => {
  const h = C.history(twoYears(), 'A', {});
  assert.equal(h.periods[0].typ, 'okänt');
  assert.equal(C.typLabel('okänt'), 'okänd typ');
});

// --- Erbjudanden från jämförelsesajter (Tranås Energi och E.ON, spot 87,33 öre) ---
const TRANAS = { id: 'tr', namn: 'Tranås', typ: 'rorligt', paslag: '1.70', rorliga: '6.90', arsavgift: '212', inklMoms: false };
const EON = { id: 'eon', namn: 'E.ON', typ: 'rorligt', paslag: '3.00', rorliga: '9.13', arsavgift: '662.40',
  rabattKr: '240', rabattManader: '12', inklMoms: false };

test('årsavgift delas på 12 och läggs till månadsavgiften', () => {
  assert.equal(C.toExkl({ manadsavgift: '5', arsavgift: '120' }, 0.25).avgift, 15);
});

test('rörliga kostnader ingår för rörligt avtal men inte för fastpris', () => {
  const r = C.toExkl(offer({ paslag: 2, rorliga: 5 }), 0.25);
  assert.equal(C.monthCost(r, 100, 50, 0, true), 100 * 57 / 100);
  const f = C.toExkl(offer({ typ: 'fast', fastpris: 70, rorliga: 5 }), 0.25);
  assert.equal(C.monthCost(f, 100, 50, 0, true), 70);
});

test('referencePrice reproducerar jämförelsesajternas pris vid 20 000 kWh/år', () => {
  assert.ok(Math.abs(C.referencePrice(TRANAS, 87.33, 0.25).inkl - 121.23) < 0.03);
  assert.ok(Math.abs(C.referencePrice(EON, 87.33, 0.25).inkl - 110.47) < 0.03);
});

test('rabatt över kostnaden ger aldrig negativ kostnad och räknas som outnyttjad', () => {
  const o = offer({ id: 'k', paslag: 0, rabattKr: 1000, rabattManader: 3 });
  const r = C.compare(dataset(), [o], { months: 3, mode: 'rabatt' });
  assert.equal(r.total.costs.k, 0);
  assert.ok(r.total.wasted.k > 0);
  // kostnaden per månad är 50 kr (100 kWh * 50 öre), rabatten 1000 => 950 outnyttjad per månad och anläggning
  assert.equal(r.perAnl.A.wasted.k, 950 * 3);
});

test('råd: outnyttjad rabatt, timpris och kampanj per kund varnas för', () => {
  const offers = [offer({ id: 'k', namn: 'Kampanj', paslag: 0, rabattKr: 1000, rabattManader: 3 }),
    offer({ id: 't', namn: 'Timpris', typ: 'timpris', paslag: 5 })];
  const text = C.advice(dataset(), offers, { months: 3, mode: 'rabatt' }, { inkl: false }).map((t) => t.text).join('\n');
  assert.match(text, /Kampanj: rabatten är större än kostnaden/);
  assert.match(text, /Timpris är ett timprisavtal/);
  assert.match(text, /kan gälla per kund/);
});

test('råd jämför rörliga kostnader med dina egna', () => {
  const d = dataset();
  d.manader.forEach((m) => { m.rorliga_exkl = m.kwh * 0.05; });         // 5 öre/kWh hos dig
  const high = C.advice(d, [offer({ namn: 'Dyr', paslag: 0, rorliga: 9 })], { months: 3, mode: 'rabatt' }, { inkl: false });
  const t = high.find((x) => /rörliga kostnader/.test(x.text));
  assert.equal(t.level, 'warn');
  assert.match(t.text, /Nu hade hos dig i snitt 5,0 öre/);
  const same = C.advice(d, [offer({ namn: 'Lik', paslag: 0, rorliga: 6 })], { months: 3, mode: 'rabatt' }, { inkl: false });
  assert.equal(same.find((x) => /rörliga kostnader/.test(x.text)).level, 'info');
});

test('rorligaHistory är null när data saknar rörliga kostnader', () => {
  assert.equal(C.rorligaHistory(dataset(), ['2025-01']), null);
});

test('andel fasta avgifter överstiger aldrig 100 % trots stor kampanjrabatt', () => {
  const offers = [offer({ id: 'k', namn: 'Kampanj', paslag: 0, manadsavgift: 100, rabattKr: 1000, rabattManader: 12 })];
  const tips = C.advice(dataset(), offers, { months: 3, mode: 'rabatt' }, { inkl: false });
  const fee = tips.filter((t) => /fasta avgifter utgör/.test(t.text));
  assert.ok(fee.length > 0);
  fee.forEach((t) => assert.ok(Number(t.text.match(/utgör (\d+) %/)[1]) <= 100, t.text));
});

// --- Filter, årsavgift i öre/kWh och jämförpris på valfri förbrukning ---
test('årsavgift i öre/kWh görs om till kr/år med sajtens förbrukning', () => {
  const o = offer({ arsavgift: '1.06', arsavgiftEnhet: 'ore', kwhBasis: '20000' });
  assert.ok(Math.abs(C.arsavgiftKr(o) - 212) < 1e-9);
  assert.ok(Math.abs(C.toExkl(o, 0.25).avgift - 212 / 12) < 1e-9);
  // samma öre/kWh på en annan förbrukning ger en annan årsavgift
  assert.ok(Math.abs(C.arsavgiftKr({ ...o, kwhBasis: '5000' }) - 53) < 1e-9);
  // kr/år påverkas inte av förbrukningen
  assert.equal(C.arsavgiftKr(offer({ arsavgift: '212', kwhBasis: '5000' })), 212);
});

test('jämförpriset följer vald förbrukning (årsavgiften sprids över färre kWh)', () => {
  const kr = offer({ paslag: 10, arsavgift: '240', arsavgiftEnhet: 'kr', inklMoms: false });
  const at20k = C.referencePrice({ ...kr, kwhBasis: '20000' }, 50, 0.25).exkl;
  const at5k = C.referencePrice({ ...kr, kwhBasis: '5000' }, 50, 0.25).exkl;
  assert.ok(Math.abs(at20k - (60 + 240 / 20000 * 100)) < 1e-9);
  assert.ok(Math.abs(at5k - (60 + 240 / 5000 * 100)) < 1e-9);
});

test('filterData begränsar på anläggning, år och bolag och krymper anläggningslistan', () => {
  const d = twoYears();
  assert.equal(C.filterData(d, { year: '2024' }).manader.length, 24);
  assert.equal(C.filterData(d, { bolag: 'Gamla' }).manader.length, 24);       // 12 månader x 2 anläggningar
  assert.deepEqual(C.filterData(d, { anl: 'B' }).anlaggningar, ['B']);
  const none = C.filterData(d, { year: '2030' });
  assert.deepEqual([none.manader.length, none.anlaggningar.length], [0, 0]);
  assert.equal(C.filterData(d, { year: '2023' }).spot['2024-01'], 50);          // spotpriser behålls
  assert.equal(C.filterData(d).manader.length, 48);
  d.manader.forEach((m) => { m.avtalstyp = m.bolag === 'Gamla' ? 'fast' : 'rorligt'; });
  assert.equal(C.filterData(d, { typ: 'fast' }).manader.length, 24);
  assert.equal(C.filterData(d, { typ: 'rorligt' }).manader.length, 24);
});

test('filtrerat på bolag räknar jämförelsen bara över bolagets månader', () => {
  const d = C.filterData(twoYears(), { bolag: 'Gamla' });
  const r = C.compare(d, [offer({ paslag: 0 })], { months: 12, mode: 'rabatt' });
  assert.equal(r.months[11], '2023-12');            // fönstret slutar där bolagets data slutar
  assert.equal(r.total.kwh, 12 * 150);
});

test('history: anläggningar utan rader efter filter visas inte i tabellen per anläggning', () => {
  const d = twoYears();
  d.manader = d.manader.filter((m) => !(m.anlaggning === 'B' && m.manad.startsWith('2024')));
  const h = C.history(C.filterData(d, { year: '2024' }), '', {});
  assert.deepEqual(h.perAnl.map((a) => a.namn), ['A']);
});

test('windowMonths med 0 ger alla månader i datat', () => {
  const m = C.windowMonths(twoYears(), 0);
  assert.equal(m.length, 24);
  assert.deepEqual([m[0], m[23]], ['2023-01', '2024-12']);
  const r = C.compare(twoYears(), [offer({ paslag: 0 })], { months: 0, mode: 'rabatt' });
  assert.equal(r.months.length, 24);
  assert.equal(r.total.kwh, 24 * 150);
});

// --- Rabatt på dina fakturor och på erbjudandena styrs var för sig ---
const KAMPANJ = offer({ id: 'k', namn: 'Kampanj', paslag: 0, rabattOre: 20, rabattManader: 12 });

test('fakturornas läge påverkar bara fakturorna, erbjudandenas läge bara erbjudandena', () => {
  const run = (baselineMode, offerMode) => C.compare(dataset(), [KAMPANJ], { months: 3, baselineMode, offerMode });
  const a = run('betalt', 'rabatt');
  const b = run('ordinarie', 'rabatt');
  const c = run('betalt', 'ordinarie');
  assert.equal(a.total.baseline, 600);                       // betalt: 6 x 100
  assert.equal(b.total.baseline, 720);                       // ordinarie: 6 x 120
  assert.equal(b.total.costs.k, a.total.costs.k);            // erbjudandet opåverkat av fakturornas läge
  assert.equal(c.total.baseline, a.total.baseline);          // fakturorna opåverkade av erbjudandenas läge
  assert.ok(c.total.costs.k > a.total.costs.k);              // utan rabatt är erbjudandet dyrare
  assert.deepEqual([b.baselineMode, b.offerMode, c.baselineMode, c.offerMode], ['ordinarie', 'rabatt', 'betalt', 'ordinarie']);
});

test('äldre opts.mode styr fortfarande båda', () => {
  const r = C.compare(dataset(), [KAMPANJ], { months: 3, mode: 'ordinarie' });
  assert.equal(r.total.baseline, 720);
  assert.equal(r.offerMode, 'ordinarie');
});

test('råd: jämförelse mot fakturor utan rabatt nämns i texten, och rabattvarningen byts mot en upplysning', () => {
  const view = { inkl: false };
  const d = dataset();
  d.manader.forEach((m) => { m.ordinarie_exkl = 400; });      // rabatten är 300 kr per månad och anläggning, över varningströskeln
  const tips = (baselineMode) => C.advice(d, [offer({ paslag: -10, namn: 'Billig' })], { months: 3, baselineMode, offerMode: 'rabatt' }, view).map((t) => t.text);
  const paid = tips('betalt').join('\n');
  assert.match(paid, /än vad du betalat/);
  assert.match(paid, /Dina nuvarande avtal har rabatter/);
  const ord = tips('ordinarie').join('\n');
  assert.match(ord, /än dina fakturor utan rabatt \(ordinarie pris\)/);
  assert.doesNotMatch(ord, /Dina nuvarande avtal har rabatter/);
  assert.match(ord, /Dina fakturor räknas utan rabatt/);
});

test('råd: erbjudandens rabatt kan slås av utan att fakturorna ändras', () => {
  const offers = [offer({ id: 'k', namn: 'Kampanj', paslag: 0, rabattOre: 30, rabattManader: 1 }), offer({ id: 'o', namn: 'Stabil', paslag: -5 })];
  const withR = C.advice(dataset(), offers, { months: 3, baselineMode: 'ordinarie', offerMode: 'rabatt' }, { inkl: false });
  const noR = C.advice(dataset(), offers, { months: 3, baselineMode: 'ordinarie', offerMode: 'ordinarie' }, { inkl: false });
  assert.match(withR.find((t) => /Rangordningen/.test(t.text)).text, /Kampanj är billigast med erbjudandenas rabatter, men Stabil är billigast utan rabatt/);
  assert.match(noR.find((t) => /Rangordningen/.test(t.text)).text, /Kampanj är billigast med erbjudandenas rabatter, men Stabil är billigast utan rabatt/);
});

// --- Överblick och säljarens pris ---
test('latestMonth är senaste månaden med både förbrukning och spotpris', () => {
  assert.equal(C.latestMonth(dataset()), '2025-03');
  const d = dataset();
  delete d.spot['2025-03'];
  assert.equal(C.latestMonth(d), '2025-02');
});

test('overview: priser för senaste månaden och kostnad över perioden', () => {
  const ov = C.overview(dataset(), [offer({ id: 'o', namn: 'Billig', paslag: 10, manadsavgift: 20 })], { months: 3, baselineMode: 'betalt', offerMode: 'rabatt' });
  assert.equal(ov.month, '2025-03');
  assert.equal(ov.spot, 50);
  const [cur, o] = ov.rows;
  assert.equal(cur.isCurrent, true);
  assert.equal(cur.energyOre, 80);     // (betalt 100 - fast 20) / 100 kWh = 80 öre
  assert.equal(cur.allInOre, 100);     // betalt 100 kr / 100 kWh
  assert.equal(cur.feeYear, 2 * 20 * 12);
  assert.equal(o.energyOre, 60);       // spot 50 + påslag 10
  assert.equal(o.allInOre, 80);        // 100 kWh * 60 öre + 20 kr avgift = 80 kr per 100 kWh
  assert.equal(o.feeYear, 240);
  const res = C.compare(dataset(), [offer({ id: 'o', paslag: 10, manadsavgift: 20 })], { months: 3, baselineMode: 'betalt', offerMode: 'rabatt' });
  assert.equal(o.yearCost, res.total.costs.o);
  assert.equal(o.saving, res.total.baseline - res.total.costs.o);
});

test('overview: nuvarande avtal utan rabatt visar bara totalpris', () => {
  const ov = C.overview(dataset(), [], { months: 3, baselineMode: 'ordinarie', offerMode: 'rabatt' });
  assert.equal(ov.rows[0].energyOre, null);
  assert.equal(ov.rows[0].allInOre, 120);
  assert.match(ov.rows[0].namn, /utan rabatt/);
});

test('overview: kampanjrabatt syns i priset senaste månaden bara när erbjudandenas rabatt är på', () => {
  const o = offer({ id: 'k', paslag: 0, rabattOre: 20, rabattKr: 5, rabattManader: 12 });
  const on = C.overview(dataset(), [o], { months: 3, offerMode: 'rabatt' }).rows[1];
  const off = C.overview(dataset(), [o], { months: 3, offerMode: 'ordinarie' }).rows[1];
  assert.equal(on.energyOre, 30);
  assert.equal(off.energyOre, 50);
  assert.ok(on.allInOre < off.allInOre);
  assert.deepEqual([on.rabatt.ore, on.rabatt.kr, on.rabatt.manader], [20, 5, undefined]);
});

test('quoteOffer: rörligt pris blir spot + påslag, och moms räknas av', () => {
  const q = C.quoteOffer({ ore: 93.75, inklMoms: true, typ: 'rorligt', avgiftKrAr: 0 }, 50, 0.25);
  assert.equal(q.typ, 'rorligt');
  assert.ok(Math.abs(Number(q.paslag) - 25) < 1e-9);       // 93,75 / 1,25 = 75 exkl; 75 - 50 spot
  const f = C.quoteOffer({ ore: 60, inklMoms: false, typ: 'fast', avgiftKrAr: 300 }, 50, 0.25);
  assert.equal(f.typ, 'fast');
  assert.equal(f.fastpris, '60');
  assert.equal(C.toExkl(f, 0.25).avgift, 25);               // 300 kr/år = 25 kr/mån
});

test('quoteTips: jämför säljarens pris med nuvarande avtal och sparade erbjudanden', () => {
  const offers = [offer({ id: 'b', namn: 'Bästa', paslag: 5 })];
  const spot = 50;
  const cheap = C.quoteOffer({ ore: 50, inklMoms: false, typ: 'rorligt', avgiftKrAr: 0 }, spot, 0.25);
  const dear = C.quoteOffer({ ore: 90, inklMoms: false, typ: 'rorligt', avgiftKrAr: 0 }, spot, 0.25);
  const run = (q) => C.quoteTips(C.overview(dataset(), [...offers, q], { months: 3, baselineMode: 'betalt', offerMode: 'rabatt' }), { inkl: false });
  const tCheap = run({ ...cheap, id: 'quote' });
  assert.ok(tCheap.some((t) => t.level === 'good' && /billigare än alla dina sparade/.test(t.text)), JSON.stringify(tCheap));
  const tDear = run({ ...dear, id: 'quote' });
  assert.ok(tDear.some((t) => t.level === 'warn' && /Du har redan ett bättre erbjudande: Bästa/.test(t.text)), JSON.stringify(tDear));
  assert.ok(tDear.some((t) => /Fråga säljaren om/.test(t.text)));
  assert.match(tDear[0].text, /spotpris 50,0 öre\/kWh \+ påslag 40,0 öre\/kWh/);
});

test('quoteTips utan säljarrad ger inga råd', () => {
  assert.deepEqual(C.quoteTips(C.overview(dataset(), [], { months: 3 }), {}), []);
});

test('quoteTips varnar när ett rörligt pris ligger under spotpriset och visar spot med och utan moms', () => {
  const run = (ore, inklMoms) => {
    const q = { ...C.quoteOffer({ ore, inklMoms, typ: 'rorligt', avgiftKrAr: 0 }, 50, 0.25), id: 'quote' };
    return C.quoteTips(C.overview(dataset(), [q], { months: 3, baselineMode: 'betalt', offerMode: 'rabatt' }), { inkl: false });
  };
  const low = run(46, true);   // 46 inkl = 36,8 exkl, under spot 50
  assert.ok(low.some((t) => t.level === 'warn' && /ligger under spotpriset senaste månaden/.test(t.text)), JSON.stringify(low));
  assert.match(low[0].text, /50,0 öre\/kWh exkl\. moms \(62,5 inkl\.\)/);
  const ok = run(75, false);
  assert.ok(!ok.some((t) => /ligger under spotpriset/.test(t.text)));
});

// --- Detaljer om säljarens erbjudande (anteckning och kontroll) ---
const noDetail = { namn: '', inklMoms: false, paslag: '', rorliga: '', elcert: '', fastpris: '', manadsavgift: '', arsavgift: '',
  rabattOre: '', rabattKr: '', rabattManader: '', bindning: '', anteckning: '' };

test('quoteDetails: tomma detaljer räknas inte, avgifter räknas per år och moms räknas av', () => {
  assert.equal(C.quoteDetails({ typ: 'rorligt', detail: noDetail }, 0.25).has, false);
  const d = C.quoteDetails({ typ: 'rorligt', detail: { ...noDetail, manadsavgift: '125', arsavgift: '125', inklMoms: true, rabattKr: '25', rabattManader: '12', bindning: '12' } }, 0.25);
  assert.equal(d.has, true);
  assert.ok(Math.abs(d.feeYear - (100 * 12 + 100)) < 1e-9);          // (125 kr/mån + 125 kr/år) exkl moms
  assert.equal(d.rabatt.kr, 20);
  assert.equal(d.rabatt.manader, undefined);   // rabatten antas gälla hela perioden
});

test('detailsCheck: detaljer som stämmer med totalpriset ger ingen avvikelse', () => {
  const q = { typ: 'rorligt', detail: { ...noDetail, paslag: '10', rorliga: '5', elcert: '1' } };    // spot 50 + 16 = 66 öre exkl
  const c = C.detailsCheck(dataset(), q, 66, 0.25, { offerMode: 'rabatt' });
  assert.ok(Math.abs(c.detailsOre - 66) < 1e-9);
  assert.ok(Math.abs(c.diff) < 1e-9);
});

test('detailsCheck: avgifter som inte ingår i totalpriset syns som avvikelse, räknade på säljarens förbrukning', () => {
  const q = { typ: 'rorligt', detail: { ...noDetail, paslag: '10', rorliga: '5', elcert: '1', manadsavgift: '100' } };
  const c = C.detailsCheck(dataset(), q, 66, 0.25, { offerMode: 'rabatt' });
  assert.ok(Math.abs(c.detailsOre - 72) < 1e-9);       // 100 kr/mån x 12 = 1 200 kr/år på 20 000 kWh = 6 öre extra
  assert.ok(Math.abs(c.diff - 6) < 1e-9);
  assert.equal(c.kwh, 20000);
  const small = C.detailsCheck(dataset(), { ...q, kwhBasis: '5000' }, 66, 0.25, {});
  assert.ok(Math.abs(small.detailsOre - 90) < 1e-9);   // samma avgift fördelad på 5 000 kWh: 24 öre extra
});

test('detailsCheck: null utan detaljer, och fast pris använder fastpris-fältet', () => {
  assert.equal(C.detailsCheck(dataset(), { typ: 'rorligt', detail: noDetail }, 66, 0.25, {}), null);
  const fast = C.detailsCheck(dataset(), { typ: 'fast', detail: { ...noDetail, fastpris: '70' } }, 70, 0.25, {});
  assert.ok(Math.abs(fast.diff) < 1e-9);
});

test('quoteTips: kontrollen sägs "stämmer" eller förklarar avvikelsen', () => {
  const q = { ...C.quoteOffer({ ore: 66, inklMoms: false, typ: 'rorligt', avgiftKrAr: 0 }, 50, 0.25), id: 'quote' };
  const ov = C.overview(dataset(), [q], { months: 3, baselineMode: 'betalt', offerMode: 'rabatt' });
  const good = C.quoteTips(ov, { inkl: false }, { detailsOre: 66, quoteOre: 66, diff: 0 });
  assert.ok(good.some((t) => t.level === 'good' && /Det stämmer/.test(t.text)));
  const high = C.quoteTips(ov, { inkl: false }, { detailsOre: 86, quoteOre: 66, diff: 20 });
  assert.ok(high.some((t) => t.level === 'warn' && /20,0 öre\/kWh högre/.test(t.text) && /rabatt eller lägre avgifter/.test(t.text)));
  const low = C.quoteTips(ov, { inkl: false }, { detailsOre: 60, quoteOre: 66, diff: -6 });
  assert.ok(low.some((t) => t.level === 'warn' && /lägre/.test(t.text) && /saknas i listan/.test(t.text)));
  assert.ok(!C.quoteTips(ov, { inkl: false }).some((t) => /antecknat/.test(t.text)));    // ingen kontroll utan detaljer
});

test('offerLatest ger samma siffror som överblickens rad', () => {
  const o = offer({ id: 'x', paslag: 10, manadsavgift: 20 });
  const ov = C.overview(dataset(), [o], { months: 3, offerMode: 'rabatt' });
  const lat = C.offerLatest(dataset(), C.toExkl(o, 0.25), ov.month, ov.spot, true);
  assert.deepEqual([lat.energyOre, lat.allInOre, lat.feeYear], [ov.rows[1].energyOre, ov.rows[1].allInOre, ov.rows[1].feeYear]);
});

test('quoteTips: lika dyrt som ett sparat erbjudande ger ingen "−0 kr dyrare"', () => {
  const same = offer({ id: 'b', namn: 'Likadan', paslag: 20 });
  const q = { ...C.quoteOffer({ ore: 70, inklMoms: false, typ: 'rorligt', avgiftKrAr: 0 }, 50, 0.25), id: 'quote' };   // spot 50 + påslag 20
  const tips = C.quoteTips(C.overview(dataset(), [same, q], { months: 3, baselineMode: 'betalt', offerMode: 'rabatt' }), { inkl: false });
  assert.ok(tips.some((t) => /kostar lika mycket som Likadan/.test(t.text)), JSON.stringify(tips));
  assert.ok(!tips.some((t) => /−0|-0 kr/.test(t.text)));
});

// --- Överblickens kolumner mot jämförpriset ---
test('overview: jämförpriset följer erbjudandets egen förbrukning och spotmånad, inte din förbrukning', () => {
  const o = offer({ id: 'k', namn: 'Kampanj', paslag: 10, arsavgift: '240', rabattKr: '100', kwhBasis: '20000', spotManad: '2025-01' });
  const d = dataset();
  d.spot['2025-01'] = 80;                                    // en annan spotmånad än den senaste (50)
  const row = C.overview(d, [o], { months: 3, offerMode: 'rabatt' }).rows[1];
  const expected = C.referencePrice(o, 80, 0.25, 20000);
  assert.ok(Math.abs(row.refOre - expected.exkl) < 1e-9);
  assert.equal(row.refKwh, 20000);
  assert.equal(row.refMonth, '2025-01');
  assert.notEqual(Math.round(row.refOre * 100), Math.round(row.allInOre * 100));   // olika förbrukning och spot ger olika tal
});

test('overview: utan egen spotmånad används senaste månad med spotpris', () => {
  const o = offer({ id: 'k', paslag: 10 });
  const ov = C.overview(dataset(), [o], { months: 3, offerMode: 'rabatt' });
  assert.equal(ov.rows[1].refMonth, '2025-03');
  assert.equal(ov.rows[1].isQuote, false);
});

test('overview: säljarens totalpris visas som jämförpris (på säljarens förbrukning), inte som energipris eller pris på din förbrukning', () => {
  const q = { ...C.quoteOffer({ ore: 70, inklMoms: false, typ: 'rorligt', avgiftKrAr: 0, kwhBasis: '12000' }, 50, 0.25), id: 'quote' };
  const row = C.overview(dataset(), [q], { months: 3, offerMode: 'rabatt' }).rows.find((r) => r.id === 'quote');
  assert.equal(row.isQuote, true);
  assert.equal(row.energyOre, null);
  assert.equal(row.allInOre, null);
  assert.ok(Math.abs(row.refOre - 70) < 1e-9);
  assert.equal(row.refKwh, 12000);
  assert.equal(row.refMonth, '2025-03');
  assert.ok(row.yearCost > 0);                 // kostnaden över perioden räknas fortfarande
});

test('quoteTips: antagandet förklaras, och en förbrukning som avviker mycket från säljarens varnas för', () => {
  const run = (kwhBasis) => {
    const q = { ...C.quoteOffer({ ore: 70, inklMoms: false, typ: 'rorligt', avgiftKrAr: 0, kwhBasis }, 50, 0.25), id: 'quote' };
    return C.quoteTips(C.overview(dataset(), [q], { months: 3, baselineMode: 'betalt', offerMode: 'rabatt' }), { inkl: false });
  };
  // dataset: 600 kWh på 3 månader för 2 anläggningar = 2 400 kWh/år, alltså 1 200 kWh/år per anläggning
  const far = run('20000');
  assert.ok(far.some((t) => /antar att totalpriset gäller varje kWh/.test(t.text)));
  assert.ok(far.some((t) => t.level === 'warn' && /räknat på 20\s000 kWh\/år, men din förbrukning är ca 1\s200 kWh\/år per anläggning/.test(t.text)), JSON.stringify(far));
  const near = run('1500');
  assert.ok(!near.some((t) => /men din förbrukning är ca/.test(t.text)));
  assert.ok(near.some((t) => /antar att totalpriset/.test(t.text)));
});

test('overview: en kampanjrabatt i kr/mån större än avgifterna gör "allt inkl." lägre än energipriset', () => {
  const o = offer({ id: 'k', paslag: 10, arsavgift: '120', rabattKr: '50' });          // avgift 10 kr/mån, rabatt 50 kr/mån
  const row = C.overview(dataset(), [o], { months: 3, offerMode: 'rabatt' }).rows[1];
  assert.ok(row.allInOre < row.energyOre);
  // 100 kWh/anläggning och månad: (60 öre * 100 kWh + 10 - 50 kr) / 100 kWh = 20 öre, men golvet 0 kr gäller ej här (kostnaden är positiv)
  assert.ok(Math.abs(row.allInOre - 20) < 1e-9);
});

// --- Jämförpris för dina nuvarande avtal (byggt av fakturans delar) ---
function partsDataset(extra = {}) {
  // En månad, två anläggningar, 100 kWh var: energi = spot (50 öre), påslag 10 öre, fast avgift 20 kr, rabatt 5 öre/kWh och 8 kr
  const manader = ['A', 'B'].map((a) => ({
    manad: '2025-03', anlaggning: a, bolag: 'Nu', avtalstyp: 'rorligt', kwh: 100,
    betalt_exkl: 67, ordinarie_exkl: 80, fast_exkl: 12,
    energi_exkl: 50, paslag_exkl: 10, fast_brutto_exkl: 20, rabatt_rorlig_exkl: -5, rabatt_fast_exkl: -8, ...extra,
  }));
  return { momssats: 0.25, anlaggningar: ['A', 'B'], manader, spot: { '2025-03': 50 } };
}

test('currentOffer: dina fakturor blir ett erbjudande med påslag, rabatt och avgifter per anläggning', () => {
  const c = C.currentOffer(partsDataset(), '2025-03');
  assert.equal(c.typ, 'rorligt');
  assert.ok(Math.abs(Number(c.paslag) - 10) < 1e-9);          // (50 + 10) öre/kWh minus spot 50
  assert.ok(Math.abs(Number(c.manadsavgift) - 20) < 1e-9);    // 40 kr på två anläggningar
  assert.ok(Math.abs(Number(c.rabattOre) - 5) < 1e-9);
  assert.ok(Math.abs(Number(c.rabattKr) - 8) < 1e-9);
});

test('currentOffer: fasta avtal blir fastpris, och saknade delar ger null', () => {
  const fast = C.currentOffer(partsDataset({ avtalstyp: 'fast' }), '2025-03');
  assert.equal(fast.typ, 'fast');
  assert.ok(Math.abs(Number(fast.fastpris) - 60) < 1e-9);
  assert.equal(C.currentOffer(dataset(), '2025-03'), null);          // äldre data utan delar
  assert.equal(C.currentOffer(partsDataset(), '2030-01'), null);     // månad utan förbrukning
});

test('overview: dina nuvarande avtal får ett jämförpris, med eller utan rabatt efter valet för dina fakturor', () => {
  const withR = C.overview(partsDataset(), [], { months: 1, baselineMode: 'betalt', offerMode: 'rabatt' }).rows[0];
  // 1 667 kWh/mån: energi 55 öre (spot 50 + påslag 10 - rabatt 5), avgift 20 - 8 kr/mån => (916,67 + 12) * 12 / 20 000 = 55,72 öre
  assert.ok(Math.abs(withR.refOre - 55.72) < 1e-9, String(withR.refOre));
  assert.equal(withR.refKwh, 20000);
  assert.equal(withR.refMonth, '2025-03');
  const without = C.overview(partsDataset(), [], { months: 1, baselineMode: 'ordinarie', offerMode: 'rabatt' }).rows[0];
  assert.ok(Math.abs(without.refOre - 61.2) < 1e-9);                 // utan rabatt: energi 60 öre + avgift 20 kr/mån
  const noParts = C.overview(dataset(), [], { months: 3, baselineMode: 'betalt' }).rows[0];
  assert.equal(noParts.refOre, undefined);                           // data utan delar: inget jämförpris
});

test('jämförpriset för nuvarande avtal är jämförbart med ett erbjudande med samma villkor', () => {
  const same = offer({ id: 'x', namn: 'Likadant', paslag: 10, rabattOre: 5, manadsavgift: 20, rabattKr: 8 });
  const ov = C.overview(partsDataset(), [same], { months: 1, baselineMode: 'betalt', offerMode: 'rabatt' });
  assert.ok(Math.abs(ov.rows[0].refOre - ov.rows[1].refOre) < 1e-9);
});

test('fastVsRorligt: fast pris mot spot + påslag med samma fasta avgifter', () => {
  const m = (manad, typ, kwh, betalt, fast, spot) => ({ manad, typ, kwh, betalt, fast, spot });
  const rows = [m('2025-01', 'fast', 1000, 700, 50, 60), m('2025-02', 'fast', 1000, 700, 50, 40),
    m('2025-03', 'rorligt', 1000, 500, 0, 40), m('2025-04', 'fast', 1000, 700, 50, null)];
  const r = C.fastVsRorligt(rows, '10');
  assert.equal(r.months, 2);                                  // bara fast pris med spotpris
  assert.equal(r.kwh, 2000);
  assert.equal(r.betalt, 1400);
  assert.ok(Math.abs(r.rorligt - 1300) < 1e-9);                // spot 1000 + påslag 200 + fast 100
  assert.ok(Math.abs(r.diff - (-100)) < 1e-9);                 // rörligt 1300 mot fast 1400: rörligt billigare
  assert.ok(Math.abs(r.breakEvenOre - 15) < 1e-9);             // (1400-100-1000)/2000*100
  assert.equal(C.fastVsRorligt(rows.slice(2, 3), '10').months, 0);
});

test('windowMix: varnar när fönstret blandar bolag och avtalstyper', () => {
  const mk = (manad, bolag, avtalstyp) => ({ manad, anlaggning: 'A', bolag, avtalstyp, kwh: 100, betalt_exkl: 50, ordinarie_exkl: 50, fast_exkl: 0 });
  const data = { manader: [mk('2025-01', 'Skekraft', 'fast'), mk('2025-02', 'Skekraft', 'fast'), mk('2025-03', 'Vattenfall', 'rorligt')],
    anlaggningar: ['A'], spot: { '2025-01': 50, '2025-02': 50, '2025-03': 50 } };
  const r = C.windowMix(data, ['2025-01', '2025-02', '2025-03']);
  assert.equal(r.mixed, true);
  assert.equal(r.olika, 2);
  assert.equal(r.current.bolag, 'Vattenfall');
  const ren = C.windowMix(data, ['2025-03']);
  assert.equal(ren.mixed, false);
  assert.equal(ren.olika, 0);
});
