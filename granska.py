"""Visar fakturor med anmärkning i kolumnen Granska (saknade fält, luckor i perioder, okända kostnadsrader m.m.).

Läser fakturor.csv (från finalize.py). Standard är fakturor från 2023-01, eftersom äldre fakturor
(Gamla Fakturor/) har kända anmärkningar som inte påverkar jämförelsen.

Användning:
    python3 granska.py                 # från 2023-01
    python3 granska.py --from 2021-01  # allt från 2021
"""
import argparse
import csv

from common import FAKTUROR_CSV


def rows_to_review(rows, from_month):
    """Rader med anmärkning vars period (eller fakturadatum) börjar senast `from_month` (ÅÅÅÅ-MM)."""
    out = []
    for r in rows:
        if not r['Granska']:
            continue
        when = (r['Period start'] or r['Fakturadatum'])[:7]
        if when >= from_month:
            out.append(r)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--from', dest='from_month', default='2023-01', help='första månad som granskas (ÅÅÅÅ-MM)')
    args = ap.parse_args(argv)
    with open(FAKTUROR_CSV, newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    flagged = rows_to_review(rows, args.from_month)
    older = sum(1 for r in rows if r['Granska']) - len(flagged)
    if not flagged:
        print(f'Granska: inga anmärkningar för fakturor från {args.from_month} ({len(rows)} rader kontrollerade).')
    else:
        print(f'Granska: {len(flagged)} fakturor från {args.from_month} har anmärkningar:')
        for r in flagged:
            name = r['Källfil'].split('/')[-1]
            print(f"  {r['Period start'] or r['Fakturadatum']}  {r['Bolag']:<10} {r['Anläggning']:<14} {name}")
            print(f"      {r['Granska']}")
    if older:
        print(f'({older} äldre rader med anmärkningar visas inte, använd --from 2020-01 för att se dem.)')


if __name__ == '__main__':
    main()
