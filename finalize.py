import calendar
import csv
import json
import re
from collections import Counter, defaultdict
from datetime import date

from costs import parse_cost_lines
from common import (FAKTUROR_CSV, FAKTUROR_SV_CSV, MONTHS, ROWS_JSON, SPOT_AREA, load_id_name, load_spot, sw_date,
                    write_csv_sv)

# Kostnadsuppdelning för elhandel (belopp exkl. moms om inget annat anges)
COST_COLS = [
    'Energipris exkl. moms (öre/kWh)', 'Påslag och elcertifikat exkl. moms (öre/kWh)',
    'Rörliga kostnader exkl. moms (SEK)',
    'Rabatt rörligt exkl. moms (SEK)', 'Fast avgift exkl. moms (SEK)', 'Rabatt fast exkl. moms (SEK)',
    'Summa exkl. moms (SEK)', 'Moms (SEK)', 'Summa inkl. moms (SEK)',
    'Pris exkl. moms (öre/kWh)', 'Pris inkl. moms (öre/kWh)', 'Ordinarie pris exkl. moms (öre/kWh)',
]
SPOT_COLS = [f'Spotpris {SPOT_AREA} exkl. moms (öre/kWh)',
             'Skillnad mot spot exkl. moms (öre/kWh)', 'Ordinarie skillnad mot spot exkl. moms (öre/kWh)']
COST_COMPANIES = {'Fortum', 'Skekraft', 'Vattenfall'}

COLS = ['Bolag', 'Typ', 'Anläggning', 'Anläggnings-ID', 'Adress', 'Fakturanummer', 'Fakturadatum',
        'Period start', 'Period slut', 'Specifikation kostnader', 'Total förbrukning (kWh)',
        'Totalsumma (SEK)'] + COST_COLS + SPOT_COLS + ['Källfil', 'Granska']

# Luckor och överlapp kontrolleras bara från detta datum. Äldre fakturor (2020-2022) är ofullständiga och ingår inte i jämförelsen.
CONTINUITY_FROM = date(2023, 1, 1)

DUPLICATE_NOTE = 'Möjlig dubblettfaktura (samma fakturanummer finns i flera filer)'


