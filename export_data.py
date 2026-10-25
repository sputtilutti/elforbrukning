"""Skriver data.json till webbverktyget i web/: förbrukning och betalt pris per anläggning och månad.

Läser fakturor.csv (från finalize.py) och spotpris_se3.csv. Filen innehåller inga adresser,
anläggnings-ID eller filnamn. Webbsidan läser in den lokalt via en filväljare.

Användning:
    python3 export_data.py          # -> $WORKDIR/data.json (dina riktiga data, publicera inte)
    python3 export_data.py --demo   # -> web/demo-data.js (påhittad förbrukning, ofarlig att publicera)
"""
import argparse
import calendar
import json
import math
import os
from collections import defaultdict
from datetime import date, datetime

from common import FAKTUROR_CSV, SPOT_AREA, WORKDIR, load_avtalstyp, load_spot
from summarize import load_invoices

VAT = 0.25
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')


def split_by_month(start, end):
    """[(ÅÅÅÅ-MM, antal dagar)] för en period."""
    parts, day = [], start
    while day <= end:
        last = date(day.year, day.month, calendar.monthrange(day.year, day.month)[1])
        n = (min(end, last) - day).days + 1
        parts.append((f'{day.year}-{day.month:02d}', n))
        day = date(day.year + day.month // 12, day.month % 12 + 1, 1)
    return parts


def build_data(recs, spot, avtalstyp=None):
    """Fördelar varje faktura på kalendermånader (efter antal dagar) och summerar per anläggning."""
    avtalstyp = avtalstyp or {}
    acc = defaultdict(lambda: defaultdict(float))
    bolag_kwh = defaultdict(lambda: defaultdict(float))
    skipped = 0
    first_spot = min(spot) if spot else ''
    for r in recs:
        if not (r['start'] and r['end']) or not r['anl']:
            skipped += 1
            continue
        total_days = (r['end'] - r['start']).days + 1
        for month, n in split_by_month(r['start'], r['end']):
            if month < first_spot:
                continue
            share = n / total_days
            a = acc[(r['anl'], month)]
            a['kwh'] += r['kwh'] * share
            a['betalt_exkl'] += r['exkl'] * share
            a['ordinarie_exkl'] += r['ordinarie'] * share
            a['fast_exkl'] += (r['exkl'] - r['rorligt']) * share
            a['rorliga_exkl'] += r.get('rorliga', 0.0) * share
            # Delarna av kostnaden: energi, påslag (inkl. rörliga kostnader och elcertifikat), fasta avgifter och rabatter
            for src, dst in (('energi', 'energi_exkl'), ('paslag', 'paslag_exkl'), ('fast_brutto', 'fast_brutto_exkl'),
                             ('rabatt_rorlig', 'rabatt_rorlig_exkl'), ('rabatt_fast', 'rabatt_fast_exkl')):
                a[dst] += r.get(src, 0.0) * share
            bolag_kwh[(r['anl'], month)][r['bolag']] += r['kwh'] * share
    manader = []
    for (anl, month), a in sorted(acc.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        bolag = max(bolag_kwh[(anl, month)].items(), key=lambda kv: kv[1])[0]
        manader.append({'manad': month, 'anlaggning': anl, 'bolag': bolag, 'avtalstyp': avtalstyp.get(bolag, 'okänt'),
                        **{k: round(v, 2) for k, v in a.items()}})
    return {
        'version': 1, 'genererad': datetime.now().strftime('%Y-%m-%d'), 'elomrade': SPOT_AREA,
        'momssats': VAT, 'anlaggningar': sorted({m['anlaggning'] for m in manader}),
        'manader': manader, 'spot': spot,
    }, skipped


def demo_data(spot):
    """Påhittad förbrukning (säsongsvarierande) och påhittade avtal, med verkligt spotpris.

    Avtalen byts för att visa bolagsbyten i webbsidan: rörligt 2023-2024, fastpris 2025, rörligt från 2026.
    """
    houses = {'Hus A': 2200, 'Hus B': 1500, 'Stuga': 250}
    manader = []
    for month in sorted(spot):
        m = int(month[5:])
        season = 1 + 0.9 * math.cos(2 * math.pi * (m - 1) / 12)
        if month < '2025-01':
            bolag, typ, ore, fee = 'Rörlig El AB', 'rorligt', spot[month] + 14, 39.0
        elif month < '2026-01':
            bolag, typ, ore, fee = 'Fastpris AB', 'fast', 65.0, 29.0
        else:
            bolag, typ, ore, fee = 'Nya El AB', 'rorligt', spot[month] + 8, 45.0
        for name, base in houses.items():
            kwh = round(base * season, 1)
            betalt = kwh * ore / 100 + fee
            manader.append({'manad': month, 'anlaggning': name, 'bolag': bolag, 'avtalstyp': typ, 'kwh': kwh,
                            'betalt_exkl': round(betalt, 2), 'ordinarie_exkl': round(betalt, 2), 'fast_exkl': fee,
                            'rorliga_exkl': round(kwh * 0.06, 2) if typ == 'rorligt' else 0.0,
                            # energi + påslag = ore öre/kWh: rörligt avtal = spot + 14 öre påslag, fast = 65 öre utan påslag
                            'energi_exkl': round(kwh * (spot[month] if typ == 'rorligt' else ore) / 100, 2),
                            'paslag_exkl': round(kwh * (ore - spot[month]) / 100, 2) if typ == 'rorligt' else 0.0,
                            'fast_brutto_exkl': fee, 'rabatt_rorlig_exkl': 0.0, 'rabatt_fast_exkl': 0.0})
    return {'version': 1, 'genererad': datetime.now().strftime('%Y-%m-%d'), 'elomrade': SPOT_AREA,
            'momssats': VAT, 'demo': True, 'anlaggningar': sorted(houses), 'manader': manader, 'spot': spot}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--demo', action='store_true', help='skriv påhittad demodata till web/demo-data.js')
    args = ap.parse_args()
    spot = load_spot()
    if args.demo:
        data, path, note = demo_data(spot), os.path.join(WEB_DIR, 'demo-data.js'), ''
    else:
        recs, _ = load_invoices(FAKTUROR_CSV)
        data, skipped = build_data(recs, spot, load_avtalstyp())
        path = os.path.join(WORKDIR, 'data.json')
        note = f', {skipped} fakturor utan period hoppades över' if skipped else ''
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        if args.demo:  # .js så att den kan laddas via <script> även när sidan öppnas från disk (file://)
            f.write('window.DEMO_DATA = ')
        json.dump(data, f, ensure_ascii=False, indent=None if args.demo else 1)
        if args.demo:
            f.write(';\n')
    print(f"{len(data['manader'])} rader (anläggning × månad), {len(data['anlaggningar'])} anläggningar{note} -> {path}")


if __name__ == '__main__':
    main()
