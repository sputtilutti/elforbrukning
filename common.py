"""Gemensamma hjälpfunktioner och konfiguration för parse.py och finalize.py."""
import csv
import json
import os
import re

WORKDIR = os.getenv("WORKDIR", "./tmp/")
ROWS_JSON = os.path.join(WORKDIR, "rows.json")
PARSE_INDEX_JSON = os.path.join(WORKDIR, "parse-index.json")
FAKTUROR_CSV = os.path.join(WORKDIR, "fakturor.csv")
SUMMARY_CSV = os.path.join(WORKDIR, "sammanfattning.csv")
# Samma innehåll i svenskt format (semikolon och decimalkomma) för att öppna i Google Sheets eller Excel med svenska inställningar
FAKTUROR_SV_CSV = os.path.join(WORKDIR, "fakturor-sv.csv")
SUMMARY_SV_CSV = os.path.join(WORKDIR, "sammanfattning-sv.csv")
SPOT_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "spotpris_se3.csv")
SPOT_AREA = "SE3"
AVTALSTYP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "avtalstyp.json")
ID_NAME_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "id_name.json")
# id_name.json är din egen (ligger inte i git, den innehåller riktiga anläggnings-ID). Saknas den används exempelfilen.
ID_NAME_EXAMPLE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "id_name.example.json")

MONTHS = {
    'jan': 1, 'januari': 1, 'feb': 2, 'februari': 2, 'mar': 3, 'mars': 3,
    'apr': 4, 'april': 4, 'maj': 5, 'jun': 6, 'juni': 6, 'jul': 7, 'juli': 7,
    'aug': 8, 'augusti': 8, 'sep': 9, 'september': 9, 'okt': 10, 'oktober': 10,
    'nov': 11, 'november': 11, 'dec': 12, 'december': 12,
}


def sw_num(s):
    """Svenskt tal ("1 234,56") -> float, eller None om det inte går att tolka."""
    if s is None:
        return None
    s = s.replace('\xa0', ' ').strip()
    s = s.replace(' ', '')
    s = s.replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def clean_id(s):
    if s is None:
        return None
    return re.sub(r'\s+', '', s.strip())


def sw_date(s):
    """'5 mars 2023' -> '2023-03-05'. ISO-datum och okända format lämnas oförändrade."""
    if not s:
        return None
    s = s.strip()
    if re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s):
        return s
    m = re.match(r'^(\d{1,2}) (\w+) (\d{4})$', s)
    if m:
        d, mon, y = m.groups()
        mon_n = MONTHS.get(mon.lower())
        if mon_n:
            return f"{y}-{mon_n:02d}-{int(d):02d}"
    return s


def load_id_name():
    """Anläggnings-ID -> läsbart namn (se id_name.json, annars id_name.example.json)."""
    path = ID_NAME_FILE if os.path.exists(ID_NAME_FILE) else ID_NAME_EXAMPLE_FILE
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def load_spot(path=SPOT_CSV, area=SPOT_AREA):
    """Månadsmedelspris på elbörsen: {'ÅÅÅÅ-MM': öre/kWh exkl. moms} (se extract_spotpris.py)."""
    with open(path, newline='', encoding='utf-8') as f:
        return {r['Månad']: float(r['Spotpris exkl. moms (öre/kWh)'])
                for r in csv.DictReader(f) if r['Elområde'] == area}


def load_avtalstyp():
    """Bolag -> 'rorligt' eller 'fast' (se avtalstyp.json). Bolag som saknas får typen 'okänt'."""
    with open(AVTALSTYP_FILE, encoding='utf-8') as f:
        return json.load(f)


def swedish_value(v):
    """Tal skrivs med decimalkomma och utan onödig ".0" (4369.0 -> 4369). Allt annat skrivs som det är."""
    if isinstance(v, bool) or v is None:
        return '' if v is None else str(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        text = repr(round(v, 6))
        if text.endswith('.0'):
            text = text[:-2]
        return text.replace('.', ',')
    return str(v)


def write_csv_sv(rows, columns, path):
    """CSV för svenska kalkylarksinställningar: semikolon som skiljetecken, decimalkomma och UTF-8 med BOM.

    De vanliga filerna (fakturor.csv, sammanfattning.csv) har decimalpunkt och används av skripten. I ett kalkylark med
    svenska inställningar tolkas "1579.08" som text eller datum, så den här varianten är till för att öppnas där.
    """
    import csv as _csv
    with open(path, 'w', newline='', encoding='utf-8-sig') as f:
        w = _csv.writer(f, delimiter=';')
        w.writerow(columns)
        for row in rows:
            w.writerow([swedish_value(row.get(c, '')) for c in columns])
