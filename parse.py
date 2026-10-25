import argparse, glob, hashlib, os, re, json, sys, tempfile
from collections import Counter, defaultdict
import pdfplumber

from common import WORKDIR, ROWS_JSON, PARSE_INDEX_JSON, sw_num, clean_id

CID_MAP = {'228':'ä','229':'å','246':'ö','214':'Ö','196':'Ä','197':'Å','153':'’'}
def fix_cid(t):
    def repl(m):
        return CID_MAP.get(m.group(1), '')
    return re.sub(r'\(cid:(\d+)\)', repl, t)

def block(text, start_pat, end_pats, flags=0):
    m = re.search(start_pat, text, flags)
    if not m:
        return None
    start = m.start()
    end = len(text)
    for ep in end_pats:
        me = re.search(ep, text[m.end():], flags)
        if me:
            cand = m.end() + me.start()
            if cand < end:
                end = cand
    return text[start:end].strip()


def extract_qty_before_kwh(line):
    """Kvantiteten (token direkt före "kWh"), med tusentalsgrupp som egen token ("3 624,10")."""
    tokens = line.split()
    for i, t in enumerate(tokens):
        m = re.match(r'^([\d.,]+)kWh$', t)
        if t == 'kWh':
            if i == 0:
                return None
            num_tok, prev = tokens[i-1], i-2
        elif m:
            num_tok, prev = m.group(1), i-1
        else:
            continue
        if re.match(r'^\d{3}(,\d+)?$', num_tok) and prev >= 0 and re.match(r'^\d{1,3}$', tokens[prev]):
            num_tok = tokens[prev] + num_tok
        return sw_num(num_tok)
    return None

def company_of(fname):
    m = re.match(r"^(\S+) faktura", fname)
    return m.group(1) if m else None

def anlaggning_of(fname):
    m = re.search(r' - (.+)\.pdf$', fname, re.I)
    if m:
        s = m.group(1)
        s = re.sub(r'\s*(AUTOGIRO)\s*$', '', s, flags=re.I).strip()
        s = re.sub(r'\s*autogiro\s*$', '', s, flags=re.I).strip()
        return s
    return None

def parse_ellevio(text, fname):
    d = {}
    d['fakturadatum'] = None
    m = re.search(r'Faktura eln[äa]t\s*\n\s*(\d{1,2} \w+ \d{4})', text)
    if m: d['fakturadatum'] = m.group(1)
    m = re.search(r'Faktura[/-]OCR-nummer:?\s*(\d+)', text)
    d['fakturanummer'] = m.group(1) if m else None
    m = re.search(r'Belopp att betala:\s*([\d\s]+,\d{2})\s*kr', text)
    d['totalsumma'] = sw_num(m.group(1)) if m else None
    m = re.search(r'Anl[äa]ggningsadress:\s*([^\n]+)', text)
    d['adress'] = m.group(1).strip() if m else None
    m = re.search(r'Anl[äa]ggnings-id:\s*([\d\s]+)', text)
    d['anlaggningsid'] = clean_id(m.group(1)) if m else None
    m = re.search(r'Kostnad (\d{1,2} \w+ \d{4}) t\s*o\s*m\s*(\d{1,2} \w+ \d{4})', text)
    if m:
        d['period_start'] = m.group(1); d['period_slut'] = m.group(2)
    else:
        d['period_start'] = d['period_slut'] = None
    kwh_matches = []
    for line in text.split(chr(10)):
        if re.search(r'R[öo]rlig eln[äa]tsavgift(?: l[åa]glast)?|[ÖO]verf[öo]ringsavgift', line):
            v = extract_qty_before_kwh(line)
            if v is not None:
                kwh_matches.append(v)
    d['forbrukning_kwh'] = sum(kwh_matches) if kwh_matches else None
    spec = block(text, r'Kostnad \d{1,2} \w+ \d{4} t\s*o\s*m', [r'(?:Statlig )?[Ee]nergiskatt \d{1,2} \w+ \d{4} t\s*o\s*m', r'M[äa]tarst[äa]llning', r'Anl[äa]ggningsinformation'])
    spec2 = block(text, r'(?:Statlig )?[Ee]nergiskatt \d{1,2} \w+ \d{4} t\s*o\s*m|Energiskatt \d{1,2}', [r'M[äa]tarst[äa]llning', r'Anl[äa]ggningsinformation'])
    parts = [p for p in [spec, spec2] if p]
    d['specifikation'] = ' || '.join(p.replace('\n',' | ') for p in parts) if parts else None
    return d

