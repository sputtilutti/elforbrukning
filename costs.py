"""Tolkar kostnadsraderna i elhandelsfakturornas specifikation (Fortum, Skekraft, Vattenfall).

Indata är specifikationstexten från rows.json (rader separerade med ' | ').
Utdata är belopp i SEK (exkl. moms om inget annat anges) uppdelade i kategorier,
så att bolagen kan jämföras på samma kolumner.
"""
import re

from common import sw_num

# Slutbelopp på raden: "... 1 794,80 SEK", "... -144,97 kr", "...2 138,50SEK", "... 2853.36 kr", "... 43,63 kr*"
# Tusentalsgrupper måste vara exakt tre siffror, annars fångas t.ex. ett fakturanummer före beloppet
AMOUNT_END = re.compile(r'(-?(?:\d{1,3}(?: \d{3})+|\d+)[,.]\d{1,2})\s*(?:kr|SEK)\*?\s*$')
VAT_BASE = re.compile(r'^moms\b.*?\bav\s+(\d[\d ]*,\d{2})\s*kr')

TOLERANCE = 0.05  # SEK, för avrundningsskillnader vid kontrollsummering

# Efter dessa rader kommer bara en upprepning av summorna (Fortum: Att betala, Momsgrundande, Öresutjämning)
FOOTER_STARTS = ('att betala', 'momsgrundande', 'öresutjämning')

# Kategorier som ingår i summan exkl. moms
LINE_CATEGORIES = ['energi', 'paslag', 'rorliga', 'elcert', 'fast', 'rabatt_rorlig', 'rabatt_fast']


def classify(label):
    """Kategori för en kostnadsrad utifrån dess text (gemener), eller None om okänd."""
    if label.startswith('summa exkl'):
        return 'summa_exkl'
    if label.startswith('moms'):
        return 'moms'
    if label.startswith('belopp från faktura'):
        return 'overfort'  # tidigare fakturas belopp som tas med här (Vattenfall), inte periodens kostnad
    if label.startswith('totalt') or label.startswith('summa anläggning'):
        return 'summa_total'
    if label.startswith('summa'):
        return 'summa_inkl'
    if 'rabatt' in label:
        # Rabatt per kWh ("... kWh -0,030 SEK/kWh") skiljs från rabatt på avgifter ("1 Mån ...")
        return 'rabatt_rorlig' if 'kwh' in label else 'rabatt_fast'
    if 'elcertifikat' in label:
        return 'elcert'
    if 'månadsavgift' in label or 'årsavgift' in label:
        return 'fast'
    if label.startswith('fossilfri'):
        return 'ignorera'
    if label.startswith('medelspotpris') or label.startswith('fast elpris') or re.match(r'^el\b', label):
        return 'energi'
    if label.startswith('rörliga kostnader'):
        return 'rorliga'  # varierar månadsvis, till skillnad från fasta påslag
    if label.startswith('fast påslag'):
        return 'paslag'
    return None


def parse_cost_lines(spec):
    """Returnerar (belopp, anmärkningar). Beloppen är en dict med nycklarna
    energi, paslag, rorliga, elcert, fast, rabatt_rorlig, rabatt_fast, moms, summa_exkl, summa_inkl, overfort.

    En faktura kan ha flera delsummor (Fortum: elhandel + tilläggstjänster), som läggs ihop.
    summa_inkl avser periodens egen kostnad, alltså utan överfört belopp från tidigare faktura.
    """
    amounts = {k: 0.0 for k in LINE_CATEGORIES}
    notes = []
    sums = {'summa_exkl': None, 'moms': None, 'summa_inkl': None, 'summa_total': None, 'overfort': None, 'vat_base': None}

    def accumulate(key, value):
        sums[key] = value if sums[key] is None else sums[key] + value

    for line in (spec or '').split(' | '):
        line = line.strip()
        label = line.lower()
        if label.startswith(FOOTER_STARTS):
            break
        m = AMOUNT_END.search(line)
        if not m:
            continue  # rubriker, periodrader m.m.
        value = sw_num(m.group(1))
        cat = classify(label)
        if cat is None:
            notes.append(f'okänd kostnadsrad: {line[:40]}')
        elif cat == 'moms':
            accumulate('moms', value)
            base = VAT_BASE.match(label)
            if base:  # Vattenfall anger underlaget för momsen = summa exkl. moms
                sums['vat_base'] = sw_num(base.group(1))
        elif cat == 'summa_total':
            if sums['summa_total'] is None:
                sums['summa_total'] = value
        elif cat in ('summa_exkl', 'summa_inkl', 'overfort'):
            accumulate(cat, value)
        elif cat != 'ignorera':
            amounts[cat] += value

    lines_sum = sum(amounts.values())
    explicit_exkl = sums['summa_exkl'] if sums['summa_exkl'] is not None else sums['vat_base']
    summa_exkl = explicit_exkl if explicit_exkl is not None else lines_sum
    moms, overfort = sums['moms'], sums['overfort'] or 0.0
    reported_inkl = sums['summa_inkl'] if sums['summa_inkl'] is not None else sums['summa_total']
    summa_inkl = None if reported_inkl is None else reported_inkl - overfort
    if summa_inkl is None and moms is not None:
        summa_inkl = summa_exkl + moms

    if explicit_exkl is not None and abs(lines_sum - explicit_exkl) > TOLERANCE:
        notes.append('kostnadsraderna summerar inte till summa exkl. moms')
    if moms is None:
        notes.append('saknar moms')
    elif summa_inkl is not None and abs(summa_exkl + moms - summa_inkl) > TOLERANCE:
        notes.append('summa exkl. moms + moms stämmer inte med totalsumman')

    amounts.update(moms=moms, summa_exkl=summa_exkl, summa_inkl=summa_inkl, overfort=overfort)
    return amounts, notes