def normalize_spec(spec, bolag):
    if not spec:
        return spec
    s = spec
    # dedupe identical repeated segments split by ' || '
    if ' || ' in s:
        parts = s.split(' || ')
        seen = []
        for p in parts:
            if p not in seen:
                seen.append(p)
        s = ' || '.join(seen)
    # unify currency label
    s = re.sub(r'\bSEK\b', 'kr', s)
    # ensure space between a number and a following unit word
    s = re.sub(r'(?<=[0-9])(kr|kWh|kWh\.|kr/kWh|kr/m[åa]n|kr/[åa]r|[öo]re/kWh|dygn|m[åa]n)\b', r' \1', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def strip_chart_junk(spec):
    if not spec:
        return spec
    # remove Ellevio's embedded usage-chart block, e.g.
    # "Elanvändning, månad för månad (kWh) 2023 2024 2025 | 4 000 | 3 000 | ... | Beräknad årsanvändning: ... | på din elanvändning på ellevio.se/minasidor."
    spec = re.sub(r'Elanv[äa]ndning, m[åa]nad f[öo]r m[åa]nad[^|]*(\|[^|]*)*?p[åa] din elanv[äa]ndning p[åa] ellevio\.se/minasidor\.\s*', '', spec)
    spec = re.sub(r'\s*\|\s*\|\s*', ' || ', spec)
    spec = re.sub(r'\s+', ' ', spec).strip()
    return spec


def clean_address(addr, bolag):
    if not addr:
        return addr
    a = addr
    if bolag == 'Skekraft':
        m = re.search(r'^(.*?;\s*SE)\b', a)
        if m:
            a = m.group(1)
    a = a.replace(';', ',')
    a = re.sub(r'\s+', ' ', a).strip()
    a = re.sub(r'\b([A-ZÅÄÖ]\w+) gård\b', r'\1 Gård', a)   # "Xxxxby gård" -> "Xxxxby Gård"
    a = re.sub(r'(\d{3})\s?(\d{2})\s+', r'\1 \2 ', a)
    a = a.strip(', ')
    return a


def parse_tibber_period(txt):
    if not txt:
        return None, None
    txt = txt.strip()
    m = re.match(r'^(\d{1,2}) (\w+) (\d{4}) - (\d{1,2}) (\w+) (\d{4})$', txt)
    if m:
        d1, mo1, y1, d2, mo2, y2 = m.groups()
        s = f"{y1}-{MONTHS.get(mo1.lower(), 0):02d}-{int(d1):02d}"
        e = f"{y2}-{MONTHS.get(mo2.lower(), 0):02d}-{int(d2):02d}"
        return s, e
    m = re.match(r'^(\w+) (\d{4})$', txt)
    if m:
        mo, y = m.groups()
        mon_n = MONTHS.get(mo.lower())
        if mon_n:
            last = calendar.monthrange(int(y), mon_n)[1]
            return f"{y}-{mon_n:02d}-01", f"{y}-{mon_n:02d}-{last:02d}"
    return None, None


def ore_per_kwh(sek, kwh):
    """SEK -> öre per kWh (100 öre = 1 SEK), eller '' om det inte går att räkna ut."""
    if sek is None or not kwh:
        return ''
    return round(sek / kwh * 100, 2)


def cost_columns(r):
    """Kostnadsuppdelning för en elhandelsrad: (kolumner, anmärkningar)."""
    empty = {c: '' for c in COST_COLS}
    spec = r.get('specifikation')
    if r['bolag'] not in COST_COMPANIES or not spec or spec.startswith('Kombinerad'):
        return empty, []
    a, notes = parse_cost_lines(spec)
    kwh = r.get('forbrukning_kwh')
    discounts = a['rabatt_rorlig'] + a['rabatt_fast']
    cols = {
        'Energipris exkl. moms (öre/kWh)': ore_per_kwh(a['energi'], kwh),
        'Påslag och elcertifikat exkl. moms (öre/kWh)': ore_per_kwh(a['paslag'] + a['rorliga'] + a['elcert'], kwh),
        'Rörliga kostnader exkl. moms (SEK)': round(a['rorliga'], 2),
        'Rabatt rörligt exkl. moms (SEK)': round(a['rabatt_rorlig'], 2),
        'Fast avgift exkl. moms (SEK)': round(a['fast'], 2),
        'Rabatt fast exkl. moms (SEK)': round(a['rabatt_fast'], 2),
        'Summa exkl. moms (SEK)': round(a['summa_exkl'], 2),
        'Moms (SEK)': '' if a['moms'] is None else round(a['moms'], 2),
        'Summa inkl. moms (SEK)': '' if a['summa_inkl'] is None else round(a['summa_inkl'], 2),
        'Pris exkl. moms (öre/kWh)': ore_per_kwh(a['summa_exkl'], kwh),
        'Pris inkl. moms (öre/kWh)': ore_per_kwh(a['summa_inkl'], kwh),
        'Ordinarie pris exkl. moms (öre/kWh)': ore_per_kwh(a['summa_exkl'] - discounts, kwh),
    }
    return cols, notes


def spot_for_period(start, end, spot):
    """Dagsviktat månadsmedelspris för en period, eller (None, saknade månader) om data saknas."""
    total, days, missing = 0.0, 0, []
    day = start
    while day <= end:
        month = f'{day.year}-{day.month:02d}'
        n = min(end, date(day.year, day.month, calendar.monthrange(day.year, day.month)[1])) - day
        n = n.days + 1
        if month in spot:
            total += spot[month] * n
            days += n
        elif month not in missing:
            missing.append(month)
        day = date(day.year + day.month // 12, day.month % 12 + 1, 1)
    return (round(total / days, 2) if days and not missing else None), missing


def spot_columns(costs, pstart, pslut, spot):
    """Spotpris för fakturaperioden och skillnaden mot fakturans pris: (kolumner, anmärkningar)."""
    cols = {c: '' for c in SPOT_COLS}
    start, end = _iso(pstart), _iso(pslut)
    pris, ordinarie = costs['Pris exkl. moms (öre/kWh)'], costs['Ordinarie pris exkl. moms (öre/kWh)']
    if not (start and end and pris != '') or not spot:
        return cols, []
    ref, missing = spot_for_period(start, end, spot)
    if ref is None:
        # Före spotdatats början är tomt väntat; saknade månader senare ska granskas
        first = min(spot)
        late = [m for m in missing if m >= first]
        return cols, [f'saknar spotpris för {", ".join(late)}'] if late else []
    cols[SPOT_COLS[0]] = ref
    cols[SPOT_COLS[1]] = round(pris - ref, 2)
    cols[SPOT_COLS[2]] = round(ordinarie - ref, 2)
    return cols, []


def build_row(r, id_name, spot):
    bolag = r['bolag']
    aid = r.get('anlaggningsid')
    if bolag == 'Tibber':
        pstart, pslut = parse_tibber_period(r.get('period_text'))
    else:
        pstart = sw_date(r.get('period_start'))
        pslut = sw_date(r.get('period_slut'))
    spec = strip_chart_junk(normalize_spec(r.get('specifikation'), bolag))
    costs, cost_notes = cost_columns(r)
    spot_cols, spot_notes = spot_columns(costs, pstart, pslut, spot)
    granska = '; '.join(n for n in [r.get('granska') or ''] + cost_notes + spot_notes if n)
    return {
        'Bolag': bolag,
        'Typ': 'Elnät' if bolag == 'Ellevio' else 'Elhandel',
        'Anläggning': id_name.get(aid, r.get('anlaggning_fil') or ''),
        'Anläggnings-ID': aid or '',
        'Adress': clean_address(r.get('adress'), bolag) or '',
        'Fakturanummer': r.get('fakturanummer') or '',
        'Fakturadatum': sw_date(r.get('fakturadatum')) or '',
        'Period start': pstart or '',
        'Period slut': pslut or '',
        'Specifikation kostnader': spec or '',
        'Total förbrukning (kWh)': r.get('forbrukning_kwh') if r.get('forbrukning_kwh') is not None else '',
        'Totalsumma (SEK)': r.get('totalsumma') if r.get('totalsumma') is not None else '',
        **costs,
        **spot_cols,
        'Källfil': r['fil'],
        'Granska': granska,
    }


def sortkey(row):
    return (row['Anläggning'], row['Bolag'], row['Period start'] or row['Fakturadatum'])


def find_duplicates(rows):
    counts = Counter((r['Bolag'], r['Fakturanummer']) for r in rows if r['Fakturanummer'])
    return [k for k, v in counts.items() if v > 1]


def add_note(row, note):
    row['Granska'] = f"{row['Granska']}; {note}" if row['Granska'] else note


def flag_duplicates(rows, dup_keys):
    dups = set(dup_keys)
    for r in rows:
        if (r['Bolag'], r['Fakturanummer']) in dups:
            add_note(r, DUPLICATE_NOTE)


def _iso(s):
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def check_period_continuity(rows):
    """Flaggar luckor och överlapp i fakturaperioderna per anläggning och typ (elnät/elhandel).

    Perioderna ska ansluta till varandra, även när leverantören byts. Bara perioder från CONTINUITY_FROM
    kontrolleras (äldre data är känt ofullständigt). Flaggan sätts på
    fakturan som kommer efter luckan/överlappet. Returnerar listan med anmärkningar.
    """
    groups = defaultdict(list)
    for r in rows:
        start, end = _iso(r['Period start']), _iso(r['Period slut'])
        if start and end:
            groups[(r['Anläggning'], r['Typ'])].append((start, end, r))

    found = []
    for (anl, typ), items in groups.items():
        items.sort(key=lambda i: (i[0], i[1]))
        prev_end, prev_row = None, None
        for start, end, r in items:
            if prev_end is not None and prev_end >= CONTINUITY_FROM:
                same_invoice = r['Fakturanummer'] and (r['Bolag'], r['Fakturanummer']) == (prev_row['Bolag'], prev_row['Fakturanummer'])
                if (start - prev_end).days > 1:
                    note = f'lucka: {(start - prev_end).days - 1} dagar utan faktura före perioden (föregående slutar {prev_end})'
                elif start <= prev_end and not same_invoice:
                    note = f'perioden överlappar föregående faktura (som slutar {prev_end})'
                else:
                    note = None
                if note:
                    add_note(r, note)
                    found.append((anl, typ, r['Period start'], note))
            if prev_end is None or end > prev_end:
                prev_end, prev_row = end, r
    return found


def write_csv(rows, path):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)


def print_sanity_checks(rows, dup_keys):
    print("rows written:", len(rows))
    print("Möjliga dubbletter (bolag, fakturanummer):", len(dup_keys))
    for k in dup_keys[:10]:
        print(" ", k)

    # Sorterade extremvärden: det effektivaste sättet att hitta regex-buggar.
    amounts = sorted((r['Totalsumma (SEK)'], r['Källfil']) for r in rows
                     if isinstance(r['Totalsumma (SEK)'], float))
    print("Lägsta belopp:", amounts[:5])
    print("Högsta belopp:", amounts[-5:])

    kwhs = sorted((r['Total förbrukning (kWh)'], r['Källfil']) for r in rows
                  if isinstance(r['Total förbrukning (kWh)'], float))
    print("Lägsta kWh:", kwhs[:5])
    print("Högsta kWh:", kwhs[-5:])


def print_period_issues(issues):
    gaps = sum(1 for i in issues if i[3].startswith('lucka'))
    print(f"Perioder: {gaps} luckor, {len(issues) - gaps} överlapp (flaggade i Granska)")
    for anl, typ, start, note in sorted(issues)[:10]:
        print(f"  {anl} ({typ}) {start}: {note}")


def main():
    with open(ROWS_JSON, encoding='utf-8') as f:
        rows = json.load(f)
    id_name = load_id_name()
    spot = load_spot()

    out_rows = sorted((build_row(r, id_name, spot) for r in rows), key=sortkey)
    dup_keys = find_duplicates(out_rows)
    flag_duplicates(out_rows, dup_keys)
    period_issues = check_period_continuity(out_rows)
    write_csv(out_rows, FAKTUROR_CSV)
    write_csv_sv(out_rows, COLS, FAKTUROR_SV_CSV)
    print_sanity_checks(out_rows, dup_keys)
    print_period_issues(period_issues)


if __name__ == '__main__':
    main()