def parse_fortum(text, fname):
    d = {}
    m = re.search(r'Fakturadatum:\s*(\d{1,2} \w+ \d{4})', text)
    if not m:
        m = re.search(r'\bFaktura\n(\d{1,2} \w+ \d{4})\n', text)
    d['fakturadatum'] = m.group(1) if m else None
    m = re.search(r'Faktura[\s\-/]*(?:och[\s\-/]*)?OCR-nummer:?\s*([\d\s]+)', text)
    d['fakturanummer'] = clean_id(m.group(1)) if m else None
    m = re.search(r'Anl[äa]ggningsadress:?\s*([^\n]+)', text)
    d['adress'] = m.group(1).strip() if m else None
    m = re.search(r'Anl(?:äggnings)?[\s-]*[Ii]d:?\s*([\d\s]+)', text)
    d['anlaggningsid'] = clean_id(m.group(1)) if m else None
    m = re.search(r'F[öo]r perioden (\d{1,2} \w+ \d{4}) - (\d{1,2} \w+ \d{4})', text)
    if not m:
        m = re.search(r'Kostnad f[öo]r perioden (\d{1,2} \w+ \d{4}) t\s*o\s*m\s*(\d{1,2} \w+ \d{4})', text)
    if m:
        d['period_start'] = m.group(1); d['period_slut'] = m.group(2)
    else:
        d['period_start'] = d['period_slut'] = None
    m = re.search(r'Att betala,?[^\n]*\n([\d\s]+(?:,\d{2})?)\s*kr', text)
    if not m:
        m = re.search(r'Att betala:?\s+([\d\s]+(?:,\d{2})?)\s*kr', text)
    d['totalsumma'] = sw_num(m.group(1)) if m else None
    kwh_matches = []
    for line in text.split(chr(10)):
        if re.match(r'^El(?!certifikat|handel|omr[åa]de)\b', line):
            v = extract_qty_before_kwh(line)
            if v is not None:
                kwh_matches.append(v)
    d['forbrukning_kwh'] = sum(kwh_matches) if kwh_matches else None
    spec = block(text, r'(?:[Kk]ostnader [Ee]lhandel Period|Elhandelskostnad f[öo]r perioden)', [r'Ditt elavtal:', r'M[äa]tarst[äa]llning', r'Elen vi s[åa]lde'])
    d['specifikation'] = spec.replace('\n',' | ') if spec else None
    return d

def parse_skekraft(text, fname):
    d = {}
    m = re.search(r'Fakturadatum\s+(\d{4}-\d{2}-\d{2})', text)
    d['fakturadatum'] = m.group(1) if m else None
    m = re.search(r'Fakturanr/OCR-nr\s+(\d+)', text)
    d['fakturanummer'] = m.group(1) if m else None
    m = re.search(r'Anl[äa]ggningsadress:\s*([^\n]+)', text)
    d['adress'] = m.group(1).strip() if m else None
    m = re.search(r'Anl[äa]ggningsID:\s*(\d+)', text)
    d['anlaggningsid'] = m.group(1) if m else None
    m = re.search(r'Fakturaperiod:\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})', text)
    if m:
        d['period_start'] = m.group(1); d['period_slut'] = m.group(2)
    else:
        d['period_start'] = d['period_slut'] = None
    m = re.search(r'Summa anl[äa]ggning\s*([\d\s]+,\d{2})\s*SEK', text)
    d['totalsumma'] = sw_num(m.group(1)) if m else None
    m = re.search(r'Energif[öo]rbrukning\s+\d{4}-\d{2}-\d{2}\s+[\d,]+\s+([\d\s]+)kWh', text)
    if not m:
        m = re.search(r'\bTotalt\s+([\d\s]+)kWh', text)
    d['forbrukning_kwh'] = sw_num(m.group(1)) if m else None
    spec = block(text, r'Specifikation:', [r'M[äa]tarnummer:', r'Kundinformation'])
    d['specifikation'] = spec.replace('\n',' | ') if spec else None
    return d

