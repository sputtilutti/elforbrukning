/* Gränssnitt för Elpriskollen. Beräkningarna ligger i calc.js. */
(function () {
  'use strict';
  const C = window.Calc;
  const OFFERS_KEY = 'elpriskollen.offers.v1';
  const SETTINGS_KEY = 'elpriskollen.settings.v1';
  const DATA_KEY = 'elpriskollen.data.v1';
  // Jämförelser görs över högst 12 månader (efter filter bara de månader som finns i urvalet). Alla villkor och rabatter
  // antas gälla hela perioden, så erbjudanden har ingen egen rabattlängd eller bindningstid.
  const COMPARE_MONTHS = 12;

  const $ = (sel, el) => (el || document).querySelector(sel);
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* utan lagring går sidan ändå att använda */ } },
  };
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `o${Date.now()}${Math.random().toString(16).slice(2)}`);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (d) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: d, minimumFractionDigits: d });
  const fmtKr = (v) => `${nf(0).format(v)} kr`;
  const fmtOre = (v) => nf(1).format(v);

  // dataSource 'manual' = datat valdes för hand (fil eller demo) och går före serverns data.json vid start
  // baseline: dina fakturor 'betalt' (med rabatt) eller 'ordinarie' (utan). offerRabatt: erbjudandena 'rabatt' eller 'ordinarie'.
  const TYP_VALJ = { rorligt: 'Rörligt avtal', fast: 'Fast pris' };
  const DEFAULT_SETTINGS = { showDetails: false, baseline: 'betalt', offerRabatt: 'rabatt', inkl: false, anl: '', year: '', bolag: '', typ: '', paslag: '11,7', dataSource: '',
    quote: {
      ore: '', inklMoms: true, typ: 'rorligt', kwhBasis: '', open: false,
      detail: { namn: '', inklMoms: false, fastpris: '', paslag: '', rorliga: '', elcert: '', manadsavgift: '', arsavgift: '',
        rabattOre: '', rabattKr: '', anteckning: '' },
    } };

  /** Slår ihop sparade inställningar med standardvärden. Det äldre gemensamma läget `mode` delas upp i de två nya. */
  function normalizeSettings(saved) {
    const s = Object.assign({}, DEFAULT_SETTINGS, saved || {});
    if (saved && saved.mode && !saved.baseline && !saved.offerRabatt) {
      const ord = saved.mode === 'ordinarie';
      s.baseline = ord ? 'ordinarie' : 'betalt';
      s.offerRabatt = ord ? 'ordinarie' : 'rabatt';
    }
    s.quote = Object.assign({}, DEFAULT_SETTINGS.quote, s.quote || {});
    s.quote.detail = Object.assign({}, DEFAULT_SETTINGS.quote.detail, (saved && saved.quote && saved.quote.detail) || {});
    delete s.quote.avgift;
    delete s.mode;
    delete s.months;      // jämförelsen räknar alltid på högst 12 månader
    return s;
  }
  const state = {
    data: null,
    offers: store.get(OFFERS_KEY, []),
    settings: normalizeSettings(store.get(SETTINGS_KEY, {})),
  };
  const server = { available: false, hasData: false, timer: null };

  /** Sparar inställningar och erbjudanden i webbläsaren, och i en fil via serve.py när den körs. */
  function persist() {
    store.set(OFFERS_KEY, state.offers);
    store.set(SETTINGS_KEY, state.settings);
    if (!server.available) return;
    clearTimeout(server.timer);
    server.timer = setTimeout(() => {
      fetch('api/state', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, offers: state.offers, settings: state.settings }),
      }).catch(() => { /* servern borta: webbläsarens kopia finns kvar */ });
    }, 300);
  }

  /** Läser sparat tillstånd från serve.py. Filen på servern gäller före webbläsarens kopia. */
  async function loadServerState() {
    try {
      const r = await fetch('api/state', { cache: 'no-store' });
      if (r.status === 204) { server.available = true; persist(); return; }   // inget sparat än: spara det som finns
      if (!r.ok) return;                                                       // vanlig webbserver utan sparning
      const saved = await r.json();
      server.available = true;
      if (Array.isArray(saved.offers)) state.offers = saved.offers.map((o) => newOffer(o));
      if (saved.settings) state.settings = normalizeSettings(saved.settings);
      store.set(OFFERS_KEY, state.offers);
      store.set(SETTINGS_KEY, state.settings);
      render();
    } catch (e) { /* ingen server med sparning: bara webbläsaren används */ }
  }

  function newOffer(over) {
    return Object.assign({
      id: uid(), namn: `Erbjudande ${state.offers.length + 1}`, typ: 'rorligt', paslag: '', rorliga: '', fastpris: '', elcert: '',
      manadsavgift: '', arsavgift: '', arsavgiftEnhet: 'kr', rabattOre: '', rabattKr: '',
      // Underlaget för sajtens jämförpris: förbrukning per år och vilken månads spotpris som användes ('' = senaste)
      kwhBasis: '20000', spotManad: '',
      // Jämförelsesajter anger komponenterna oftast exkl. moms och bara totalen inkl. moms
      inklMoms: false, anteckning: '',
    }, over || {});
  }

  /* ---------- Data ---------- */
  /** Sparar inläst data så den finns kvar efter omladdning: i webbläsaren och, via serve.py, i en fil. */
  function rememberData(data) {
    store.set(DATA_KEY, data);
    if (!server.available) return;
    fetch('api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(() => {});
  }

  /** opts.manual: datat valdes för hand (fil/demo) och ska sparas och gå före serverns data.json vid nästa start. */
  function setData(data, opts) {
    if (!data || !Array.isArray(data.manader) || !data.spot || !Array.isArray(data.anlaggningar)) {
      throw new Error('Filen ser inte ut som en data.json från export_data.py.');
    }
    state.data = data;
    if (opts && opts.manual) {
      state.settings.dataSource = 'manual';
      rememberData(data);
      persist();
      render();
      showTab('oversikt');
      return;
    }
    render();
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try { setData(JSON.parse(reader.result), { manual: true }); } catch (e) { alert(`Kunde inte läsa filen: ${e.message}`); }
    };
    reader.readAsText(file);
  }

  async function fetchJson(url) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      return r.status === 200 ? await r.json() : null;
    } catch (e) { return null; }
  }

  /** Startdata: serverns data.json (tmp/data.json) eller senast inlästa fil, i den ordning som gäller för valet. */
  async function loadInitialData() {
    const serverFile = await fetchJson('data.json');
    server.hasData = !!serverFile;
    const remembered = async () => (server.available ? await fetchJson('api/data') : null) || store.get(DATA_KEY, null);
    const order = state.settings.dataSource === 'manual' ? [remembered, async () => serverFile] : [async () => serverFile, remembered];
    for (const get of order) {
      const d = await get();
      if (!d) continue;
      try { setData(d); return; } catch (e) { /* ogiltig fil, prova nästa källa */ }
    }
    render();
  }

  function renderStatus() {
    const el = $('#data-status');
    const d = state.data;
    $('#dropzone').hidden = !!d;
    $('#btn-server-data').hidden = !server.hasData;
    el.hidden = !d;
    if (!d) return;
    const months = d.manader.map((m) => m.manad).sort();
    el.innerHTML = [
      d.demo ? '<span class="chip demo">Demodata, påhittad förbrukning</span>' : '',
      `<span class="chip">${d.anlaggningar.length} anläggningar</span>`,
      `<span class="chip">${esc(months[0])} till ${esc(months[months.length - 1])}</span>`,
      `<span class="chip">Elområde ${esc(d.elomrade || '')}</span>`,
      '<button class="btn small" id="btn-change" type="button">Byt data</button>',
    ].join('');
  }

  function renderSeg(id, options, current, onPick) {
    const el = $(id);
    el.innerHTML = options.map(([value, label]) =>
      `<button type="button" role="radio" aria-checked="${String(value) === String(current)}" data-v="${esc(value)}">${esc(label)}</button>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('button');
      if (b) onPick(b.dataset.v);
    };
  }

  /** Data begränsat av filtren (anläggning, år, elhandelsbolag). */
  function scoped() {
    const s = state.settings;
    return state.data ? C.filterData(state.data, { anl: s.anl, year: s.year, bolag: s.bolag, typ: s.typ }) : null;
  }

  function fillSelect(id, allLabel, values, current) {
    const sel = $(id);
    sel.innerHTML = [`<option value="">${esc(allLabel)}</option>`].concat(values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)).join('');
    sel.value = current;
    sel.disabled = !values.length;
  }

  function renderSettings() {
    const s = state.settings;
    const d = state.data;
    const anls = d ? d.anlaggningar : [];
    const years = d ? [...new Set(d.manader.map((m) => m.manad.slice(0, 4)))].sort() : [];
    const bolag = d ? [...new Set(d.manader.map((m) => m.bolag))].sort() : [];
    const typer = d ? [...new Set(d.manader.map((m) => m.avtalstyp).filter((t) => TYP_VALJ[t]))].sort() : [];
    // Ett sparat filter som inte finns i det inlästa datat nollställs. Utan inläst data rörs det inte,
    // annars skulle filtren försvinna innan datat hunnit läsas in.
    if (d) {
      if (s.anl && !anls.includes(s.anl)) s.anl = '';
      if (s.year && !years.includes(s.year)) s.year = '';
      if (s.bolag && !bolag.includes(s.bolag)) s.bolag = '';
      if (s.typ && !typer.includes(s.typ)) s.typ = '';
    }
    fillSelect('#sel-anl', 'Alla anläggningar', anls, s.anl);
    fillSelect('#sel-year', 'Alla år', years, s.year);
    fillSelect('#sel-bolag', 'Alla bolag', bolag, s.bolag);
    $('#sel-typ').innerHTML = ['<option value="">Alla avtalstyper</option>'].concat(typer.map((t) => `<option value="${t}">${TYP_VALJ[t]}</option>`)).join('');
    $('#sel-typ').value = s.typ;
    $('#sel-typ').disabled = !typer.length;
    $('#filter-summary').textContent = `Filter: ${[s.anl || 'Alla anläggningar', s.year || 'Alla år', s.bolag || 'Alla bolag', TYP_VALJ[s.typ] || 'Alla avtalstyper', s.inkl ? 'inkl. moms' : 'exkl. moms'].join(' · ')}`;
    renderSeg('#seg-base', [['betalt', 'Som du betalat'], ['ordinarie', 'Utan rabatt (ordinarie)']], s.baseline, (v) => update({ baseline: v }));
    renderSeg('#seg-offer', [['rabatt', 'Med rabatt'], ['ordinarie', 'Utan rabatt']], s.offerRabatt, (v) => update({ offerRabatt: v }));
    renderSeg('#seg-vat', [['ex', 'Exkl. moms'], ['inkl', 'Inkl. moms']], s.inkl ? 'inkl' : 'ex', (v) => update({ inkl: v === 'inkl' }));
  }

  function update(patch) {
    Object.assign(state.settings, patch);
    persist();
    renderSettings();
    renderResults();
  }

  function field(o, key, label, opts) {
    opts = opts || {};
    return `<div class="field ${opts.span ? 'span2' : ''}"><label>${label}
      <input type="text" inputmode="${opts.text ? 'text' : 'decimal'}" data-field="${key}" value="${esc(o[key])}" ${opts.ph ? `placeholder="${esc(opts.ph)}"` : ''}></label></div>`;
  }

  /** Spotmånad som erbjudandets jämförpris räknas med: vald månad, annars senaste i datat. */
  function spotMonthFor(o) {
    const d = state.data;
    const months = Object.keys(d.spot).sort();
    return o.spotManad && d.spot[o.spotManad] !== undefined ? o.spotManad : months[months.length - 1];
  }

  /** Jämförpris enligt sajternas metod (vald förbrukning och spotmånad), som kontroll av ifyllnaden. */
  function checkHtml(o) {
    const d = state.data;
    if (!d) return 'Ladda in din förbrukning för att få ett kontrollpris att stämma av mot jämförelsesajten.';
    const month = spotMonthFor(o);
    const kwh = C.kwhBasis(o);
    const ref = C.referencePrice(o, d.spot[month], d.momssats, kwh);
    if (!(ref.exkl > 0)) return 'Fyll i priset så visas ett kontrollpris här.';
    return `Kontrollpris vid ${nf(0).format(kwh)} kWh/år och spotpris ${esc(month)} (${nf(2).format(d.spot[month])} öre): <strong>${nf(2).format(ref.inkl)} öre/kWh inkl. moms</strong> (${nf(2).format(ref.exkl)} exkl.). Stämmer det med siffran på jämförelsesajten? (Räkna med ±0,05 öre, eftersom vår spotprisfil har en decimal.)`;
  }

  function spotMonthSelect(o) {
    if (!state.data) return '<select data-field="spotManad" disabled><option>Ladda in data</option></select>';
    const d = state.data;
    const months = Object.keys(d.spot).sort().reverse();
    const latest = months[0];
    return `<select data-field="spotManad">
      <option value="" ${o.spotManad ? '' : 'selected'}>Senaste (${esc(latest)})</option>
      ${months.map((m) => `<option value="${esc(m)}" ${o.spotManad === m ? 'selected' : ''}>${esc(m)} (${nf(1).format(d.spot[m])} öre)</option>`).join('')}
    </select>`;
  }

  function offerCard(o) {
    const sel = (v) => (o.typ === v ? 'selected' : '');
    const priceFields = o.typ === 'fast'
      ? field(o, 'fastpris', 'Fastpris (öre/kWh)', { ph: 't.ex. 75' })
      : field(o, 'paslag', 'Fast påslag (öre/kWh)', { ph: 't.ex. 3' }) + field(o, 'rorliga', 'Rörliga kostnader (öre/kWh)', { ph: 'varierar månadsvis' });
    return `<article class="offer" data-id="${esc(o.id)}">
      <div class="offer-head">
        <div class="field name-field"><label>Namn
          <input class="name" type="text" data-field="namn" value="${esc(o.namn)}"></label></div>
        <div class="field"><label>Typ
          <select data-field="typ">
            <option value="rorligt" ${sel('rorligt')}>Rörligt, månadspris</option>
            <option value="timpris" ${sel('timpris')}>Rörligt, timpris</option>
            <option value="fast" ${sel('fast')}>Fast pris</option>
          </select></label></div>
        <div class="field"><label>Priserna är angivna
          <select data-field="inklMoms">
            <option value="0" ${o.inklMoms ? '' : 'selected'}>Exkl. moms</option>
            <option value="1" ${o.inklMoms ? 'selected' : ''}>Inkl. moms</option>
          </select></label></div>
        <div class="offer-actions">
          <button class="btn small" type="button" data-action="dup">Duplicera</button>
          <button class="btn small danger" type="button" data-action="del">Ta bort</button>
        </div>
      </div>
      <div class="fields">
        ${priceFields}
        ${field(o, 'elcert', 'Elcertifikat (öre/kWh)', { ph: '0 om det ingår' })}
        ${field(o, 'manadsavgift', 'Månadsavgift (kr/mån)', { ph: 't.ex. 39' })}
        <div class="field"><label>Årsavgift
          <div class="inline">
            <input type="text" inputmode="decimal" data-field="arsavgift" value="${esc(o.arsavgift)}" placeholder="t.ex. 662">
            <select data-field="arsavgiftEnhet" aria-label="Enhet för årsavgift">
              <option value="kr" ${o.arsavgiftEnhet === 'ore' ? '' : 'selected'}>kr/år</option>
              <option value="ore" ${o.arsavgiftEnhet === 'ore' ? 'selected' : ''}>öre/kWh</option>
            </select>
          </div></label></div>
        ${field(o, 'rabattOre', 'Rabatt (öre/kWh)')}
        ${field(o, 'rabattKr', 'Rabatt (kr/mån)')}
        ${field(o, 'kwhBasis', 'Sajtens kWh/år (kontrollpris)', { ph: '20000' })}
        <div class="field"><label>Spotmånad (kontrollpris) ${spotMonthSelect(o)}</label></div>
        ${field(o, 'anteckning', 'Anteckning', { span: true, text: true })}
      </div>
      <p class="check muted small">${checkHtml(o)}</p>
    </article>`;
  }

  function renderOffers() {
    $('#offers').innerHTML = state.offers.length
      ? state.offers.map(offerCard).join('')
      : '<div class="empty">Inga erbjudanden än. Klicka på "Lägg till erbjudande" och fyll i villkoren.</div>';
  }

  function saveOffers() { persist(); }

  /* ---------- Resultat ---------- */
  function tipHtml(t) { return `<li class="tip ${t.level}">${esc(t.text)}</li>`; }

  /** Rubrik med förklaring. Visas som egen tooltip (hovring, tangentbordsfokus eller tryck), se setupTooltips. */
  function tipLabel(text, tip) {
    return `<span class="tip-label" tabindex="0" data-tip="${esc(tip)}">${esc(text)}</span>`;
  }

  /** En tooltip för alla element med data-tip. Egen i stället för title-attribut, som visas sent och inte fungerar på pekskärm. */
  function setupTooltips() {
    const tip = document.createElement('div');
    tip.id = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    let current = null;
    const hide = () => {
      tip.hidden = true;
      if (current) current.removeAttribute('aria-describedby');
      current = null;
    };
    const show = (el) => {
      if (current && current !== el) current.removeAttribute('aria-describedby');
      current = el;
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), window.innerWidth - tip.offsetWidth - 8);
      let top = r.bottom + 8;
      if (top + tip.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - tip.offsetHeight - 8);
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      el.setAttribute('aria-describedby', 'tooltip');
    };
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (el && el !== current) show(el);
      else if (!el && current) hide();
    });
    document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
    document.addEventListener('focusout', hide);
    document.addEventListener('click', (e) => {           // pekskärm: tryck på en rubrik visar den, tryck någon annanstans döljer
      const el = e.target.closest('[data-tip]');
      if (el) show(el); else hide();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', hide, true);
  }

  /** Överblick: nuvarande avtal, sparade erbjudanden och eventuellt en säljares pris, bredvid varandra. */
  function renderOverview() {
    const card = $('#overview-card');
    const data = scoped();
    const s = state.settings;
    const opts = { months: COMPARE_MONTHS, baselineMode: s.baseline, offerMode: s.offerRabatt };
    const probe = data && data.manader.length ? C.overview(data, [], opts) : null;
    if (!probe || !probe.rows.length) { card.hidden = true; return; }
    card.hidden = false;

    // Säljarens pris görs om till ett erbjudande och räknas med som en rad i överblicken
    const q = s.quote;
    const hasQuote = C.num(q.ore) > 0;
    const quote = hasQuote ? C.quoteOffer({ ore: q.ore, inklMoms: q.inklMoms, typ: q.typ, avgiftKrAr: 0, kwhBasis: q.kwhBasis }, probe.spot, probe.res.vat) : null;
    const ov = C.overview(data, quote ? state.offers.concat([quote]) : state.offers, opts);
    // Det säljaren berättat om vad som ingår visas i raden (avgifter, rabatt), men ändrar inte priset
    const det = C.quoteDetails(q, ov.res.vat);
    const qRow = ov.rows.find((r) => r.id === 'quote');
    if (qRow) {
      qRow.namn = `Säljarens erbjudande${q.detail.namn ? ` (${q.detail.namn})` : ''}`;
      qRow.feeYear = det.has ? det.feeYear : null;
      qRow.rabatt = det.has && det.rabatt ? Object.assign({ active: true }, det.rabatt) : null;
    }
    const k = s.inkl ? 1 + ov.res.vat : 1;
    const o1 = (v) => (v === null || v === undefined ? '–' : nf(1).format(v * k));
    const kr0 = (v) => (v === null || v === undefined ? '–' : nf(0).format(v * k));
    const signed = (v) => `${v < 0 ? '−' : '+'}${nf(0).format(Math.abs(v) * k)}`;

    const typText = (r) => {
      if (r.isCurrent) return `Nuvarande${r.bolag ? ` (${r.bolag})` : ''}`;
      return { rorligt: 'Rörligt', timpris: 'Timpris', fast: 'Fast' }[r.typ] || r.typ;
    };
    const rabattText = (r) => {
      if (!r.rabatt) return '–';
      const parts = [];
      if (r.rabatt.kr) parts.push(`${nf(0).format(r.rabatt.kr * k)} kr/mån`);
      if (r.rabatt.ore) parts.push(`${nf(1).format(r.rabatt.ore * k)} öre/kWh`);
      return `${parts.join(' + ')}${r.rabatt.active ? '' : ' (avslagen)'}`;
    };
    // Jämförpriset gäller erbjudandets egen förbrukning och spotmånad, så det visas med det underlaget under siffran
    const refCell = (r) => (r.refOre === null || r.refOre === undefined ? '–'
      : `${o1(r.refOre)}<span class="sub">${r.isQuote ? 'totalpris, ' : (r.isCurrent ? 'från dina fakturor, ' : '')}${nf(0).format(r.refKwh)} kWh/år, spot ${esc(r.refMonth)}</span>`);
    const rows = ov.rows.slice().sort((a, b) => a.yearCost - b.yearCost);
    const cheapest = rows[0];
    const first = ov.res.months[0], last = ov.res.months[ov.res.months.length - 1];
    const details = !!s.showDetails;
    const kwhPeriod = ov.res.total.kwh;
    // Pris per kWh på din förbrukning över hela perioden: samma kostnad som i kostnadskolumnen delat på förbrukningen,
    // så det går att jämföra rakt av mellan alla rader (även dina nuvarande avtal och säljarens pris)
    const perKwh = (r) => (kwhPeriod ? r.yearCost / kwhPeriod * 100 : null);
    const body = rows.map((r) => {
      const cls = [r.isCurrent ? 'current' : '', r.id === 'quote' ? 'quote-row' : ''].join(' ');
      const badge = r === cheapest ? '<span class="badge">Billigast</span>' : '';
      const diff = r.isCurrent ? '–' : `<span class="${r.saving > 0 ? 'save' : 'more'}">${r.saving > 0 ? '−' : '+'}${nf(0).format(Math.abs(r.saving) * k)}</span>`;
      return `<tr class="${cls}"><td>${esc(r.namn)}${badge}</td><td>${esc(typText(r))}</td>
        <td><strong>${kr0(r.yearCost)}</strong></td><td>${diff}</td>
        <td><strong>${o1(perKwh(r))}</strong></td><td>${refCell(r)}</td>
        ${details ? `<td>${o1(r.energyOre)}</td><td>${kr0(r.feeYear)}</td><td class="left">${esc(rabattText(r))}</td>` : ''}</tr>`;
    }).join('');

    // Varning när fönstret blandar avtal: erbjudandena jämförs då också mot månader med ett avtal du inte längre har
    const mix = C.windowMix(data, ov.res.months);
    const mixWarn = mix.mixed ? `<p class="warn-box" role="note"><strong>Perioden blandar avtal.</strong>
      ${mix.periods.map((p) => `${esc(p.first)}${p.first === p.last ? '' : ` – ${esc(p.last)}`} ${esc(p.bolag)} (${esc(p.typLabel)})`).join(', ')}.
      ${mix.olika} av ${ov.res.months.length} månader hör inte till ditt nuvarande avtal, så kostnadskolumnerna jämför erbjudandena
      även mot ett avtal du lämnat. Jämförpriset påverkas inte. Välj <em>Elhandelsbolag</em> ${esc(mix.current.bolag)} i filtret för att bara räkna på nuvarande avtal.</p>` : '';

    $('#overview').innerHTML = `
      <div class="ov-head">
        <h3>Alla alternativ bredvid varandra</h3>
        <button class="btn small" id="btn-ov-details" type="button" aria-pressed="${details}">${details ? 'Dölj detaljer' : 'Visa detaljer'}</button>
      </div>
      <p class="muted small">Kostnaden gäller ${esc(first)} till ${esc(last)} på din förbrukning${scopeText() ? ` (${esc(scopeText())})` : ''}, ${s.inkl ? 'inkl.' : 'exkl.'} moms.
        Dina fakturor: ${ov.res.baselineMode === 'ordinarie' ? 'utan rabatt' : 'som du betalat'}. Erbjudanden: ${ov.res.offerMode === 'ordinarie' ? 'utan sina rabatter' : 'med sina rabatter'}. Ändra under fliken Jämförelse.</p>
      ${mixWarn}
      <div class="table-wrap"><table>
        <thead><tr><th>Alternativ</th>
          <th>${tipLabel('Typ', 'Rörligt (spotpris + påslag), timpris eller fast pris. För dina nuvarande avtal visas bolaget.')}</th>
          <th>${tipLabel('Kostnad perioden (kr)', `Total kostnad på din förbrukning ${first} till ${last}, med de rabattval som gäller (se texten ovanför tabellen).`)}</th>
          <th>${tipLabel('Mot nuvarande (kr)', 'Skillnad mot dina nuvarande avtal över perioden. Minus (grönt) = billigare än idag, plus (rött) = dyrare.')}</th>
          <th>${tipLabel('Pris på din förbrukning (öre/kWh)', 'Kostnaden över perioden delat på din förbrukning de månaderna: det du faktiskt skulle betalat per kWh, med avgifter och rabatter. Direkt jämförbart mellan raderna, även med dina nuvarande avtal.')}</th>
          <th>${tipLabel('Jämförpris (öre/kWh)', 'Så som en jämförelsesajt räknar: en jämn standardförbrukning per år (anges per erbjudande, standard 20 000 kWh) och vald spotmånad. Ska stämma med kontrollpriset under fliken Erbjudanden. Säljarens totalpris visas här. För dina nuvarande avtal räknas det på samma sätt från din senaste faktura (påslag, avgifter och rabatter), med eller utan rabatt efter ditt val.')}</th>
          ${details ? `<th>${tipLabel('Energipris (öre/kWh)', `Spotpris + påslag + rörliga kostnader + elcertifikat, minus rabatt per kWh, för ${ov.month} (spotpris ${nf(1).format(ov.spot * k)} öre/kWh). Utan fasta avgifter och rabatt i kr/mån.`)}</th>
          <th>${tipLabel('Avgifter (kr/år)', 'Månadsavgift × 12 plus årsavgift, före rabatt. För dina nuvarande avtal: avgifter och rabatt på avgifter sammanräknade (kan bli negativt).')}</th>
          <th>${tipLabel('Rabatt', 'Rabatten i erbjudandet. Den antas gälla hela perioden (12 månader). Visas som "avslagen" när erbjudanden räknas utan rabatt.')}</th>` : ''}</tr></thead>
        <tbody>${body}</tbody></table></div>
      ${state.offers.length ? '' : '<p class="muted small">Du har inga sparade erbjudanden än. Lägg till dem under fliken Erbjudanden så visas de här.</p>'}
      <div class="muted small explain">
        <p><strong>Så läser du tabellen:</strong> <em>Kostnad perioden</em> och <em>Mot nuvarande</em> svarar på om ett erbjudande är billigare än vad du betalar idag, på din egen förbrukning. <em>Pris på din förbrukning</em> är samma sak per kWh. <em>Jämförpris</em> är det en jämförelsesajt eller säljare anger, på en standardförbrukning (se kWh/år under siffran). Det används för att stämma av mot siffran på sajten eller i samtalet. För dina nuvarande avtal räknas det på samma sätt från din senaste faktura (påslag, avgifter och rabatter), så du kan jämföra det rakt av mot erbjudandenas jämförpris.</p>
        ${details ? `<p><strong>Energipris</strong> (${esc(ov.month)}) är spotpris + påslag, rörliga kostnader och elcertifikat, utan fasta avgifter. <strong>Avgifter</strong> är månads- och årsavgift per år och <strong>Rabatt</strong> är erbjudandets rabatt. För dina nuvarande avtal är avgifter och rabatt på avgifter sammanräknade, så avgifterna kan bli negativa. Pris på din förbrukning kan bli lägre än energipriset när en rabatt i kr/mån är större än avgifterna, särskilt för en liten förbrukning: 240 kr/mån på 735 kWh motsvarar 33 öre/kWh, men på 1 667 kWh bara 14 öre/kWh.</p>` : ''}
      </div>`;

    $('#quote-result').innerHTML = hasQuote
      ? `<ul class="tips">${C.quoteTips(ov, { inkl: s.inkl }, qRow ? C.detailsCheck(data, q, qRow.refOre, ov.res.vat, opts) : null).map(tipHtml).join('')}</ul>`
      : '<p class="muted small">Skriv in priset så visas direkt hur det står sig mot dina nuvarande avtal och sparade erbjudanden.</p>';
  }

  /** Aktiva filter som text, t.ex. "Hus B · 2025 · Skekraft". Tom när inget är valt. */
  function scopeText() {
    const s = state.settings;
    return [s.anl, s.year, s.bolag, TYP_VALJ[s.typ]].filter(Boolean).join(' · ');
  }

  function renderResultsCore() {
    renderOverview();
    const el = $('#results');
    if (!state.data) {
      el.innerHTML = '<p class="muted">Ladda in din förbrukning under fliken Data för att få en jämförelse.</p>';
      $('#history-card').hidden = true;
      return;
    }
    // Är ett år eller bolag valt räknas alla månader i urvalet, annars skulle ett glidande 12-månadersfönster
    // sticka utanför urvalet och ge luckor
    const s = state.settings;
    const opts = { months: COMPARE_MONTHS, baselineMode: s.baseline, offerMode: s.offerRabatt };
    const view = { inkl: state.settings.inkl };
    const data = scoped();
    const res = C.compare(data, state.offers, opts);
    if (!res.months.length || !res.total.kwh) {
      el.innerHTML = '<p class="muted">Inga månader matchar de valda filtren. Välj andra filter ovan.</p>';
      $('#history-card').hidden = true;
      return;
    }
    const tips = C.advice(data, state.offers, opts, view);
    const k = state.settings.inkl ? 1 + res.vat : 1;
    const anls = data.anlaggningar;

    const rows = [{ id: null, label: res.baselineMode === 'ordinarie' ? 'Dina fakturor (utan rabatt)' : 'Dina fakturor', base: true, per: anls.map((a) => res.perAnl[a].baseline), total: res.total.baseline }]
      .concat(res.offers.map((n) => {
        const offer = state.offers.find((o) => o.id === n.id);
        return { id: n.id, label: offer.namn || 'Erbjudande', per: anls.map((a) => res.perAnl[a].costs[n.id]), total: res.total.costs[n.id] };
      }).sort((a, b) => a.total - b.total));

    const minPer = anls.map((_, i) => Math.min(...rows.map((r) => r.per[i])));
    const minTotal = Math.min(...rows.map((r) => r.total));
    const kwh = res.total.kwh;

    const head = `<tr><th>Alternativ</th>${anls.map((a) => `<th>${esc(a)}</th>`).join('')}<th>Totalt (kr)</th><th>Pris (öre/kWh)</th><th>Mot dina fakturor (kr, %)</th></tr>`;
    const body = rows.map((r) => {
      const diff = r.total - res.total.baseline;
      const cells = r.per.map((v, i) => `<td class="${v === minPer[i] ? 'best' : ''}">${fmtKr(v * k)}</td>`).join('');
      const diffCell = r.base ? '<td>–</td>'
        : `<td class="${diff < 0 ? 'save' : 'more'}">${diff < 0 ? '−' : '+'}${fmtKr(Math.abs(diff) * k)} (${nf(0).format(Math.abs(diff) / res.total.baseline * 100)} %)</td>`;
      const badge = r.total === minTotal ? `<span class="badge">${r.base ? 'Billigast hittills' : 'Billigast'}</span>` : '';
      return `<tr class="${r.base ? 'base' : ''}"><td>${esc(r.label)}${badge}</td>${cells}<td><strong>${fmtKr(r.total * k)}</strong></td><td>${fmtOre(kwh ? r.total / kwh * 100 * k : 0)}</td>${diffCell}</tr>`;
    }).join('');

    const first = res.months[0], last = res.months[res.months.length - 1];
    el.innerHTML = `
      <ul class="tips">${tips.map(tipHtml).join('')}</ul>
      ${state.offers.length ? `
        <h3>Kostnad ${esc(first)} till ${esc(last)}, ${state.settings.inkl ? 'inkl.' : 'exkl.'} moms${scopeText() ? `, ${esc(scopeText())}` : ''}</h3>
        <p class="muted small">Dina fakturor: ${res.baselineMode === 'ordinarie' ? 'utan rabatt (ordinarie pris)' : 'som du betalat (med rabatt)'}. Erbjudanden: ${res.offerMode === 'ordinarie' ? 'utan sina rabatter' : 'med sina rabatter'}.</p>
        <div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>
        <h3>Total kostnad per alternativ</h3>
        ${barChart(rows.map((r) => ({ label: r.label, value: r.total * k, kind: r.base ? 'base' : (r.total === minTotal ? 'best' : '') })))}
      ` : ''}`;

    renderHistory(k);
  }

  function renderResults() {
    renderResultsCore();
    renderEmptyStates();
    updateOfferCount();
  }

  /** Meddelande i en flik vars innehåll är dolt: ingen data inläst, eller inga månader som matchar filtren. */
  function renderEmptyStates() {
    const noData = !state.data;
    $('#compare-card').hidden = noData;
    [['oversikt', '#overview-card'], ['jamforelse', '#compare-card'], ['historik', '#history-card']].forEach(([panel, card]) => {
      const note = $(`#empty-${panel}`);
      const cardHidden = $(card).hidden;
      note.hidden = !cardHidden;
      if (cardHidden) {
        note.innerHTML = noData
          ? '<p><strong>Ingen förbrukningsdata är inläst än.</strong></p><p class="muted">Ladda in <code>data.json</code> (eller prova demodata) under fliken Data.</p><button class="btn primary" type="button" data-goto="data">Gå till Data</button>'
          : '<p><strong>Inga månader matchar de valda filtren.</strong></p><p class="muted">Välj andra värden för anläggning, år eller bolag i filtret ovan.</p>';
      }
    });
    $('#filterbar').classList.toggle('disabled', noData);
  }

  /** Antal sparade erbjudanden som en liten markering på fliken. */
  function updateOfferCount() {
    const el = $('#count-offers');
    el.hidden = !state.offers.length;
    el.textContent = state.offers.length;
  }

  /* ---------- Flikar ---------- */
  const TABS = ['oversikt', 'erbjudanden', 'jamforelse', 'historik', 'data'];
  const FILTER_TABS = ['oversikt', 'jamforelse', 'historik'];   // flikar som påverkas av filtren

  function showTab(name, opts) {
    if (!TABS.includes(name)) name = 'oversikt';
    TABS.forEach((t) => {
      const selected = t === name;
      const tab = $(`#tab-${t}`);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`#panel-${t}`).hidden = !selected;
    });
    $('#filterbar').hidden = !FILTER_TABS.includes(name);
    if (opts && opts.focus) $(`#tab-${name}`).focus();
    if (!opts || opts.updateHash !== false) {
      if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    }
    window.scrollTo(0, 0);
  }

  function currentTab() {
    const fromHash = location.hash.slice(1);
    return TABS.includes(fromHash) ? fromHash : null;
  }

  function wireTabs() {
    $('.tablist').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) showTab(b.dataset.tab);
    });
    // Pil vänster/höger flyttar mellan flikarna, som i vanliga flikgränssnitt
    $('.tablist').addEventListener('keydown', (e) => {
      const i = TABS.indexOf(document.activeElement && document.activeElement.dataset.tab);
      if (i < 0) return;
      const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
      if (next !== undefined) { e.preventDefault(); showTab(TABS[next], { focus: true }); }
    });
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) showTab(g.dataset.goto);
    });
    window.addEventListener('hashchange', () => { const t = currentTab(); if (t) showTab(t, { updateHash: false }); });
  }

  function barChart(items) {
    const W = 760, rowH = 34, left = 190, right = 110, top = 8;
    const H = top + items.length * rowH + 8;
    const max = Math.max(...items.map((i) => i.value), 1);
    const inner = W - left - right;
    const bars = items.map((it, i) => {
      const y = top + i * rowH;
      const w = Math.max(2, it.value / max * inner);
      return `<text x="${left - 10}" y="${y + 20}" text-anchor="end">${esc(it.label.length > 26 ? `${it.label.slice(0, 25)}…` : it.label)}</text>
        <rect class="bar ${it.kind}" x="${left}" y="${y + 6}" width="${w}" height="20" rx="3"></rect>
        <text class="val" x="${left + w + 8}" y="${y + 21}">${fmtKr(it.value)}</text>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Stapeldiagram över total kostnad per alternativ">${bars}</svg>`;
  }

  /* ---------- Historik ---------- */
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    return ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= v)) || 10 * mag;
  }

  function chartFrame(W, H, L, R, T, B, max) {
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const v = max * f;
      return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"></line><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${nf(0).format(v)}</text>`;
    }).join('');
    return { y, grid };
  }

  /** Linjediagram. series: [{cls, values}] där null ger ett avbrott i linjen. */
  function lineChart(o) {
    const W = 760, H = 260, L = 52, R = 12, T = 12, B = 30;
    const vals = o.series.flatMap((s) => s.values).filter((v) => v !== null);
    const max = niceMax(Math.max(...vals, 1));
    const n = o.labels.length;
    const x = (i) => (n > 1 ? L + i / (n - 1) * (W - L - R) : L);
    const { y, grid } = chartFrame(W, H, L, R, T, B, max);
    const path = (vs) => {
      let d = '', pen = false;
      vs.forEach((v, i) => {
        if (v === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
        pen = true;
      });
      return d;
    };
    const ticks = o.labels.map((l, i) => (o.tick(l, i) ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>` : '')).join('');
    // Skuggade fält för avtalsperioder (bolag + rörligt/fast), med en streckad linje där bolaget byts
    const half = n > 1 ? (W - L - R) / (n - 1) / 2 : 0;
    const bands = (o.bands || []).map((b) => {
      const x0 = Math.max(L, x(b.from) - half), x1 = Math.min(W - R, x(b.to) + half);
      const label = x1 - x0 > 95 ? `<text class="band-label" x="${(x0 + 6).toFixed(1)}" y="${T + 13}">${esc(b.label)}</text>` : '';
      const edge = b.from > 0 ? `<line class="switch" x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${T}" y2="${H - B}"></line>` : '';
      return `<rect class="band ${b.cls}" x="${x0.toFixed(1)}" y="${T}" width="${(x1 - x0).toFixed(1)}" height="${H - T - B}"><title>${esc(b.label)}: ${esc(b.first)} till ${esc(b.last)}</title></rect>${edge}${label}`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria)}">${bands}${grid}${ticks}${o.series.map((s) => `<path class="${s.cls}" d="${path(s.values)}"></path>`).join('')}</svg>`;
  }

  /** Stapeldiagram, en stapel per etikett. */
  function columnChart(o) {
    const W = 760, H = 240, L = 52, R = 12, T = 12, B = 30;
    const max = niceMax(Math.max(...o.values, 1));
    const { y, grid } = chartFrame(W, H, L, R, T, B, max);
    const slot = (W - L - R) / o.values.length, bw = Math.max(2, slot * 0.7);
    const bars = o.values.map((v, i) => `<rect class="col" x="${(L + i * slot + (slot - bw) / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(v)).toFixed(1)}"><title>${esc(o.labels[i])}: ${nf(0).format(v)}</title></rect>`).join('');
    const ticks = o.labels.map((l, i) => (o.tick(l, i) ? `<text x="${(L + i * slot + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>` : '')).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria)}">${grid}${ticks}${bars}</svg>`;
  }

  function table(head, rows, cls) {
    // En rubrik är en text, eller [text, förklaring] för en tooltip
    const th = (h) => (Array.isArray(h) ? tipLabel(h[0], h[1]) : esc(h));
    return `<div class="table-wrap ${cls || ''}"><table><thead><tr>${head.map((h) => `<th>${th(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderHistory(k) {
    const card = $('#history-card');
    const anl = state.settings.anl;
    const h = C.history(scoped(), anl, { inkl: state.settings.inkl });
    if (!h.months.length) { card.hidden = true; return; }
    card.hidden = false;
    $('#hist-scope').textContent = scopeText() || 'alla anläggningar';

    const v1 = (v) => (v === null ? '–' : nf(1).format(v * k));
    const sg = (v) => (v === null ? '–' : `${v >= 0 ? '+' : '−'}${nf(1).format(Math.abs(v) * k)}`);
    const kr0 = (v) => nf(0).format(v * k);
    // Historiken visar vad du betalat (med rabatter) och vad samma fakturor hade kostat utan rabatt, så de går att stämma av
    // mot överblicken, som följer valet "Dina fakturor: Som du betalat / Utan rabatt" under fliken Jämförelse
    const BETALT = ['Betalt (kr)', 'Vad du faktiskt betalat för elhandeln, med dina rabatter. I överblicken är det raden "Dina nuvarande avtal" när Dina fakturor står på "Som du betalat".'];
    const UTAN_RABATT = ['Utan rabatt (kr)', 'Vad samma fakturor hade kostat utan rabatter (ordinarie pris). I överblicken är det raden "Dina nuvarande avtal (utan rabatt)" när Dina fakturor står på "Utan rabatt". Skillnaden mot Betalt är rabatterna.'];
    const yearHead = ['År', 'Månader', 'kWh', BETALT, UTAN_RABATT, 'Pris (öre/kWh)', 'Ordinarie (öre/kWh)', 'Spot (öre/kWh)', ['Skillnad mot spot (öre/kWh)', 'Pris minus spotpris, vägt med förbrukning över månaderna som har spotpris. Positivt = du betalat mer än spotpriset.'], ['Skillnad utan fasta avg. (öre/kWh)', 'Som skillnad mot spot, men exklusive fasta avgifter och rabatt på dem. Jämför bolag rättvist även för små anläggningar.'], ['Fasta avg. (% av kostnad)', 'Hur stor del av kostnaden som är fasta avgifter (månads- och årsavgift) netto efter rabatt på dem.']];
    const yearRows = h.years.map((y) => [
      esc(y.year), y.months < 12 ? `${y.months} (ofullständigt)` : y.months, nf(0).format(y.kwh), kr0(y.betalt), kr0(y.ordinarie),
      v1(y.paidOre), v1(y.ordinarieOre), v1(y.spotW), sg(y.diff), sg(y.rorligDiff), y.fastShare === null ? '–' : nf(0).format(y.fastShare * 100),
    ]);
    const bolagRows = h.bolag.map((b) => [
      esc(b.namn), esc(C.typLabel(b.typ || 'okänt')), `${esc(b.first)} – ${esc(b.last)}`, b.months, nf(0).format(b.kwh), kr0(b.betalt), kr0(b.ordinarie), v1(b.paidOre), v1(b.spotW), sg(b.diff), sg(b.rorligDiff),
    ]);
    const anlRows = h.perAnl.map((a) => [
      esc(a.namn), nf(0).format(a.kwh), `${nf(0).format(a.kwh / h.total.kwh * 100)}`, kr0(a.betalt), kr0(a.ordinarie), v1(a.paidOre), v1(a.spotW), sg(a.diff),
    ]);

    const labels = h.months.map((m) => m.manad);
    const tick = (l) => l.endsWith('-01') || l.endsWith('-07');
    const bands = h.periods.map((p) => ({
      from: p.from, to: p.to, first: p.first, last: p.last, label: `${p.bolag} · ${p.typLabel}`,
      cls: p.typ === 'fast' ? 'fast' : (p.typ === 'rorligt' ? 'var' : 'unknown'),
    }));
    const price = lineChart({
      labels, tick, bands, aria: 'Linjediagram över betalt pris och spotpris per månad, med avtalsperioder markerade',
      series: [
        { cls: 'l-spot', values: h.months.map((m) => (m.spot === null ? null : m.spot * k)) },
        { cls: 'l-paid', values: h.months.map((m) => (m.paidOre === null ? null : m.paidOre * k)) },
      ],
    });
    const kwhChart = columnChart({ labels, tick, values: h.months.map((m) => m.kwh), aria: 'Stapeldiagram över förbrukning per månad (kWh)' });

    const recent = h.years.slice(-4);
    const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'];
    const yoy = lineChart({
      labels: MN, tick: () => true, aria: 'Linjediagram över förbrukning per månad, år mot år',
      series: recent.map((y, i) => ({
        cls: `l-y${4 - recent.length + i}`,
        values: MN.map((_, mi) => {
          const m = h.months.find((r) => r.manad === `${y.year}-${String(mi + 1).padStart(2, '0')}`);
          return m ? m.kwh : null;
        }),
      })),
    });
    const yoyLegend = recent.map((y, i) => `<span><i class="y${4 - recent.length + i}"></i>${esc(y.year)}</span>`).join('');

    const monthRows = h.months.slice().reverse().map((m) => [
      esc(m.manad), esc(m.bolag), nf(0).format(m.kwh), kr0(m.betalt), kr0(m.ordinarie), v1(m.paidOre), v1(m.spot), sg(m.diff),
    ]);

    // Kontrollrad: månaderna med fast pris mot ett rörligt avtal (spot + påslag), med samma fasta avgifter
    const fv = C.fastVsRorligt(h.months, state.settings.paslag);
    const fastBox = fv.months ? `<h3>Fast pris mot rörligt (spot + påslag)</h3>
      <div class="fastcheck"><label>Påslag och rörliga kostnader för rörligt avtal (öre/kWh, exkl. moms)
        <input type="text" inputmode="decimal" data-paslag value="${esc(state.settings.paslag)}" aria-label="Påslag i öre per kWh"></label>
      ${table(['Månader med fast pris', 'kWh', 'Betalt fast (kr)', ['Rörligt (kr)', 'Spotpris + påslag för varje månads förbrukning, plus samma fasta avgifter som du betalade.'], ['Fast billigare med (kr)', 'Positivt: det fasta priset var billigare än rörligt. Negativt: rörligt hade varit billigare.'], 'Spot (öre/kWh)', ['Jämnt vid påslag (öre/kWh)', 'Påslaget där rörligt och fast hade kostat lika mycket. Är ditt påslag högre än det här var fast billigare.']],
        [[`${fv.months} (${esc(fv.first)} – ${esc(fv.last)})`, nf(0).format(fv.kwh), kr0(fv.betalt), kr0(fv.rorligt), `${fv.diff >= 0 ? '+' : '−'}${kr0(Math.abs(fv.diff))}`, v1(fv.spotOre), v1(fv.breakEvenOre)]])}
      <p class="muted small">Spotpriset är månadsmedelpris, inte vägt efter när på dygnet du förbrukar. Ett tidsvägt pris kan avvika något.</p></div>` : '';

    $('#history').innerHTML = `
      <ul class="tips">${h.tips.map(tipHtml).join('')}</ul>
      ${fastBox}
      ${anlRows.length ? `<h3>Per anläggning, hela perioden</h3>${table(['Anläggning', 'kWh', 'Andel (%)', BETALT, UTAN_RABATT, 'Pris (öre/kWh)', 'Spot (öre/kWh)', ['Skillnad mot spot (öre/kWh)', 'Pris minus spotpris, vägt med förbrukning över månaderna som har spotpris. Positivt = du betalat mer än spotpriset.']], anlRows)}` : ''}
      <h3>Per år</h3>${table(yearHead, yearRows)}
      <h3>Per elhandelsbolag</h3>${table(['Bolag', 'Avtal', 'Period', 'Månader', 'kWh', BETALT, UTAN_RABATT, 'Pris (öre/kWh)', 'Spot (öre/kWh)', ['Skillnad mot spot (öre/kWh)', 'Pris minus spotpris, vägt med förbrukning över månaderna som har spotpris. Positivt = du betalat mer än spotpriset.'], ['Skillnad utan fasta avg. (öre/kWh)', 'Som skillnad mot spot, men exklusive fasta avgifter och rabatt på dem. Jämför bolag rättvist även för små anläggningar.']], bolagRows)}
      <h3>Pris per kWh mot spotpris (öre/kWh)</h3>${price}
      <div class="legend"><span><i></i>Du betalat</span><span><i class="spot"></i>Spotpris</span>
        <span><i class="sw var"></i>Rörligt avtal</span><span><i class="sw fast"></i>Fast pris</span>
        <span class="muted">Streckad linje = byte av elhandelsbolag</span></div>
      <h3>Förbrukning per månad (kWh)</h3>${kwhChart}
      <h3>Förbrukning år mot år (kWh)</h3>${yoy}
      <div class="legend">${yoyLegend}</div>
      <details><summary>Alla månader (${h.months.length})</summary>
        ${table(['Månad', 'Bolag', 'kWh', BETALT, UTAN_RABATT, 'Pris (öre/kWh)', 'Spot (öre/kWh)', ['Skillnad mot spot (öre/kWh)', 'Pris minus spotpris, vägt med förbrukning över månaderna som har spotpris. Positivt = du betalat mer än spotpriset.']], monthRows, 'scroll-y')}
      </details>
      <p class="muted small">Belopp ${state.settings.inkl ? 'inkl.' : 'exkl.'} moms. Spot och skillnad vägs med förbrukning över de månader som har spotpris. "Skillnad utan fasta avg." är skillnaden mot spot exklusive månads-/årsavgifter och deras rabatter, vilket jämför bolagen rättvist även för anläggningar med låg förbrukning.</p>`;
  }

  /** Visar sparade värden i säljarfälten (utan att störa en pågående inmatning). */
  function syncQuoteInputs() {
    const q = state.settings.quote;
    const set = (el, v) => { if (document.activeElement !== el) el.value = v; };
    set($('#q-ore'), q.ore);
    set($('#q-moms'), q.inklMoms ? '1' : '0');
    set($('#q-typ'), q.typ);
    set($('#q-kwh'), q.kwhBasis);
    document.querySelectorAll('#q-details [data-q]').forEach((el) => {
      const v = q.detail[el.dataset.q];
      set(el, el.dataset.q === 'inklMoms' ? (v ? '1' : '0') : v);
    });
    $('#q-details').open = !!q.open;
  }

  /** Sparar säljarens erbjudande som ett vanligt erbjudande under fliken Erbjudanden (detaljerna om de finns, annars totalpriset). */
  function saveQuoteAsOffer() {
    const q = state.settings.quote;
    const data = scoped();
    if (!data || !(C.num(q.ore) > 0)) { $('#q-saved').textContent = 'Skriv in säljarens pris först.'; return; }
    const month = C.latestMonth(data);
    const d = q.detail;
    const det = C.quoteDetails(q, C.DEFAULT_VAT);
    // Detaljerna används som erbjudande bara om de beskriver energipriset (påslag/rörliga kostnader, eller fastpris).
    // Annars skulle t.ex. bara en månadsavgift ge ett erbjudande utan energikostnad, så då sparas totalpriset.
    const definesEnergy = q.typ === 'fast' ? d.fastpris !== '' : (d.paslag !== '' || d.rorliga !== '');
    const labels = { fastpris: 'fastpris', paslag: 'fast påslag', rorliga: 'rörliga kostnader', elcert: 'elcertifikat', manadsavgift: 'månadsavgift',
      arsavgift: 'årsavgift', rabattOre: 'rabatt öre/kWh', rabattKr: 'rabatt kr/mån' };
    const detailText = Object.keys(labels).filter((k) => d[k] !== '').map((k) => `${labels[k]} ${d[k]}`).join(', ');
    const note = `Säljarens totalpris ${q.ore} öre/kWh ${q.inklMoms ? 'inkl.' : 'exkl.'} moms (${q.typ === 'fast' ? 'fast' : 'rörligt'}), ${new Date().toISOString().slice(0, 10)}.`
      + `${!definesEnergy && detailText ? ` Antecknat (${d.inklMoms ? 'inkl.' : 'exkl.'} moms): ${detailText}.` : ''}${d.anteckning ? ` ${d.anteckning}` : ''}`;
    let fields;
    if (det.has && definesEnergy) {
      fields = { typ: q.typ, inklMoms: !!d.inklMoms, fastpris: d.fastpris, paslag: d.paslag, rorliga: d.rorliga, elcert: d.elcert,
        manadsavgift: d.manadsavgift, arsavgift: d.arsavgift, arsavgiftEnhet: 'kr', rabattOre: d.rabattOre, rabattKr: d.rabattKr,
        kwhBasis: q.kwhBasis || '20000' };
    } else {
      // Bara totalpriset: rörligt blir ett påslag på senaste månadens spotpris, fast blir ett fastpris (allt exkl. moms)
      const o = C.quoteOffer({ ore: q.ore, inklMoms: q.inklMoms, typ: q.typ, avgiftKrAr: 0 }, data.spot[month], data.momssats);
      const round2 = (v) => (v === undefined || v === '' ? '' : String(Math.round(Number(v) * 100) / 100));
      fields = { typ: o.typ, inklMoms: false, paslag: round2(o.paslag), fastpris: round2(o.fastpris), kwhBasis: q.kwhBasis || '20000' };
    }
    const offer = newOffer(Object.assign({ namn: d.namn || 'Säljarens erbjudande', anteckning: note }, fields));
    state.offers.push(offer);
    persist();
    renderOffers();
    renderResults();
    $('#q-saved').textContent = `Sparat som "${offer.namn}" under fliken Erbjudanden.`;
  }

  function render() {
    syncQuoteInputs();
    renderStatus();
    renderSettings();
    renderOffers();
    renderResults();
  }

  /* ---------- Händelser ---------- */
  function wire() {
    $('#file-data').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
    $('#btn-demo').addEventListener('click', () => {
      if (window.DEMO_DATA) setData(window.DEMO_DATA, { manual: true }); else alert('Demodata saknas (demo-data.js).');
    });
    $('#btn-server-data').addEventListener('click', async () => {
      const d = await fetchJson('data.json');
      if (!d) { alert('Hittade ingen data.json på servern. Kör python3 export_data.py först.'); return; }
      state.settings.dataSource = '';
      persist();
      setData(d);
    });
    $('#data-status').addEventListener('click', (e) => {
      if (e.target.id === 'btn-change') { state.data = null; render(); showTab('data'); }
    });
    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

    const onQuote = () => {
      Object.assign(state.settings.quote, { ore: $('#q-ore').value, inklMoms: $('#q-moms').value === '1', typ: $('#q-typ').value, kwhBasis: $('#q-kwh').value });
      persist();
      renderOverview();
    };
    ['#q-ore', '#q-kwh'].forEach((id) => $(id).addEventListener('input', onQuote));
    ['#q-moms', '#q-typ'].forEach((id) => $(id).addEventListener('change', onQuote));
    $('#q-details').addEventListener('input', (e) => {
      const key = e.target.dataset.q;
      if (!key) return;
      state.settings.quote.detail[key] = key === 'inklMoms' ? e.target.value === '1' : e.target.value;
      $('#q-saved').textContent = '';
      persist();
      renderOverview();
    });
    $('#q-details').addEventListener('toggle', () => {
      if (state.settings.quote.open !== $('#q-details').open) { state.settings.quote.open = $('#q-details').open; persist(); }
    });
    $('#q-save').addEventListener('click', saveQuoteAsOffer);
    $('#q-clear').addEventListener('click', () => {
      const open = state.settings.quote.open;
      state.settings.quote = Object.assign({}, DEFAULT_SETTINGS.quote, { open, detail: Object.assign({}, DEFAULT_SETTINGS.quote.detail) });
      $('#q-saved').textContent = '';
      persist();
      syncQuoteInputs();
      renderOverview();
    });
    $('#overview').addEventListener('click', (e) => {
      if (e.target.id !== 'btn-ov-details') return;
      state.settings.showDetails = !state.settings.showDetails;
      persist();
      renderOverview();
    });
    $('#sel-anl').addEventListener('change', (e) => update({ anl: e.target.value }));
    $('#sel-year').addEventListener('change', (e) => update({ year: e.target.value }));
    $('#sel-bolag').addEventListener('change', (e) => update({ bolag: e.target.value }));
    $('#sel-typ').addEventListener('change', (e) => update({ typ: e.target.value }));
    $('#history').addEventListener('change', (e) => { if (e.target.matches('[data-paslag]')) update({ paslag: e.target.value }); });

    $('#btn-add').addEventListener('click', () => {
      state.offers.push(newOffer());
      saveOffers(); renderOffers(); renderResults();
    });

    const offers = $('#offers');
    offers.addEventListener('input', (e) => {
      const f = e.target.dataset.field;
      const card = e.target.closest('.offer');
      if (!f || !card || e.target.tagName === 'SELECT') return;
      const offer = state.offers.find((o) => o.id === card.dataset.id);
      offer[f] = e.target.value;
      $('.check', card).innerHTML = checkHtml(offer);
      saveOffers(); renderResults();
    });
    offers.addEventListener('change', (e) => {
      const f = e.target.dataset.field;
      const card = e.target.closest('.offer');
      if (!f || !card || e.target.tagName !== 'SELECT') return;
      const o = state.offers.find((x) => x.id === card.dataset.id);
      o[f] = f === 'inklMoms' ? e.target.value === '1' : e.target.value;
      saveOffers(); renderOffers(); renderResults();
    });
    offers.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      const card = e.target.closest('.offer');
      if (!action || !card) return;
      const idx = state.offers.findIndex((o) => o.id === card.dataset.id);
      if (action === 'del') state.offers.splice(idx, 1);
      if (action === 'dup') state.offers.splice(idx + 1, 0, Object.assign({}, state.offers[idx], { id: uid(), namn: `${state.offers[idx].namn} (kopia)` }));
      saveOffers(); renderOffers(); renderResults();
    });

    $('#btn-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state.offers, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'erbjudanden.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $('#file-offers').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const list = JSON.parse(reader.result);
          if (!Array.isArray(list)) throw new Error('Förväntade en lista med erbjudanden.');
          state.offers = list.map((o) => newOffer(Object.assign({}, o, { id: o.id || uid() })));
          saveOffers(); renderOffers(); renderResults();
        } catch (err) { alert(`Kunde inte läsa erbjudandena: ${err.message}`); }
      };
      reader.readAsText(file);
    });
  }

  $('#filter-details').open = window.innerWidth > 760;   // hopfälld på telefon, så prisrutan hamnar högt upp
  setupTooltips();
  wireTabs();
  wire();
  showTab(currentTab() || 'oversikt', { updateHash: false });
  render();
  // När sidan serveras (t.ex. python3 -m http.server) läses data.json bredvid sidan in automatiskt
  // Utan inläst data finns inget att visa i de andra flikarna: gå till Data, om inte en flik valts via adressen
  loadServerState().then(loadInitialData).then(() => { if (!state.data && !currentTab()) showTab('data'); });
})();
