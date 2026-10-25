/* Beräkningar för elavtalsjämförelsen. Ren logik utan DOM, så den går att testa i Node (calc.test.js).
 *
 * Alla belopp internt i SEK exkl. moms och priser i öre/kWh exkl. moms. Erbjudanden som anges
 * inkl. moms räknas om vid inläsning (toExkl). Visningen väljer själv om moms ska läggas på.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_VAT = 0.25;

  /** Tolkar inmatning ("1,5", "1.5", "") till tal; tom/ogiltig blir `fallback`. */
  function num(v, fallback) {
    if (v === '' || v === null || v === undefined) return fallback === undefined ? 0 : fallback;
    const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  /** Förbrukning (kWh/år) som erbjudandets jämförpris räknats på, standard 20 000. */
  function kwhBasis(offer) {
    return num(offer.kwhBasis, 20000) || 20000;
  }

  /** Årsavgift i kr/år, oavsett om den angetts i kr/år eller i öre/kWh (vid sajtens förbrukning). */
  function arsavgiftKr(offer) {
    return offer.arsavgiftEnhet === 'ore' ? num(offer.arsavgift) * kwhBasis(offer) / 100 : num(offer.arsavgift);
  }

  /**
   * Erbjudandets villkor omräknade till exkl. moms. Alla villkor och rabatter antas gälla hela jämförelseperioden
   * (högst 12 månader), så rabatter och bindning har ingen egen längd.
   */
  function toExkl(offer, vat) {
    const f = offer.inklMoms ? 1 / (1 + vat) : 1;
    const n = (v) => num(v) * f;
    return {
      typ: ['fast', 'timpris'].includes(offer.typ) ? offer.typ : 'rorligt',
      paslag: n(offer.paslag), rorliga: n(offer.rorliga), fastpris: n(offer.fastpris), elcert: n(offer.elcert),
      // Månads- och årsavgift läggs ihop till en avgift per månad. Årsavgift i öre/kWh gäller den förbrukning
      // sajten räknat på (kwhBasis) och görs om till kr/år, eftersom avgiften inte beror på din förbrukning.
      avgift: n(offer.manadsavgift) + arsavgiftKr(offer) * f / 12,
      rabattOre: n(offer.rabattOre), rabattKr: n(offer.rabattKr),
    };
  }

  /** Energipris (öre/kWh exkl. moms) en månad: spot (eller fastpris) + påslag + rörliga kostnader + elcertifikat − rabatt. Utan avgifter. */
  function energyOre(o, spot, idx, useRabatt) {
    return (o.typ === 'fast' ? o.fastpris : spot + o.paslag + o.rorliga) + o.elcert - (useRabatt ? o.rabattOre : 0);
  }

  /** Kostnad (SEK exkl. moms) för en månad, före golvet på 0 kr. `idx` används inte längre (rabatter gäller hela perioden) men finns kvar i signaturen. */
  function monthCost(o, kwh, spot, idx, useRabatt) {
    return kwh * energyOre(o, spot, idx, useRabatt) / 100 + o.avgift - (useRabatt ? o.rabattKr : 0);
  }

  /**
   * Begränsar datat till en anläggning, ett år, ett elhandelsbolag och/eller en avtalstyp. Spotpriserna behålls.
   * f: { anl, year, bolag, typ } (typ = 'rorligt' eller 'fast') där tomt värde betyder alla. Anläggningslistan krymps till de som har rader kvar.
   */
  function filterData(data, f) {
    f = f || {};
    const manader = data.manader.filter((m) => (!f.anl || m.anlaggning === f.anl)
      && (!f.year || m.manad.startsWith(f.year)) && (!f.bolag || m.bolag === f.bolag)
      && (!f.typ || m.avtalstyp === f.typ));
    const present = new Set(manader.map((m) => m.anlaggning));
    return Object.assign({}, data, { manader, anlaggningar: data.anlaggningar.filter((a) => present.has(a)) });
  }

  /**
   * De `n` månader som slutar vid senaste månaden med både förbrukning och spotpris, begränsade till månader som finns
   * i datat. Efter ett filter (t.ex. ett år eller ett bolag) blir fönstret därför bara de månader som finns i urvalet.
   * n = 0 ger alla månader i datat.
   */
  function windowMonths(data, n) {
    const withData = data.manader.map((m) => m.manad).filter((m) => data.spot[m] !== undefined);
    if (!withData.length) return [];
    const present = new Set(withData);
    const last = withData.reduce((a, b) => (a > b ? a : b));
    const first = withData.reduce((a, b) => (a < b ? a : b));
    let y = Number(last.slice(0, 4)), mo = Number(last.slice(5));
    const out = [];
    const count = n === 0 ? (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(last.slice(5)) - Number(first.slice(5)) + 1 : n;
    for (let i = 0; i < count; i++) {
      const month = `${y}-${String(mo).padStart(2, '0')}`;
      if (present.has(month)) out.unshift(month);
      mo -= 1;
      if (mo === 0) { mo = 12; y -= 1; }
    }
    return out;
  }

  /**
   * Jämför nuvarande kostnad (enligt fakturorna) med varje erbjudande, över samma månader.
   * opts: {
   *   months: 12,                                  // 0 = alla månader i datat
   *   baselineMode: 'betalt' | 'ordinarie',        // dina fakturor: som du betalat (med rabatt) eller utan rabatter
   *   offerMode: 'rabatt' | 'ordinarie',           // erbjudandena: med sina rabatter eller utan
   *   mode: 'rabatt' | 'ordinarie'                 // äldre: styr båda om de två ovan saknas
   * }
   * Dina fakturor och erbjudandena styrs alltså var för sig, t.ex. för att jämföra dina fakturor utan
   * rabatt (när rabatten gått ut) mot erbjudanden med deras rabatter.
   */
  function compare(data, offers, opts) {
    opts = opts || {};
    const vat = data.momssats === undefined ? DEFAULT_VAT : data.momssats;
    const months = windowMonths(data, opts.months === 0 ? 0 : (opts.months || 12));
    const useRabatt = (opts.offerMode || opts.mode) !== 'ordinarie';
    const baselineOrdinarie = (opts.baselineMode || opts.mode) === 'ordinarie';
    const norm = offers.map((o) => ({ id: o.id, o: toExkl(o, vat) }));
    const byKey = new Map(data.manader.map((m) => [`${m.anlaggning}|${m.manad}`, m]));

    const perAnl = {};
    const total = { kwh: 0, baseline: 0, baselineOrdinarie: 0, baselineBetalt: 0, fast: 0, costs: {}, wasted: {}, spotWeighted: 0 };
    norm.forEach((n) => { total.costs[n.id] = 0; total.wasted[n.id] = 0; });

    data.anlaggningar.forEach((anl) => {
      const e = { anl, monthsUsed: [], kwh: 0, baseline: 0, baselineOrdinarie: 0, baselineBetalt: 0, fast: 0, costs: {}, wasted: {}, spotWeighted: 0 };
      norm.forEach((n) => { e.costs[n.id] = 0; e.wasted[n.id] = 0; });
      months.forEach((m, idx) => {
        const row = byKey.get(`${anl}|${m}`);
        const spot = data.spot[m];
        if (!row || spot === undefined) return;
        e.monthsUsed.push(m);
        e.kwh += row.kwh;
        e.baselineBetalt += row.betalt_exkl;
        e.baselineOrdinarie += row.ordinarie_exkl;
        e.fast += row.fast_exkl;
        e.spotWeighted += spot * row.kwh;
        norm.forEach((n) => {
          // En faktura kan inte bli negativ: rabatt utöver kostnaden kommer inte till nytta
          const raw = monthCost(n.o, row.kwh, spot, idx, useRabatt);
          const cost = Math.max(0, raw);
          e.costs[n.id] += cost;
          e.wasted[n.id] += cost - raw;
        });
      });
      e.baseline = baselineOrdinarie ? e.baselineOrdinarie : e.baselineBetalt;
      perAnl[anl] = e;
      ['kwh', 'baseline', 'baselineOrdinarie', 'baselineBetalt', 'fast', 'spotWeighted'].forEach((k) => { total[k] += e[k]; });
      norm.forEach((n) => { total.costs[n.id] += e.costs[n.id]; total.wasted[n.id] += e.wasted[n.id]; });
    });

    total.spotWeighted = total.kwh ? total.spotWeighted / total.kwh : 0;
    Object.values(perAnl).forEach((e) => { e.spotWeighted = e.kwh ? e.spotWeighted / e.kwh : 0; });
    return {
      months, vat, perAnl, total, offers: norm,
      offerMode: useRabatt ? 'rabatt' : 'ordinarie', baselineMode: baselineOrdinarie ? 'ordinarie' : 'betalt',
    };
  }

  /**
   * Jämförpris så som elprisjämförelsesajter räknar det: en jämn förbrukning över året (erbjudandets
   * kwhBasis, standard 20 000 kWh) och ett givet spotpris. Används som kontroll att erbjudandet är ifyllt rätt. Inget golv på 0 kr här.
   */
  function referencePrice(offer, spot, vat, kwhPerYear, useRabatt) {
    const kwh = kwhPerYear || kwhBasis(offer);
    const v = vat === undefined ? DEFAULT_VAT : vat;
    const o = toExkl(offer, v);
    let cost = 0;
    for (let m = 0; m < 12; m++) cost += monthCost(o, kwh / 12, spot, m, useRabatt !== false);
    return { exkl: cost / kwh * 100, inkl: cost / kwh * 100 * (1 + v), kwh };
  }

  /**
   * Dina nuvarande avtal som ett erbjudande, byggt av månadens fakturor (data.json med fakturans delar): påslag eller fastpris,
   * rabatt per kWh, och fasta avgifter och rabatt i kr/mån per anläggning. Används för att räkna ett jämförpris på samma
   * sätt som för ett erbjudande. Null om delarna saknas (äldre data.json) eller månaden saknar förbrukning.
   */
  function currentOffer(data, month) {
    const rows = data.manader.filter((m) => m.manad === month);
    if (!rows.length || rows.some((r) => r.energi_exkl === undefined)) return null;
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const kwh = sum('kwh');
    if (!kwh || data.spot[month] === undefined) return null;
    const nAnl = new Set(rows.map((r) => r.anlaggning)).size;
    const fast = rows.every((r) => r.avtalstyp === 'fast');
    const perKwh = (sum('energi_exkl') + sum('paslag_exkl')) / kwh * 100;     // exkl. moms, före rabatt
    return {
      id: 'current', namn: 'Dina nuvarande avtal', inklMoms: false, kwhBasis: '20000',
      typ: fast ? 'fast' : 'rorligt',
      // Rörligt: det som ligger över spotpriset räknas som påslag. Fast: hela priset är fastpriset.
      paslag: fast ? '' : String(perKwh - data.spot[month]), fastpris: fast ? String(perKwh) : '',
      manadsavgift: String(sum('fast_brutto_exkl') / nAnl),
      rabattOre: String(-sum('rabatt_rorlig_exkl') / kwh * 100), rabattKr: String(-sum('rabatt_fast_exkl') / nAnl),
    };
  }

  /** Dina egna rörliga kostnader (öre/kWh) under perioden, för jämförelse med erbjudandens uppgifter. */
  function rorligaHistory(data, months) {
    const inWindow = new Set(months);
    const perMonth = new Map();
    const bolag = new Set();
    data.manader.forEach((r) => {
      if (!inWindow.has(r.manad) || !(r.rorliga_exkl > 0)) return;
      const m = perMonth.get(r.manad) || { kr: 0, kwh: 0 };
      m.kr += r.rorliga_exkl; m.kwh += r.kwh;
      perMonth.set(r.manad, m);
      bolag.add(r.bolag);
    });
    if (!perMonth.size) return null;
    const ores = [...perMonth.values()].map((m) => m.kr / m.kwh * 100);
    const kr = [...perMonth.values()].reduce((s, m) => s + m.kr, 0);
    const kwh = [...perMonth.values()].reduce((s, m) => s + m.kwh, 0);
    return { avg: kr / kwh * 100, min: Math.min(...ores), max: Math.max(...ores), months: perMonth.size, bolag: [...bolag].sort().join(' + ') };
  }

  /** Senaste månaden med både förbrukning och spotpris, eller null. */
  function latestMonth(data) {
    const months = data.manader.map((m) => m.manad).filter((m) => data.spot[m] !== undefined);
    return months.length ? months.reduce((a, b) => (a > b ? a : b)) : null;
  }

  /** Pris för ett erbjudande (redan omräknat med toExkl) senaste månaden: energipris, pris inkl. avgifter och avgifter per år. */
  function offerLatest(data, o, month, spot, useRabatt) {
    const latest = data.manader.filter((m) => m.manad === month);
    const kwh = latest.reduce((s, r) => s + r.kwh, 0);
    const cost = latest.reduce((s, r) => s + Math.max(0, monthCost(o, r.kwh, spot, 0, useRabatt)), 0);
    return { energyOre: energyOre(o, spot, 0, useRabatt), allInOre: kwh ? cost / kwh * 100 : null, feeYear: o.avgift * 12 };
  }

  /** Senaste månad med spotpris i datat (kan vara senare än senaste faktura). Standard för jämförpriset. */
  function latestSpotMonth(data) {
    const months = Object.keys(data.spot).sort();
    return months.length ? months[months.length - 1] : null;
  }

  /**
   * Överblick: dina nuvarande avtal och alla erbjudanden bredvid varandra. Priserna gäller senaste månaden
   * (det en säljare brukar ange), kostnaden gäller hela jämförelseperioden (som i compare). Allt exkl. moms.
   * Raden för dina nuvarande avtal har isCurrent = true.
   */
  function overview(data, offers, opts) {
    const res = compare(data, offers, opts);
    const month = latestMonth(data);
    if (!month || !res.months.length) return { month, spot: null, rows: [], res };
    const spot = data.spot[month];
    const useRabatt = res.offerMode === 'rabatt';
    const latest = data.manader.filter((m) => m.manad === month);
    const kwh = latest.reduce((s, r) => s + r.kwh, 0);
    const sum = (key) => latest.reduce((s, r) => s + r[key], 0);
    const ore = (kr) => (kwh ? kr / kwh * 100 : null);

    const ordinarie = res.baselineMode === 'ordinarie';
    const rows = [{
      id: null, namn: ordinarie ? 'Dina nuvarande avtal (utan rabatt)' : 'Dina nuvarande avtal', typ: 'nuvarande', isCurrent: true,
      bolag: [...new Set(latest.map((r) => r.bolag))].sort().join(' + '),
      // Utan rabatt går energi och avgifter inte att skilja åt, så bara totalpriset visas då
      energyOre: ordinarie ? null : ore(sum('betalt_exkl') - sum('fast_exkl')),
      allInOre: ore(ordinarie ? sum('ordinarie_exkl') : sum('betalt_exkl')),
      feeYear: ordinarie ? null : sum('fast_exkl') * 12,   // månadens fasta avgifter (netto efter rabatt) × 12
      rabatt: null, yearCost: res.total.baseline, saving: 0,
    }];

    // Jämförpris för dina nuvarande avtal: byggs av månadens fakturor och räknas som för ett erbjudande (med eller utan rabatt)
    const cur = currentOffer(data, month);
    if (cur) {
      const curSpotMonth = latestSpotMonth(data);
      const ref = referencePrice(cur, data.spot[curSpotMonth], res.vat, kwhBasis(cur), !ordinarie);
      Object.assign(rows[0], { refOre: ref.exkl, refKwh: ref.kwh, refMonth: curSpotMonth });
    }

    res.offers.forEach((n) => {
      const o = n.o;
      const offer = offers.find((x) => x.id === n.id) || {};
      const lat = offerLatest(data, o, month, spot, useRabatt);
      // Jämförpris som en jämförelsesajt räknar det (erbjudandets egen förbrukning och spotmånad), skilt från din förbrukning
      const refMonth = offer.spotManad && data.spot[offer.spotManad] !== undefined ? offer.spotManad : latestSpotMonth(data);
      const isQuote = n.id === 'quote';
      const ref = isQuote ? null : referencePrice(offer, data.spot[refMonth], res.vat, kwhBasis(offer));
      rows.push({
        id: n.id, namn: offer.namn || 'Erbjudande', typ: o.typ, isCurrent: false, isQuote, bolag: '',
        // Säljarens totalpris har inbakade avgifter och rabatter på en standardförbrukning, så det är ett jämförpris:
        // det visas där, inte som energipris eller pris på din förbrukning
        energyOre: isQuote ? null : lat.energyOre, allInOre: isQuote ? null : lat.allInOre, feeYear: lat.feeYear,
        refOre: isQuote ? lat.energyOre : (ref ? ref.exkl : null), refKwh: isQuote ? kwhBasis(offer) : (ref ? ref.kwh : null),
        refMonth: isQuote ? month : (ref ? refMonth : null),
        rabatt: o.rabattOre || o.rabattKr ? { ore: o.rabattOre, kr: o.rabattKr, active: useRabatt } : null,
        yearCost: res.total.costs[n.id], saving: res.total.baseline - res.total.costs[n.id],
      });
    });
    return { month, spot, kwh, rows, res };
  }

  /**
   * Gör en uppgift från en säljare ("95 öre/kWh") till ett erbjudande att jämföra. q: { ore, inklMoms, typ, avgiftKrAr, kwhBasis }.
   * Priset är säljarens totalpris (påslag, avgifter och rabatter inbakade), troligen räknat på en standardförbrukning (kwhBasis).
   * Rörligt: priset antas vara spot + påslag för senaste månaden, så påslaget blir priset minus månadens spotpris.
   * Fast: priset gäller hela perioden.
   */
  function quoteOffer(q, spot, vat) {
    const v = vat === undefined ? DEFAULT_VAT : vat;
    const f = q.inklMoms ? 1 / (1 + v) : 1;
    const exkl = num(q.ore) * f;
    const avgift = num(q.avgiftKrAr) * f;
    const base = { id: 'quote', namn: 'Säljarens erbjudande', inklMoms: false, arsavgift: String(avgift), arsavgiftEnhet: 'kr', kwhBasis: q.kwhBasis };
    return q.typ === 'fast'
      ? Object.assign(base, { typ: 'fast', fastpris: String(exkl) })
      : Object.assign(base, { typ: 'rorligt', paslag: String(exkl - spot), spotExkl: exkl });
  }

  const DETAIL_NUMBERS = ['fastpris', 'paslag', 'rorliga', 'elcert', 'manadsavgift', 'arsavgift', 'rabattOre', 'rabattKr'];

  /**
   * Det säljaren berättat om vad erbjudandet innehåller (valfritt). Säljarens pris är redan ett totalpris, så detaljerna
   * används bara för anteckning och jämförelse. q: { typ, detail: {...fälten som i ett erbjudande, inklMoms} }.
   */
  function quoteDetails(q, vat) {
    const d = q.detail || {};
    const v = vat === undefined ? DEFAULT_VAT : vat;
    const has = DETAIL_NUMBERS.some((k) => d[k] !== '' && d[k] !== undefined && d[k] !== null);
    const offer = Object.assign({
      id: 'quote-details', namn: d.namn || 'Säljarens erbjudande', typ: q.typ === 'fast' ? 'fast' : 'rorligt',
      arsavgiftEnhet: 'kr', inklMoms: !!d.inklMoms,
    }, DETAIL_NUMBERS.reduce((acc, k) => Object.assign(acc, { [k]: d[k] === undefined ? '' : d[k] }), {}),
    {});
    const x = toExkl(offer, v);
    return {
      has, offer,
      feeYear: x.avgift * 12,
      rabatt: x.rabattOre || x.rabattKr ? { ore: x.rabattOre, kr: x.rabattKr } : null,
    };
  }

  /**
   * Stämmer det antecknade med säljarens pris? Båda räknas på samma underlag: säljarens standardförbrukning (kWh/år)
   * och senaste månadens spotpris, så som en säljare eller jämförelsesajt räknar ett totalpris (exkl. moms).
   * Null om inga detaljer finns.
   */
  function detailsCheck(data, q, quoteOreExkl, vat, opts) {
    const det = quoteDetails(q, vat);
    const month = latestMonth(data);
    if (!det.has || !month) return null;
    const kwh = kwhBasis({ kwhBasis: q.kwhBasis });
    const ref = referencePrice(det.offer, data.spot[month], vat === undefined ? DEFAULT_VAT : vat, kwh);
    return { detailsOre: ref.exkl, quoteOre: quoteOreExkl, diff: ref.exkl - quoteOreExkl, kwh };
  }

  /** Råd för ett samtal med en säljare, utifrån en överblick som innehåller raden med id 'quote'. */
  function quoteTips(ov, view, check) {
    const vat = ov.res.vat;
    const k = view && view.inkl ? 1 + vat : 1;
    const kr = (v) => `${fmtNum(v * k, 0)} kr`;
    const ore = (v) => `${fmtNum(v * k, 1)} öre/kWh`;
    const q = ov.rows.find((r) => r.id === 'quote');
    const tips = [];
    if (!q) return tips;
    const add = (level, text) => tips.push({ level, text });
    const current = ov.rows.find((r) => r.isCurrent);
    const others = ov.rows.filter((r) => !r.isCurrent && r.id !== 'quote');

    const spotExkl = fmtNum(ov.spot, 1), spotInkl = fmtNum(ov.spot * (1 + vat), 1);
    if (q.typ === 'fast') {
      add('info', `Fast pris: ${ore(q.refOre)} för hela perioden (totalpris med inbakade avgifter och rabatter). Spotpriset senaste månaden (${ov.month}) var ${spotExkl} öre/kWh exkl. moms (${spotInkl} inkl.).`);
    } else {
      const markup = q.refOre - ov.spot;
      add('info', `Rörligt: ${ore(q.refOre)} senaste månaden (${ov.month}) = spotpris ${ore(ov.spot)} + påslag ${ore(markup)} (totalpris med inbakade avgifter och rabatter). Spotpriset var ${spotExkl} öre/kWh exkl. moms (${spotInkl} inkl.). Påslaget räknas på alla månader.`);
      if (markup < -1) {
        add('warn', `Priset ligger under spotpriset senaste månaden (${ore(-markup)} lägre). Det är ovanligt för ett rörligt avtal. Kontrollera om priset är angivet exkl. moms, om det är ett fastpris eller ett introduktionspris, eller om säljaren räknar på ett annat spotpris. Räkna med fastpris-läget om priset ska gälla hela tiden.`);
      }
    }
    const cheaperThanCurrent = q.yearCost < current.yearCost;
    add(cheaperThanCurrent ? 'good' : 'warn',
      `Beräknad kostnad ${kr(q.yearCost)} över perioden mot ${kr(current.yearCost)} hos dina nuvarande avtal: ${cheaperThanCurrent ? 'billigare' : 'dyrare'} med ${kr(Math.abs(current.yearCost - q.yearCost))}.`);
    const best = others.slice().sort((a, b) => a.yearCost - b.yearCost)[0];
    if (best) {
      const diff = q.yearCost - best.yearCost;
      if (diff > 0.5) add('warn', `Du har redan ett bättre erbjudande: ${best.namn} (${kr(best.yearCost)}), alltså ${kr(diff)} billigare än säljarens.`);
      else if (diff < -0.5) add('good', `Säljarens erbjudande är billigare än alla dina sparade erbjudanden. Närmast är ${best.namn} (${kr(best.yearCost)}), ${kr(-diff)} dyrare.`);
      else add('info', `Säljarens erbjudande kostar lika mycket som ${best.namn} (${kr(best.yearCost)}).`);
    }
    // Säljarens totalpris har avgifter och rabatter inbakade per kWh på en standardförbrukning. Räknar vi det på din
    // förbrukning blir resultatet en uppskattning, och en sämre sådan ju mer förbrukningarna skiljer sig åt.
    const nAnl = Object.values(ov.res.perAnl).filter((e) => e.kwh > 0).length || 1;
    const yearKwh = ov.res.total.kwh / Math.max(1, ov.res.months.length) * 12 / nAnl;
    const ratio = q.refKwh ? yearKwh / q.refKwh : 1;
    add('info', `Beräkningen antar att totalpriset gäller varje kWh du förbrukar. Avgifter och rabatter är inbakade per kWh på säljarens förbrukning (${fmtNum(q.refKwh, 0)} kWh/år), så kostnaden är en uppskattning.`);
    if (ratio < 0.5 || ratio > 2) {
      add('warn', `Säljarens pris är räknat på ${fmtNum(q.refKwh, 0)} kWh/år, men din förbrukning är ca ${fmtNum(yearKwh, 0)} kWh/år per anläggning (valda filter). Fasta avgifter och rabatter som ingår i priset slår olika hårt beroende på förbrukning, så din verkliga kostnad kan avvika mycket från den beräknade. Fråga hur priset är uppbyggt och vilken förbrukning de räknat på.`);
    }
    if (check) {
      if (Math.abs(check.diff) <= 1) {
        add('good', `Det du antecknat om vad erbjudandet innehåller motsvarar ${ore(check.detailsOre)} vid ${fmtNum(check.kwh || 20000, 0)} kWh/år (inkl. avgifter och rabatter), och säljaren sa ${ore(check.quoteOre)}. Det stämmer.`);
      } else {
        add('warn', `Det du antecknat motsvarar ${ore(check.detailsOre)} vid ${fmtNum(check.kwh || 20000, 0)} kWh/år (inkl. avgifter och rabatter), men säljaren sa ${ore(check.quoteOre)}: ${ore(Math.abs(check.diff))} ${check.diff > 0 ? 'högre' : 'lägre'}. ${check.diff > 0 ? 'Säljarens pris verkar innehålla mindre än du antecknat, till exempel en rabatt eller lägre avgifter.' : 'Säljarens pris verkar innehålla mer än du antecknat, till exempel avgifter, elcertifikat eller rörliga kostnader som saknas i listan.'} Fråga vad som ingår.`);
      }
    }
    add('info', 'Fråga säljaren om: månadsavgift och årsavgift, om rörliga kostnader och elcertifikat ingår i priset, hur länge en kampanjrabatt gäller (och om den gäller per anläggning), bindningstid och uppsägningstid, samt om priset är månadsmedel eller timpris.');
    return tips;
  }

  /** Billigaste alternativet (nuvarande avtal eller något erbjudande) per anläggning. */
  function bestPerAnl(res) {
    const out = {};
    Object.values(res.perAnl).forEach((e) => {
      let best = { id: null, cost: e.baseline };
      res.offers.forEach((n) => { if (e.kwh && e.costs[n.id] < best.cost) best = { id: n.id, cost: e.costs[n.id] }; });
      out[e.anl] = best;
    });
    return out;
  }

  function bestSingle(res) {
    let best = null;
    res.offers.forEach((n) => {
      const c = res.total.costs[n.id];
      if (best === null || c < best.cost) best = { id: n.id, cost: c };
    });
    return best;
  }

  const fmtNum = (v, d) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);

  /** Råd i klartext. view: { inkl: bool } styr om belopp visas inkl. moms. */
  function advice(data, offers, opts, view) {
    const res = compare(data, offers, opts);
    const k = view && view.inkl ? 1 + res.vat : 1;
    const kr = (v) => `${fmtNum(v * k, 0)} kr`;
    const ore = (v) => `${fmtNum(v * k, 1)} öre/kWh`;
    const name = (id) => (offers.find((o) => o.id === id) || {}).namn || 'Erbjudande';
    const tips = [];
    const add = (level, text) => tips.push({ level, text });
    const t = res.total;

    const short = Object.values(res.perAnl).filter((e) => e.monthsUsed.length < res.months.length);
    if (!res.months.length || !t.kwh) {
      add('warn', 'Ingen förbrukningsdata att räkna på. Ladda in data.json eller demodata.');
      return tips;
    }
    if (short.length) {
      add('warn', `Förbrukning saknas för några månader (${short.map((e) => `${e.anl}: ${e.monthsUsed.length} av ${res.months.length}`).join(', ')}). Jämförelsen gäller bara månader som finns i datat.`);
    }
    if (!offers.length) {
      add('info', 'Lägg till minst ett erbjudande för att få en jämförelse.');
      return tips;
    }

    const single = bestSingle(res);
    const baseTxt = res.baselineMode === 'ordinarie' ? 'dina fakturor utan rabatt (ordinarie pris)' : 'vad du betalat';
    const saving = t.baseline - single.cost;
    if (saving > Math.max(300, 0.03 * t.baseline)) {
      add('good', `${name(single.id)} är billigast som ett enda val för alla anläggningar: ca ${kr(saving)} per år billigare (${fmtNum(saving / t.baseline * 100, 0)} %) än ${baseTxt} (${kr(t.baseline)}).`);
    } else if (saving > 0) {
      add('info', `Bästa erbjudandet (${name(single.id)}) sparar bara ca ${kr(saving)} per år. Det är marginellt och lönar sig knappast att byta för.`);
    } else {
      add('warn', `Inget erbjudande är billigare än ${baseTxt} (${kr(t.baseline)} per år). Behåll nuvarande avtal.`);
    }

    const mix = bestPerAnl(res);
    const mixCost = Object.values(mix).reduce((s, b) => s + b.cost, 0);
    if (single.cost - mixCost >= 200) {
      const lines = Object.entries(mix).map(([a, b]) => `${a}: ${b.id ? name(b.id) : 'behåll nuvarande'}`).join('; ');
      add('info', `Du kan välja avtal per anläggning (de har separata avtal). Billigast blir: ${lines}. Det är ${kr(single.cost - mixCost)} per år billigare än ett enda erbjudande för alla.`);
    }

    // Rabatter: räkna om utan (eller med) rabatt och se om rangordningen mellan erbjudandena ändras
    if (offers.some((o) => { const x = toExkl(o, res.vat); return x.rabattOre || x.rabattKr; })) {
      const flipped = res.offerMode === 'rabatt' ? 'ordinarie' : 'rabatt';
      const other = compare(data, offers, { months: opts.months, offerMode: flipped, baselineMode: res.baselineMode });
      const otherBest = bestSingle(other);
      if (otherBest && otherBest.id !== single.id) {
        const withR = res.offerMode === 'rabatt' ? single : otherBest;
        const withoutR = res.offerMode === 'rabatt' ? otherBest : single;
        add('warn', `Rangordningen beror på rabatterna: ${name(withR.id)} är billigast med erbjudandenas rabatter, men ${name(withoutR.id)} är billigast utan rabatt (på sikt).`);
      }
    }

    // Rabatter som inte kommer till nytta, timpris och kampanjvillkor
    offers.forEach((o) => {
      const x = toExkl(o, res.vat);
      const nm = o.namn || 'Erbjudande';
      const wasted = res.total.wasted[o.id] || 0;
      if (wasted > 50) {
        const where = Object.values(res.perAnl).filter((e) => (e.wasted[o.id] || 0) > 1).map((e) => e.anl).join(', ');
        add('warn', `${nm}: rabatten är större än kostnaden för ${where} i vissa månader. Ca ${kr(wasted)} av rabatten kommer inte till nytta (en faktura kan inte bli negativ), så besparingen blir mindre än rabatten ser ut.`);
      }
      if (x.typ === 'timpris') {
        add('warn', `${nm} är ett timprisavtal. Vi räknar med månadsmedel av spotpriset, så verklig kostnad beror på när under dygnet du förbrukar och kan avvika.`);
      }
      if (x.rabattKr && data.anlaggningar.length > 1) {
        add('info', `${nm}: kampanjrabatten (${kr(x.rabattKr)} per månad) kan gälla per kund och inte per anläggning, och kampanjer erbjuds ofta bara nya kunder. Vi räknar den på varje anläggning, så kontrollera villkoren.`);
      }
    });

    // Rörliga kostnader mot vad du själv haft
    const hist = rorligaHistory(data, res.months);
    if (hist) {
      offers.filter((o) => { const x = toExkl(o, res.vat); return x.typ !== 'fast' && x.rorliga > 0; }).forEach((o) => {
        const x = toExkl(o, res.vat);
        const higher = x.rorliga - hist.avg > 2;
        add(higher ? 'warn' : 'info', `${o.namn || 'Erbjudande'}: rörliga kostnader ${ore(x.rorliga)}. De varierar månadsvis. ${hist.bolag} hade hos dig i snitt ${ore(hist.avg)} (${fmtNum(hist.min * k, 1)} till ${fmtNum(hist.max * k, 1)}) under ${hist.months} månader. ${higher ? 'Erbjudandets siffra är högre än vad du haft.' : 'Det ligger i linje med vad du haft.'}`);
      });
    }

    // Dina nuvarande rabatter
    const rabattNu = t.baselineOrdinarie - t.baselineBetalt;
    if (res.baselineMode === 'ordinarie') {
      if (rabattNu > Math.max(300, 0.03 * t.baselineBetalt)) {
        add('info', `Dina fakturor räknas utan rabatt, alltså som priset blir när dina nuvarande rabatter (ca ${kr(rabattNu)} per år) har gått ut: ${ore(t.baselineOrdinarie / t.kwh * 100)} i stället för ${ore(t.baselineBetalt / t.kwh * 100)}.`);
      }
    } else if (rabattNu > Math.max(300, 0.03 * t.baselineBetalt)) {
      add('warn', `Dina nuvarande avtal har rabatter på ca ${kr(rabattNu)} per år. Slutar de gälla blir ditt pris ${ore(t.baselineOrdinarie / t.kwh * 100)} i stället för ${ore(t.baselineBetalt / t.kwh * 100)}. Växla Dina fakturor till "Utan rabatt" för att jämföra mot det.`);
    }

    // Fast avgift som andel av kostnaden för vald lösning. För erbjudanden räknas kostnaden utan rabatter,
    // annars kan en stor kampanjrabatt ge en andel över 100 %.
    const ordRes = res.offerMode === 'ordinarie' ? res : compare(data, offers, { months: opts.months, offerMode: 'ordinarie', baselineMode: res.baselineMode });
    Object.entries(mix).forEach(([a, b]) => {
      const o = b.id ? toExkl(offers.find((x) => x.id === b.id), res.vat) : null;
      const fee = o ? o.avgift * res.perAnl[a].monthsUsed.length : res.perAnl[a].fast;
      const cost = o ? ordRes.perAnl[a].costs[b.id] : b.cost;
      if (cost > 0 && fee / cost > 0.25) {
        add('info', `${a}: fasta avgifter utgör ${fmtNum(fee / cost * 100, 0)} % av kostnaden${o ? ' utan rabatt' : ''} (${kr(fee)}). Där lönar det sig mer att jämföra månadsavgiften än energipriset.`);
      }
    });

    // Fastpris och bindningstid mot marknadspriset
    offers.filter((o) => o.typ === 'fast').forEach((o) => {
      const x = toExkl(o, res.vat);
      const pris = x.fastpris + x.elcert;
      const diff = pris - t.spotWeighted;
      const bind = ' Fastpriset antas gälla hela perioden (12 månader).';
      const dir = diff > 0 ? 'över' : 'under';
      add(Math.abs(diff) > 10 && diff > 0 ? 'warn' : 'info',
        `${o.namn || 'Erbjudande'} (fastpris ${ore(pris)}) ligger ${ore(Math.abs(diff))} ${dir} snittspotpriset för perioden (${ore(t.spotWeighted)}).${bind} Det visar hur det hade gått historiskt, inte hur priserna blir framöver.`);
    });

    add('info', 'Spotpriset är månadsmedel (oviktat) för elområdet. För rörliga avtal kan verklig kostnad avvika några öre, beroende på när under månaden du förbrukar. Förbrukningen är dina faktiska månader, framtida förbrukning kan skilja.');
    return tips;
  }

  /** Månadsserie för diagram: betalt pris (öre/kWh exkl. moms, viktat över anläggningar) mot spotpris. */
  function priceSeries(data, months) {
    return months.map((m) => {
      const rows = data.manader.filter((r) => r.manad === m);
      const kwh = rows.reduce((s, r) => s + r.kwh, 0);
      const paid = rows.reduce((s, r) => s + r.betalt_exkl, 0);
      return { manad: m, spot: data.spot[m], betalt: kwh ? paid / kwh * 100 : null };
    });
  }

  /** Anläggningens (eller alla anläggningars) data per månad, med spot och skillnad mot spot. */
  function monthlyRows(data, anl) {
    const byMonth = new Map();
    data.manader.filter((r) => !anl || r.anlaggning === anl).forEach((r) => {
      let m = byMonth.get(r.manad);
      if (!m) { m = { manad: r.manad, kwh: 0, betalt: 0, ordinarie: 0, fast: 0, bolag: {}, typ: {} }; byMonth.set(r.manad, m); }
      m.kwh += r.kwh; m.betalt += r.betalt_exkl; m.ordinarie += r.ordinarie_exkl; m.fast += r.fast_exkl;
      m.bolag[r.bolag] = (m.bolag[r.bolag] || 0) + r.kwh;
      m.typ[r.avtalstyp || 'okänt'] = true;
    });
    return [...byMonth.values()].sort((a, b) => (a.manad < b.manad ? -1 : 1)).map((m) => {
      const spot = data.spot[m.manad] === undefined ? null : data.spot[m.manad];
      const paidOre = m.kwh ? m.betalt / m.kwh * 100 : null;
      return {
        manad: m.manad, kwh: m.kwh, betalt: m.betalt, ordinarie: m.ordinarie, fast: m.fast,
        bolag: Object.keys(m.bolag).sort().join(' + '), typ: Object.keys(m.typ).sort().join(' + '), spot, paidOre,
        ordinarieOre: m.kwh ? m.ordinarie / m.kwh * 100 : null,
        diff: spot !== null && paidOre !== null ? paidOre - spot : null,
      };
    });
  }

  /** Summerar månadsrader. Spotpris och skillnad vägs med kWh över de månader som har spotpris. */
  function aggregate(rows) {
    const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0);
    const withSpot = rows.filter((r) => r.spot !== null);
    const kwhS = sum(withSpot, 'kwh');
    const spotW = kwhS ? withSpot.reduce((s, r) => s + r.spot * r.kwh, 0) / kwhS : null;
    const kwh = sum(rows, 'kwh'), betalt = sum(rows, 'betalt');
    return {
      months: rows.length, kwh, betalt, ordinarie: sum(rows, 'ordinarie'), fast: sum(rows, 'fast'),
      paidOre: kwh ? betalt / kwh * 100 : null,
      ordinarieOre: kwh ? sum(rows, 'ordinarie') / kwh * 100 : null,
      spotW, diff: spotW === null ? null : sum(withSpot, 'betalt') / kwhS * 100 - spotW,
      // Skillnad mot spot utan fasta avgifter och deras rabatter, för rättvis jämförelse mellan bolag
      rorligDiff: spotW === null ? null : (sum(withSpot, 'betalt') - sum(withSpot, 'fast')) / kwhS * 100 - spotW,
      fastShare: betalt ? sum(rows, 'fast') / betalt : null,
      first: rows.length ? rows[0].manad : null, last: rows.length ? rows[rows.length - 1].manad : null,
      typ: rows.length ? rows[0].typ : null,
    };
  }

  /**
   * Kontrollrad: vad månaderna med fast pris hade kostat som rörligt avtal, alltså spotpris + påslag (öre/kWh, exkl. moms)
   * med samma fasta avgifter som du betalade. months: månadsrader från monthlyRows. Bara månader med fast pris och spotpris räknas.
   * breakEvenOre = det påslag där rörligt och fast hade kostat lika mycket. diff > 0: det fasta priset var billigare.
   */
  function fastVsRorligt(months, paslagOre) {
    const rows = months.filter((m) => m.typ === 'fast' && m.spot !== null);
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    const kwh = sum('kwh'), betalt = sum('betalt'), fast = sum('fast');
    const spotKr = rows.reduce((s, r) => s + r.kwh * r.spot / 100, 0);
    const p = num(paslagOre);
    const rorligt = spotKr + kwh * p / 100 + fast;
    return {
      months: rows.length, kwh, betalt, rorligt, diff: rorligt - betalt, paslagOre: p,
      spotOre: kwh ? spotKr / kwh * 100 : null,
      breakEvenOre: kwh ? (betalt - fast - spotKr) / kwh * 100 : null,
      first: rows.length ? rows[0].manad : null, last: rows.length ? rows[rows.length - 1].manad : null,
    };
  }

  /**
   * Visar om jämförelsefönstret blandar avtal. months: månadslistan från compare (res.months). Fönstret räknar dina
   * fakturor månad för månad, så månader med ett annat bolag eller en annan avtalstyp än det nuvarande (senaste månaden)
   * jämförs mot erbjudanden som om du haft dem då. mixed = true om fönstret har fler än ett avtal.
   * Resultat: { mixed, periods, current, olika } där olika är månaderna som inte hör till nuvarande avtal.
   */
  function windowMix(data, months) {
    const set = new Set(months);
    const rows = monthlyRows(data, '').filter((m) => set.has(m.manad));
    const per = periods(rows);
    const current = per.length ? per[per.length - 1] : null;
    const olika = current ? per.slice(0, -1).reduce((n, p) => n + p.months, 0) : 0;
    return { mixed: per.length > 1, periods: per, current, olika };
  }

  const PACKAGE_FORMAT = 'elpriskollen-paket';

  /**
   * Allt som behövs för att dela en uppsättning i EN fil: förbrukningsdata, sparade erbjudanden och inställningar
   * (filter, säljarens pris m.m.). Mottagaren läser in filen under fliken Data.
   */
  function buildPackage(data, offers, settings) {
    const st = Object.assign({}, settings);
    delete st.dataSource;
    return { format: PACKAGE_FORMAT, version: 1, skapad: new Date().toISOString().slice(0, 10), data: data || null, offers: offers || [], settings: st };
  }

  /**
   * Läser en inläst JSON och avgör vad den är: ett delningspaket, en vanlig data.json (har `manader`) eller en lista
   * med erbjudanden. Ger { data, offers, settings } där det som saknas är null. Kastar fel för okänt innehåll.
   */
  function parsePackage(obj) {
    if (Array.isArray(obj)) return { data: null, offers: obj, settings: null };
    if (obj && obj.format === PACKAGE_FORMAT) {
      return { data: obj.data || null, offers: Array.isArray(obj.offers) ? obj.offers : null, settings: obj.settings || null };
    }
    if (obj && Array.isArray(obj.manader)) return { data: obj, offers: null, settings: null };
    throw new Error('Filen är varken en delningsfil, en data.json eller en lista med erbjudanden.');
  }

  const TYP_LABEL = { rorligt: 'rörligt', fast: 'fast pris', 'okänt': 'okänd typ' };
  const typLabel = (t) => t.split(' + ').map((x) => TYP_LABEL[x] || x).join(' + ');

  /** Sammanhängande avtalsperioder (samma bolag och avtalstyp) i en månadslista: bolagsbyten blir gränser. */
  function periods(months) {
    const out = [];
    months.forEach((m, i) => {
      const last = out[out.length - 1];
      if (last && last.bolag === m.bolag && last.typ === m.typ) { last.to = i; last.last = m.manad; last.months += 1; return; }
      out.push({ bolag: m.bolag, typ: m.typ, typLabel: typLabel(m.typ), from: i, to: i, first: m.manad, last: m.manad, months: 1 });
    });
    return out;
  }

  /** Historik för en anläggning (anl = namn) eller alla (anl tom): månader, år, avtalsperioder och iakttagelser. */
  function history(data, anl, view) {
    const vat = data.momssats === undefined ? DEFAULT_VAT : data.momssats;
    const k = view && view.inkl ? 1 + vat : 1;
    const kr = (v) => `${fmtNum(v * k, 0)} kr`;
    const ore = (v) => `${fmtNum(v * k, 1)} öre/kWh`;
    const months = monthlyRows(data, anl);
    const groupBy = (fn) => {
      const g = new Map();
      months.forEach((r) => { const key = fn(r); if (!g.has(key)) g.set(key, []); g.get(key).push(r); });
      return [...g.entries()].map(([key, rows]) => Object.assign({ key }, aggregate(rows)));
    };
    const total = aggregate(months);
    const years = groupBy((r) => r.manad.slice(0, 4)).sort((a, b) => (a.key < b.key ? -1 : 1)).map((y) => Object.assign(y, { year: y.key }));
    const bolag = groupBy((r) => r.bolag).sort((a, b) => (a.first < b.first ? -1 : 1)).map((b) => Object.assign(b, { namn: b.key }));
    const perAnl = anl ? [] : data.anlaggningar.map((a) => Object.assign({ namn: a }, aggregate(monthlyRows(data, a)))).filter((a) => a.months > 0);

    const tips = [];
    const add = (level, text) => tips.push({ level, text });
    if (!months.length) {
      add('warn', 'Ingen historik hittades för valet.');
      return { months, years, bolag, perAnl, total, tips, periods: [] };
    }
    add('info', `Datat täcker ${total.months} månader (${total.first} till ${total.last}): ${fmtNum(total.kwh, 0)} kWh och ${kr(total.betalt)} i elhandelskostnad, i snitt ${ore(total.paidOre)}.`);

    const dyr = months.reduce((a, b) => (b.betalt > a.betalt ? b : a));
    const bill = months.reduce((a, b) => (b.betalt < a.betalt ? b : a));
    const dyrPris = months.reduce((a, b) => (b.paidOre > a.paidOre ? b : a));
    add('info', `Dyraste månad: ${dyr.manad} (${kr(dyr.betalt)}), billigaste: ${bill.manad} (${kr(bill.betalt)}). Högsta pris per kWh: ${dyrPris.manad} (${ore(dyrPris.paidOre)}).`);

    if (months.length >= 24) {
      const last12 = aggregate(months.slice(-12)), prev12 = aggregate(months.slice(-24, -12));
      const pct = (a, b) => (b ? (a - b) / b * 100 : 0);
      const sign = (v) => `${v >= 0 ? '+' : '−'}${fmtNum(Math.abs(v), 0)} %`;
      const spotTxt = last12.spotW !== null && prev12.spotW !== null ? ` Spotpriset var samtidigt ${sign(pct(last12.spotW, prev12.spotW))}.` : '';
      add('info', `Senaste 12 månaderna mot de 12 före: förbrukning ${sign(pct(last12.kwh, prev12.kwh))}, kostnad ${sign(pct(last12.betalt, prev12.betalt))}, pris per kWh ${sign(pct(last12.paidOre, prev12.paidOre))}.${spotTxt}`);
    }

    const comparable = bolag.filter((b) => b.months >= 3 && b.rorligDiff !== null);
    if (comparable.length >= 2) {
      const sorted = comparable.slice().sort((a, b) => a.rorligDiff - b.rorligDiff);
      const list = sorted.map((b) => `${b.namn} ${b.rorligDiff >= 0 ? '+' : '−'}${fmtNum(Math.abs(b.rorligDiff) * k, 1)} öre (${b.months} mån)`).join(', ');
      add('good', `Mot spotpriset (utan fasta avgifter) har ${sorted[0].namn} legat lägst: ${list}. Skillnaden gäller olika tidsperioder och avtalsvillkor, så den är en fingervisning.`);
    }

    if (months.length >= 12) {
      const winter = months.filter((r) => ['11', '12', '01', '02', '03'].includes(r.manad.slice(5)));
      const share = winter.reduce((s, r) => s + r.kwh, 0) / total.kwh * 100;
      add('info', `${fmtNum(share, 0)} % av förbrukningen sker november till mars. Det gör vinterns priser avgörande för totalkostnaden.`);
    }
    if (total.fastShare > 0.15) {
      add('info', `Fasta avgifter utgör ${fmtNum(total.fastShare * 100, 0)} % av kostnaden (${kr(total.fast / total.months)} per månad i snitt).`);
    }
    const rabatt = total.ordinarie - total.betalt;
    if (rabatt > Math.max(300, 0.03 * total.betalt)) {
      add('info', `Rabatter har sänkt kostnaden med ${kr(rabatt)} (${fmtNum(rabatt / total.ordinarie * 100, 0)} %) under perioden. Ordinarie pris hade varit ${ore(total.ordinarieOre)}.`);
    }
    return { months, years, bolag, perAnl, total, tips, periods: periods(months) };
  }

  return { num, toExkl, monthCost, windowMonths, compare, bestPerAnl, bestSingle, advice, priceSeries, monthlyRows, periods, typLabel, history, buildPackage, parsePackage, windowMix, fastVsRorligt, referencePrice, rorligaHistory, filterData, kwhBasis, arsavgiftKr, energyOre, latestMonth, latestSpotMonth, currentOffer, overview, offerLatest, quoteOffer, quoteDetails, detailsCheck, quoteTips, DEFAULT_VAT };
});