def parse_tibber(text, fname):
    d = {}
    m = re.search(r'Fakturadatum:\s*(\d{1,2} \w+ \d{4})', text)
    d['fakturadatum'] = m.group(1) if m else None
    m = re.search(r'Fakturanummer:\s*(\d+)', text)
    d['fakturanummer'] = m.group(1) if m else None
    m = re.search(r'EAN/Anl[äa]ggningsid:\s*(\d+)', text)
    d['anlaggningsid'] = m.group(1) if m else None
    m1 = re.search(r'OCR-nummer:\s*\d+\s+([^\n]+)\n', text)
    m2 = re.search(r'Fakturanummer:\s*\d+\s+([^\n]+)\n', text)
    addr_parts = []
    if m1: addr_parts.append(m1.group(1).strip())
    if m2: addr_parts.append(m2.group(1).strip())
    d['adress'] = ', '.join(addr_parts) if addr_parts else None
    m = re.search(r'El f[öo]r ([^\n]+?)\s+[\d\s]+,\d{2}\s*kr', text)
    d['period_text'] = m.group(1).strip() if m else None
    d['period_start'] = d['period_slut'] = None
    m = re.search(r'([\d\s]+(?:,\d+)?)\s*kWh\s*[àa]', text)
    d['forbrukning_kwh'] = sw_num(m.group(1)) if m else None
    m = re.search(r'Summa\s*\n\s*([\d\s]+)\s*kr', text)
    d['totalsumma'] = sw_num(m.group(1)) if m else None
    spec = block(text, r'El f[öo]r ', [r'\n\d+ kr\n', r'Alltid 100'])
    d['specifikation'] = spec.replace('\n',' | ') if spec else None
    return d

def parse_vattenfall(text, fname):
    d = {}
    m = re.search(r'Fakturadatum:\s*(\d{4}-\d{2}-\d{2})', text)
    d['fakturadatum'] = m.group(1) if m else None
    m = re.search(r'Fakturanummer:\s*(\d+)', text)
    d['fakturanummer'] = m.group(1) if m else None
    m = re.search(r'Anl[äa]ggnings-ID:\s*([\d\s]+)', text)
    d['anlaggningsid'] = clean_id(m.group(1)) if m else None
    m = re.search(r'Din energik[äa]lla\n(.+?)\s+Elhandelsavtal', text)
    d['adress'] = m.group(1).strip() if m else None
    # Periodens riktiga datum står på energiraderna. "Avser" kan spänna över flera månader när ett
    # litet belopp från förra fakturan förts över, och är bara reserv.
    energy = re.findall(r'Medelspotpris\s+(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})', text)
    m = re.search(r'Avser:\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})', text)
    if energy:
        d['period_start'] = min(e[0] for e in energy); d['period_slut'] = max(e[1] for e in energy)
    elif m:
        d['period_start'] = m.group(1); d['period_slut'] = m.group(2)
    else:
        d['period_start'] = d['period_slut'] = None
    m = re.search(r'Faktura el\s*\n\s*([\d\s]+(?:,\d{2})?)\s*kr', text)
    d['totalsumma'] = sw_num(m.group(1)) if m else None
    # Förbrukningen är kvantiteten fakturan räknar kostnaden på: summan av energiraderna ("Medelspotpris ... 835kWh").
    # Diagrammet kan dela upp en månad i flera perioder (t.ex. 1-21 maj 634 kWh och 22-31 maj 201 kWh), så första
    # träffen där är bara en del av månaden. Reserv om energiraderna saknas.
    qty = re.findall(r'Medelspotpris\s+\d{4}-\d{2}-\d{2}\s*-\s*\d{4}-\d{2}-\d{2}\s+([\d\s]+)kWh', text)
    if qty:
        d['forbrukning_kwh'] = sum(sw_num(q) for q in qty)
    else:
        m = re.search(r'\d{4}-\d{2}-\d{2}\s*-\s*\d{4}-\d{2}-\d{2}\s+([\d\s]+)\s*kWh', text)
        d['forbrukning_kwh'] = sw_num(m.group(1)) if m else None
    spec = block(text, r'Specificering Period Kvantitet Pris Summa', [r'Detaljer om ditt elhandelsavtal'])
    d['specifikation'] = spec.replace('\n',' | ') if spec else None
    return d


