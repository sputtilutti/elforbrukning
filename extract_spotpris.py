"""Månadsmedelspris på elbörsen för elområde SE3 (öre/kWh, exkl. moms), från januari 2023.

Källor (Energimarknadsbyrån):
  - PDF "Månadspriser på elbörsen mellan 1996 och 2025": en tabell per år med SE01-SE04.
  - Webbsidan "Månadspriser på elbörsen", rubriken "Elpriset <år>", för år som saknas i PDF:en.

Användning:
    python3 extract_spotpris.py <pdf> [--web-year 2026]

Skriver spotpris_se3.csv (i projektmappen). Körs om när webbsidan fått nya månader.
"""
import argparse
import csv
import html
import os
import re
import urllib.request

import pdfplumber

OUT_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'spotpris_se3.csv')
WEB_URL = ('https://www.energimarknadsbyran.se/el/dina-elavtal-och-kostnader/elhandelsavtalet/'
           'elpriser-statistik/manadspriser-pa-elborsen/')
FIRST_YEAR = 2023
AREA_COL = 2  # SE01, SE02, SE03, SE04 -> SE3 är index 2
MONTHS = ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni', 'Juli', 'Augusti',
          'September', 'Oktober', 'November', 'December']
NUM = r'\d+(?:,\d+)?'


def to_float(s):
    return float(s.replace(',', '.'))


def from_pdf(path):
    """{(år, månadsnummer): pris} för SE3 från FIRST_YEAR och framåt, med kontroll mot kalenderårsvärdet."""
    prices = {}
    with pdfplumber.open(path) as pdf:
        lines = [l for p in pdf.pages for l in (p.extract_text() or '').splitlines()]
    year = None
    for line in lines:
        m = re.match(r'^(\d{4}) SE01 SE02 SE03 SE04$', line)
        if m:
            year = int(m.group(1))
            continue
        if year is None or year < FIRST_YEAR:
            continue
        m = re.match(rf'^(\w+) ({NUM}) ({NUM}) ({NUM}) ({NUM})$', line)
        if not m:
            continue
        label, values = m.group(1), [to_float(v) for v in m.groups()[1:]]
        if label in MONTHS:
            prices[(year, MONTHS.index(label) + 1)] = values[AREA_COL]
        elif label.startswith('Kalenderåret'):
            months = [prices[(year, mo)] for mo in range(1, 13) if (year, mo) in prices]
            if len(months) == 12 and abs(sum(months) / 12 - values[AREA_COL]) > 1.0:
                print(f'Varning: {year} månadssnitt {sum(months) / 12:.1f} avviker från kalenderåret {values[AREA_COL]}')
    return prices


def from_web(year):
    """{(år, månadsnummer): pris} för SE3 för de månader som hunnit publiceras på webbsidan."""
    with urllib.request.urlopen(WEB_URL) as resp:
        page = resp.read().decode('utf-8', errors='replace')
    start = page.index(f'Elpriset {year}')
    text = html.unescape(re.sub(r'<[^>]+>', '\n', page[start:start + 8000]))
    tokens = [t.strip() for t in text.splitlines() if t.strip()]
    prices = {}
    for i, tok in enumerate(tokens):
        if tok in MONTHS:
            cells = []
            for nxt in tokens[i + 1:i + 5]:
                if not re.fullmatch(NUM, nxt):
                    break
                cells.append(to_float(nxt))
            if len(cells) == 4:  # månader utan data (tomma celler) hoppas över
                prices[(year, MONTHS.index(tok) + 1)] = cells[AREA_COL]
    return prices


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pdf')
    ap.add_argument('--web-year', type=int, default=2026)
    args = ap.parse_args()

    pdf_prices = from_pdf(args.pdf)
    web_prices = {k: v for k, v in from_web(args.web_year).items() if k not in pdf_prices}
    rows = [(k, v, 'PDF') for k, v in pdf_prices.items()] + [(k, v, 'Webb') for k, v in web_prices.items()]
    rows.sort()
    with open(OUT_CSV, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['Månad', 'Elområde', 'Spotpris exkl. moms (öre/kWh)', 'Källa'])
        for (y, m), price, src in rows:
            w.writerow([f'{y}-{m:02d}', 'SE3', price, src])
    print(f'{len(rows)} månader ({rows[0][0][0]}-{rows[0][0][1]:02d} till {rows[-1][0][0]}-{rows[-1][0][1]:02d}) -> {OUT_CSV}')


if __name__ == '__main__':
    main()
