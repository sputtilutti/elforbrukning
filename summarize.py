"""Viktat snittpris för elhandel per anläggning och bolag: per kalenderår och för de senaste 12 månaderna.

Läser fakturor.csv (från finalize.py) och skriver sammanfattning.csv i WORKDIR.
Priset är summa kronor / summa kWh, alltså viktat efter förbrukning, inte ett
genomsnitt av radernas pris. Standard är exkl. moms; inkl. moms visas i egen kolumn.

"Senaste 12 mån" är de 12 kalendermånaderna fram till och med bolagets sista
fakturerade period (per anläggning och bolag; "Alla anläggningar" följer bolagets
sista period över alla anläggningar). Kolumnen "Dagar täckta" visar hur stor del av
perioden som fakturorna faktiskt täcker, så ofullständiga perioder syns.
"""
import csv
from collections import defaultdict
from datetime import date

from common import FAKTUROR_CSV, SPOT_AREA, SUMMARY_CSV, SUMMARY_SV_CSV, write_csv_sv

ALL = 'Alla anläggningar'
LAST_12 = 'Senaste 12 mån'
SPOT_COL = f'Spotpris {SPOT_AREA} exkl. moms (öre/kWh)'
COLS = ['Anläggning', 'Bolag', 'Period', 'Från', 'Till', 'Dagar täckta', 'Antal fakturor',
        'Förbrukning (kWh)', 'Summa exkl. moms (SEK)', 'Summa inkl. moms (SEK)',
        'Pris exkl. moms (öre/kWh)', 'Pris inkl. moms (öre/kWh)',
        'Rörligt pris exkl. moms (öre/kWh)', 'Ordinarie pris exkl. moms (öre/kWh)',
        SPOT_COL, 'Skillnad mot spot exkl. moms (öre/kWh)', 'Ordinarie skillnad mot spot exkl. moms (öre/kWh)']


def num(v):
    return float(v) if v not in ('', None) else None