BUNDLE_RE = re.compile(
    r'Elhandel\s+([\d\s]+,\d{2})\s*kr\s*\n\s*Ellevio AB \(publ\)\s*\n\s*Eln[äa]t\s+([\d\s]+,\d{2})\s*kr\s*\n\s*Energiskatt\s+([\d\s]+,\d{2})\s*kr'
)

def parse_bundled(text, fname):
    """Old-style combined Fortum+Ellevio invoice (pre-Aug 2021). Returns two rows."""
    bm = BUNDLE_RE.search(text)
    if not bm:
        return None
    elhandel_amt = sw_num(bm.group(1))
    elnat_amt = sw_num(bm.group(2))
    energiskatt_amt = sw_num(bm.group(3))

    m = re.search(r'Fakturadatum:\s*(\d{1,2} \w+ \d{4})', text)
    if not m:
        m = re.search(r'\bFaktura\n(\d{1,2} \w+ \d{4})\n', text)
    fakturadatum = m.group(1) if m else None
    m = re.search(r'Faktura[\s\-/]*(?:och[\s\-/]*)?OCR-nummer:?\s*([\d\s]+)', text)
    fakturanummer = clean_id(m.group(1)) if m else None
    m = re.search(r'Anl(?:äggnings)?[\s-]*[Ii]d:?\s*([\d\s]+)', text)
    anlaggningsid = clean_id(m.group(1)) if m else None
    m = re.search(r'Anl[äa]ggningsadress:?\s*([^\n]+)', text)
    adress = m.group(1).strip() if m else None
    m = re.search(r'Kostnad f[öo]r perioden (\d{1,2} \w+ \d{4}) t\s*o\s*m\s*(\d{1,2} \w+ \d{4})', text)
    if m:
        period_start, period_slut = m.group(1), m.group(2)
    else:
        period_start = period_slut = None
    kwh_matches = []
    for line in text.split(chr(10)):
        if re.match(r'^El(?!certifikat|handel|omr[åa]de)\b', line):
            v = extract_qty_before_kwh(line)
            if v is not None:
                kwh_matches.append(v)
    kwh = sum(kwh_matches) if kwh_matches else None

    base = dict(fakturadatum=fakturadatum, fakturanummer=fakturanummer, anlaggningsid=anlaggningsid,
                adress=adress, period_start=period_start, period_slut=period_slut)

    row_fortum = dict(base)
    row_fortum['bolag'] = 'Fortum'
    row_fortum['totalsumma'] = elhandel_amt
    row_fortum['forbrukning_kwh'] = kwh
    row_fortum['specifikation'] = f'Kombinerad faktura (elnät+elhandel) - Elhandel (Fortum): {bm.group(1)} kr'
    row_fortum['bundle_note'] = 'Kombinerad faktura för elnät+elhandel - uppdelad automatiskt i två rader. Endast totalbelopp per bolag kunde utläsas, ej detaljerad kostnadsspecifikation.'

    row_ellevio = dict(base)
    row_ellevio['bolag'] = 'Ellevio'
    row_ellevio['totalsumma'] = round(elnat_amt + energiskatt_amt, 2) if (elnat_amt is not None and energiskatt_amt is not None) else None
    row_ellevio['forbrukning_kwh'] = kwh
    row_ellevio['specifikation'] = f'Kombinerad faktura (elnät+elhandel) - Elnät (Ellevio): {bm.group(2)} kr, Energiskatt: {bm.group(3)} kr'
    row_ellevio['bundle_note'] = 'Kombinerad faktura för elnät+elhandel - uppdelad automatiskt i två rader. Endast totalbelopp per bolag kunde utläsas, ej detaljerad kostnadsspecifikation.'

    return [row_fortum, row_ellevio]

PARSERS = {
    'Ellevio': parse_ellevio,
    'Fortum': parse_fortum,
    'Skekraft': parse_skekraft,
    'Tibber': parse_tibber,
    'Vattenfall': parse_vattenfall,
}

def extract_text(fpath):
    with pdfplumber.open(fpath) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)
    return fix_cid(text)

DETECT_BY_TEXT = [
    ('Fortum', 'Fortum'),
    ('Ellevio', 'Ellevio'),
    ('Skekraft', 'Skellefte'),
    ('Tibber', 'Tibber'),
    ('Vattenfall', 'Vattenfall'),
]

def detect_company(text, fname):
    """Bolag ur filnamnet i första hand, annars ur innehållet."""
    comp = company_of(fname)
    if comp is not None:
        return comp
    for name, marker in DETECT_BY_TEXT:
        if marker in text:
            return name
    return None

def build_notes(d, comp):
    """Granskningsanmärkningar för ett parsat resultat (saknade fält)."""
    notes = []
    for k in ['fakturadatum', 'fakturanummer', 'anlaggningsid', 'adress']:
        if not d.get(k):
            notes.append(f'saknar {k}')
    for k in ['totalsumma', 'forbrukning_kwh']:
        if d.get(k) is None:
            notes.append(f'saknar {k}')
    if 'period_start' in d and not d.get('period_start') and comp != 'Tibber':
        notes.append('saknar period')
    if 'specifikation' in d and not d.get('specifikation'):
        notes.append('saknar specifikation')
    return notes

def process_file(f, base):
    """Parsar en PDF och returnerar en lista med rader (flera vid kombinerade fakturor)."""
    fname = os.path.basename(f)
    rel = os.path.relpath(f, base)
    comp = company_of(fname)
    try:
        text = extract_text(f)
    except Exception as e:
        return [{'fil': rel, 'bolag': comp or 'FEL', 'granska': f'Kunde inte läsa PDF: {e}'}]
    comp = detect_company(text, fname)

    bundled = parse_bundled(text, fname) if comp == 'Fortum' else None
    if bundled:
        rows = []
        for d in bundled:
            row = {'fil': rel, 'bolag': d['bolag'], 'anlaggning_fil': anlaggning_of(fname)}
            row.update(d)
            notes = [d.get('bundle_note', '')] + build_notes(d, d['bolag'])
            row['granska'] = '; '.join(n for n in notes if n)
            rows.append(row)
        return rows

    row = {'fil': rel, 'bolag': comp or 'OKÄND', 'anlaggning_fil': anlaggning_of(fname)}
    notes = []
    parser = PARSERS.get(comp)
    if parser is None:
        notes.append('Okänt bolag - ej tolkad')
    else:
        try:
            d = parser(text, fname)
            row.update(d)
            notes = build_notes(d, comp)
        except Exception as e:
            notes.append(f'parsefel: {e}')
    row['granska'] = '; '.join(notes)
    return [row]

def print_summary(rows):
    print('total', len(rows))
    print('utan anmärkning:', sum(1 for r in rows if not r.get('granska')))
    c = Counter()
    for r in rows:
        for n in (r.get('granska') or '').split('; '):
            if n:
                c[n] += 1
    for k, v in c.most_common(30):
        print(k, v)