def parse_date(s):
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def window_start(end):
    """Första dagen i månaden 11 månader före slutdatumets månad (12 kalendermånader)."""
    months = end.year * 12 + end.month - 1 - 11
    return date(months // 12, months % 12 + 1, 1)


def load_invoices(path):
    """Elhandelsrader med kWh och belopp. Dubbletter (samma bolag + fakturanummer) räknas en gång."""
    seen, recs, skipped_dups = set(), [], 0
    with open(path, newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            if r['Typ'] != 'Elhandel' or num(r['Summa exkl. moms (SEK)']) is None:
                continue
            if num(r['Total förbrukning (kWh)']) is None:
                continue
            key = (r['Bolag'], r['Fakturanummer'])
            if r['Fakturanummer'] and key in seen:
                skipped_dups += 1
                continue
            seen.add(key)
            exkl = num(r['Summa exkl. moms (SEK)'])
            fast = (num(r['Fast avgift exkl. moms (SEK)']) or 0) + (num(r['Rabatt fast exkl. moms (SEK)']) or 0)
            rabatt = (num(r['Rabatt rörligt exkl. moms (SEK)']) or 0) + (num(r['Rabatt fast exkl. moms (SEK)']) or 0)
            spot = num(r[SPOT_COL])
            recs.append({
                'anl': r['Anläggning'], 'bolag': r['Bolag'],
                'year': (r['Period start'] or r['Fakturadatum'])[:4],
                'start': parse_date(r['Period start']), 'end': parse_date(r['Period slut']),
                'kwh': num(r['Total förbrukning (kWh)']),
                'exkl': exkl, 'inkl': num(r['Summa inkl. moms (SEK)']) or 0,
                'rorligt': exkl - fast, 'ordinarie': exkl - rabatt,
                'rorliga': num(r.get('Rörliga kostnader exkl. moms (SEK)', '')) or 0.0,
                # Fakturans delar i kronor exkl. moms, för att kunna räkna ut ett jämförpris för dina nuvarande avtal
                'energi': (num(r.get('Energipris exkl. moms (öre/kWh)', '')) or 0.0) * num(r['Total förbrukning (kWh)']) / 100,
                'paslag': (num(r.get('Påslag och elcertifikat exkl. moms (öre/kWh)', '')) or 0.0) * num(r['Total förbrukning (kWh)']) / 100,
                'fast_brutto': num(r.get('Fast avgift exkl. moms (SEK)', '')) or 0.0,
                'rabatt_rorlig': num(r.get('Rabatt rörligt exkl. moms (SEK)', '')) or 0.0,
                'rabatt_fast': num(r.get('Rabatt fast exkl. moms (SEK)', '')) or 0.0,
                # spotpriset omräknat till kronor för fakturans förbrukning (None om spot saknas)
                'spot_sek': None if spot is None else spot * num(r['Total förbrukning (kWh)']) / 100,
            })
    return recs, skipped_dups


def aggregate(anl, bolag, period, recs):
    """En sammanfattningsrad för en grupp fakturor, eller None om förbrukningen är noll."""
    kwh = sum(r['kwh'] for r in recs)
    if not kwh:
        return None
    dated = [r for r in recs if r['start'] and r['end']]
    per_kwh = lambda key: round(sum(r[key] for r in recs) / kwh * 100, 2)
    # Spotjämförelse bara om alla fakturor i gruppen har spotpris, annars vore snittet vilseledande
    spots = [r.get('spot_sek') for r in recs]
    has_spot = all(sp is not None for sp in spots)
    spot = round(sum(spots) / kwh * 100, 2) if has_spot else ''
    return {
        'Anläggning': anl, 'Bolag': bolag, 'Period': period,
        'Från': min((r['start'] for r in dated), default=''),
        'Till': max((r['end'] for r in dated), default=''),
        'Dagar täckta': sum((r['end'] - r['start']).days + 1 for r in dated),
        'Antal fakturor': len(recs), 'Förbrukning (kWh)': round(kwh),
        'Summa exkl. moms (SEK)': round(sum(r['exkl'] for r in recs), 2),
        'Summa inkl. moms (SEK)': round(sum(r['inkl'] for r in recs), 2),
        'Pris exkl. moms (öre/kWh)': per_kwh('exkl'),
        'Pris inkl. moms (öre/kWh)': per_kwh('inkl'),
        'Rörligt pris exkl. moms (öre/kWh)': per_kwh('rorligt'),
        'Ordinarie pris exkl. moms (öre/kWh)': per_kwh('ordinarie'),
        SPOT_COL: spot,
        'Skillnad mot spot exkl. moms (öre/kWh)': round(per_kwh('exkl') - spot, 2) if has_spot else '',
        'Ordinarie skillnad mot spot exkl. moms (öre/kWh)': round(per_kwh('ordinarie') - spot, 2) if has_spot else '',
    }


def summarize(recs):
    by_year = defaultdict(list)
    by_group = defaultdict(list)
    for r in recs:
        for anl in (r['anl'], ALL):
            by_year[(anl, r['bolag'], r['year'])].append(r)
            by_group[(anl, r['bolag'])].append(r)

    out = [aggregate(anl, bolag, year, rs) for (anl, bolag, year), rs in by_year.items()]
    for (anl, bolag), rs in by_group.items():
        dated = [r for r in rs if r['start'] and r['end']]
        if not dated:
            continue
        cutoff = window_start(max(r['end'] for r in dated))
        out.append(aggregate(anl, bolag, LAST_12, [r for r in dated if r['start'] >= cutoff]))
    out = [o for o in out if o]
    out.sort(key=lambda o: (o['Anläggning'] == ALL, o['Anläggning'], o['Bolag'], o['Period']))
    return out


def print_table(out):
    print(f"{'Anläggning':<22}{'Bolag':<11}{'Period':<16}{'Dagar':>6}{'Fakt.':>6}{'kWh':>9}"
          f"{'exkl':>8}{'inkl':>8}{'rörl.':>8}{'ord.':>8}{'spot':>8}{'±spot':>8}")
    for o in out:
        print(f"{o['Anläggning']:<22}{o['Bolag']:<11}{o['Period']:<16}{o['Dagar täckta']:>6}"
              f"{o['Antal fakturor']:>6}{o['Förbrukning (kWh)']:>9}"
              f"{o['Pris exkl. moms (öre/kWh)']:>8}{o['Pris inkl. moms (öre/kWh)']:>8}"
              f"{o['Rörligt pris exkl. moms (öre/kWh)']:>8}{o['Ordinarie pris exkl. moms (öre/kWh)']:>8}"
              f"{o[SPOT_COL]:>8}{o['Skillnad mot spot exkl. moms (öre/kWh)']:>8}")
    print('Priser i öre/kWh: exkl. moms, inkl. moms, rörligt (utan fasta avgifter), ordinarie (utan rabatter),')
    print(f'förbrukningsviktat spotpris {SPOT_AREA} och pris minus spot (tomt om spotpris saknas för någon faktura i gruppen).')
    print('Dagar täckta < 365 för senaste 12 mån betyder att fakturor saknas i perioden (se Granska i fakturor.csv).')


def main():
    recs, skipped = load_invoices(FAKTUROR_CSV)
    out = summarize(recs)
    with open(SUMMARY_CSV, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(out)
    write_csv_sv(out, COLS, SUMMARY_SV_CSV)
    undated = sum(1 for r in recs if not (r['start'] and r['end']))
    print(f'{len(recs)} elhandelsfakturor, {skipped} dubbletter hoppades över -> {SUMMARY_CSV}')
    if undated:
        print(f'Varning: {undated} fakturor saknar period och ingår därför inte i "{LAST_12}".')
    print_table(out)


if __name__ == '__main__':
    main()