READ_ERROR = 'Kunde inte läsa PDF'


def file_hash(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def code_signature():
    """Hash av koden som tolkar PDF:erna. Ändras den är gamla resultat inte längre pålitliga och allt tolkas om."""
    h = hashlib.sha1()
    for name in ('parse.py', 'common.py'):
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), name), 'rb') as f:
            h.update(f.read())
    return h.hexdigest()


def write_json_atomic(path, value):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix='.parse-', suffix='.tmp')
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        json.dump(value, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load_cache(full):
    """(hash per fil, rader per fil) från förra körningen, eller tomma om cachen inte kan användas."""
    if full or not os.path.exists(ROWS_JSON) or not os.path.exists(PARSE_INDEX_JSON):
        return {}, {}
    try:
        with open(PARSE_INDEX_JSON, encoding='utf-8') as f:
            index = json.load(f)
        with open(ROWS_JSON, encoding='utf-8') as f:
            rows = json.load(f)
    except (ValueError, OSError):
        return {}, {}
    if index.get('code') != code_signature():
        print('Tolkningskoden har ändrats sedan förra körningen: alla fakturor tolkas om.')
        return {}, {}
    by_file = defaultdict(list)
    for r in rows:
        by_file[r['fil']].append(r)
    return index.get('files', {}), by_file


def reusable(cached, old_hash, new_hash):
    """Samma innehåll som förra gången och inget läsfel som är värt att försöka igen."""
    return bool(cached) and old_hash == new_hash and not any((r.get('granska') or '').startswith(READ_ERROR) for r in cached)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Tolkar PDF-fakturor till rows.json. Bara nya eller ändrade filer läses om.')
    ap.add_argument('mapp', help='rotmappen med PDF-fakturor (använd alltid samma mapp, filnamnen räknas relativt den)')
    ap.add_argument('--full', action='store_true', help='tolka om alla filer, även oförändrade')
    ap.add_argument('--prune', action='store_true', help='ta bort rader för filer som inte längre finns i mappen')
    args = ap.parse_args(argv)
    base = args.mapp
    os.makedirs(WORKDIR, exist_ok=True)
    files = sorted(glob.glob(base + "/**/*.[pP][dD][fF]", recursive=True))
    old_hash, old_rows = load_cache(args.full)

    rows, new_hash, stats = [], {}, Counter()
    for i, f in enumerate(files, 1):
        rel = os.path.relpath(f, base)
        new_hash[rel] = file_hash(f)
        if reusable(old_rows.get(rel), old_hash.get(rel), new_hash[rel]):
            rows.extend(old_rows[rel])
            stats['oförändrade'] += 1
            continue
        status = 'ändrad' if rel in old_hash else 'ny'
        print(f'[{i}/{len(files)}] {rel}  ({status})', flush=True)
        rows.extend(process_file(f, base))
        stats['ändrade' if status == 'ändrad' else 'nya'] += 1

    gone = sorted(set(old_rows) - set(new_hash))
    if gone and args.prune:
        print(f'Tog bort rader för {len(gone)} filer som inte längre finns i mappen.')
    elif gone:
        for rel in gone:
            rows.extend(old_rows[rel])
            new_hash[rel] = old_hash.get(rel, '')
        print(f'Varning: {len(gone)} filer finns i rows.json men inte i mappen (raderna behålls, använd --prune för att ta bort dem). '
              'Stämmer mappen? Använd samma rotmapp varje gång.')

    write_json_atomic(ROWS_JSON, rows)
    write_json_atomic(PARSE_INDEX_JSON, {'code': code_signature(), 'files': new_hash})
    print(f"{stats['nya']} nya, {stats['ändrade']} ändrade, {stats['oförändrade']} oförändrade filer.")
    print_summary(rows)

if __name__ == '__main__':
    main()
