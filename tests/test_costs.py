import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from costs import parse_cost_lines  # noqa: E402
from finalize import cost_columns  # noqa: E402

# Specifikationstexter hämtade ur rows.json (Byggnad A, en månad per bolag)
FORTUM = (
    "Kostnader Elhandel Period Antal Pris exkl. moms Summa"
    " | El 2024-01-01 - 2024-01-31 3 624,10 kWh 97,17 öre/kWh 3 521,50 kr"
    " | Elcertifikat 2024-01-01 - 2024-01-31 3 624,10 kWh 2,20 öre/kWh 79,73 kr"
    " | Månadsavgift 2024-01-01 - 2024-01-31 1 Mån 39,20 kr/mån 39,20 kr"
    " | Rabatt el 2024-01-01 - 2024-01-31 3 624,10 kWh -4,00 öre/kWh -144,97 kr"
    " | Fossilfri ingår 2024-01-01 - 2024-01-31 3 624,10 kWh 0,00 öre/kWh 0,00 kr"
    " | Summa exkl. moms 3 495,46 kr | Moms 25 % 873,86 kr | Summa 4 369,32 kr | 2023 2024"
)
SKEKRAFT = (
    "Specifikation:"
    " | Elhandel 2025-01-01 - 2025-01-31"
    " | Fast elpris 2 800 kWh 0,64100 SEK/kWh 1 794,80 SEK"
    " | Månadsavgift 1 Mån 39,20 SEK"
    " | Rabatt månadsavgift 1 Mån -39,20000 -39,20 SEK"
    " | Rabatt elpris 2 800 kWh -0,030 SEK/kWh -84,00 SEK"
    " | Moms 25,00 % 427,70 SEK | Totalt 2 138,50 SEK | Summa anläggning 2 138,50SEK"
)
VATTENFALL = (
    "Specificering Period Kvantitet Pris Summa"
    " | Medelspotpris 2026-01-01 - 2026-01-31 3 211kWh 108,45öre/kWh 3 482,33 kr"
    " | Rörliga kostnader 2026-01-01 - 2026-01-31 3 211kWh 6,42öre/kWh 206,15 kr"
    " | Fast påslag spot 2026-01-01 - 2026-01-31 3 211kWh 7,00öre/kWh 224,77 kr"
    " | 75% rabatt t.o.m 2026-11-30 2026-01-01 - 2026-01-31 3 211kWh 5,25öre/kWh -168,58 kr"
    " | Fast påslag elcertifikat 2026-01-01 - 2026-01-31 3 211kWh 1,40öre/kWh 44,95 kr"
    " | Årsavgift 2026-01-01 - 2026-01-31 31dygn 432,00kr/år 36,69 kr"
    " | Kampanjrabatt t.o.m 2026-11-30 2026-01-01 - 2026-01-31 1,00mån 120,00kr/mån -120,00 kr"
    " | Moms 25 % av 3 706,31 kr 926,58 kr | Summa Vattenfall AB Försäljning 4 632,89 kr"
)

# Fortum januari 2023: äldre layout ("elhandel" med liten bokstav, "Summa exkl moms" med decimalpunkt)
# och en sidfot som upprepar summorna
FORTUM_2023 = (
    "Kostnader elhandel Period Antal Pris exkl. moms Summa"
    " | Fossilfri el 2023-01-01 - 2023-01-31 1 mån 0,00 kr/mån 0,00 kr"
    " | Månadsavgift 2023-01-01 - 2023-01-31 1 mån 39,20 kr/mån 39,20 kr"
    " | El 2023-01-01 - 2023-01-31 2720 kWh 107,45 öre/kWh 2 922,97 kr"
    " | Rabatt 2023-01-01 - 2023-01-31 2720 kWh -4,00 öre/kWh -108,81 kr"
    " | Summa exkl moms 2853.36 kr | Moms 25 % 713,34 kr | Summa 3 566,70 kr | Att betala 3 567,00 kr"
    " | Momsgrundande 2 853,36 kr | Moms 25 % 713,34 kr | Öresutjämning 0,30 kr"
)
# Fortum aug 2024: extra block "Tilläggstjänster" med egna summor
FORTUM_TILLAGG = (
    "Kostnader Elhandel Period Antal Pris exkl. moms Summa"
    " | El 2024-08-01 - 2024-08-31 657,86 kWh 16,07 öre/kWh 105,71 kr"
    " | Elcertifikat 2024-08-01 - 2024-08-31 657,86 kWh 2,20 öre/kWh 14,47 kr"
    " | Månadsavgift 2024-08-01 - 2024-08-31 1 Mån 39,20 kr/mån 39,20 kr"
    " | Rabatt el 2024-08-01 - 2024-08-31 657,86 kWh -4,00 öre/kWh -26,31 kr"
    " | Summa exkl. moms 133,07 kr | Moms 25 % 33,27 kr | Summa 166,34 kr"
    " | Tilläggstjänster Period Antal Pris exkl. moms Summa"
    " | Fossilfri ingår 2024-08-01 - 2024-08-31 657,86 kWh 0,00 öre/kWh 0,00 kr"
    " | Summa exkl. moms 0,00 kr | Moms 25 % 0,00 kr | Summa 0,00 kr | 2023 2024"
)
# Vattenfall april 2026: belopp från förra (för liten) fakturan är överfört
VATTENFALL_CARRY = (
    "Specificering Period Kvantitet Pris Summa"
    " | Medelspotpris 2026-04-01 - 2026-04-30 161kWh 56,08öre/kWh 90,29 kr"
    " | Rörliga kostnader 2026-04-01 - 2026-04-30 161kWh 4,59öre/kWh 7,39 kr"
    " | Fast påslag spot 2026-04-01 - 2026-04-30 161kWh 7,00öre/kWh 11,27 kr"
    " | 75% rabatt t.o.m 2026-11-30 2026-04-01 - 2026-04-30 161kWh 5,25öre/kWh -8,45 kr"
    " | Fast påslag elcertifikat 2026-04-01 - 2026-04-30 161kWh 1,40öre/kWh 2,25 kr"
    " | Årsavgift 2026-04-01 - 2026-04-30 30dygn 432,00kr/år 35,51 kr"
    " | Kampanjrabatt t.o.m 2026-11-30 2026-04-01 - 2026-04-30 1,00mån 120,00kr/mån -120,00 kr"
    " | Belopp från faktura 543000000000 43,63 kr*"
    " | Moms 25 % av 18,26 kr 4,57 kr | Summa Vattenfall AB Försäljning 66,46 kr | *Belopp är ej momspliktigt"
)


class ParseCostLines(unittest.TestCase):
    def test_fortum_2023_old_layout_ignores_footer_recap(self):
        a, notes = parse_cost_lines(FORTUM_2023)
        self.assertEqual(notes, [])
        self.assertAlmostEqual(a['summa_exkl'], 2853.36)
        self.assertAlmostEqual(a['moms'], 713.34)         # inte dubblerad av sidfoten
        self.assertAlmostEqual(a['summa_inkl'], 3566.70)  # inte "Att betala" (avrundat)

    def test_fortum_additional_services_block_is_added_not_overwritten(self):
        a, notes = parse_cost_lines(FORTUM_TILLAGG)
        self.assertEqual(notes, [])
        self.assertAlmostEqual(a['summa_exkl'], 133.07)
        self.assertAlmostEqual(a['moms'], 33.27)
        self.assertAlmostEqual(a['summa_inkl'], 166.34)

    def test_vattenfall_carried_over_amount_is_excluded_from_own_cost(self):
        a, notes = parse_cost_lines(VATTENFALL_CARRY)
        self.assertEqual(notes, [])
        self.assertAlmostEqual(a['overfort'], 43.63)
        self.assertAlmostEqual(a['summa_exkl'], 18.26)
        self.assertAlmostEqual(a['summa_inkl'], 66.46 - 43.63)

    def test_fortum(self):
        a, notes = parse_cost_lines(FORTUM)
        self.assertEqual(notes, [])
        self.assertAlmostEqual(a['energi'], 3521.50)
        self.assertAlmostEqual(a['elcert'], 79.73)
        self.assertAlmostEqual(a['fast'], 39.20)
        self.assertAlmostEqual(a['rabatt_rorlig'], -144.97)
        self.assertAlmostEqual(a['summa_exkl'], 3495.46)
        self.assertAlmostEqual(a['summa_inkl'], 4369.32)

    def test_skekraft(self):
        a, notes = parse_cost_lines(SKEKRAFT)
        self.assertEqual(notes, [])
        self.assertAlmostEqual(a['rabatt_rorlig'], -84.00)
        self.assertAlmostEqual(a['rabatt_fast'], -39.20)
        self.assertAlmostEqual(a['summa_exkl'], 1710.80)
        self.assertAlmostEqual(a['summa_inkl'], 2138.50)

    def test_vattenfall(self):
        a, notes = parse_cost_lines(VATTENFALL)
        self.assertEqual(notes, [])
        self.assertAlmostEqual(a['paslag'], 224.77)    # fast påslag
        self.assertAlmostEqual(a['rorliga'], 206.15)   # rörliga kostnader skiljs från fasta påslag
        self.assertAlmostEqual(a['elcert'], 44.95)
        self.assertAlmostEqual(a['rabatt_rorlig'], -168.58)
        self.assertAlmostEqual(a['rabatt_fast'], -120.00)
        self.assertAlmostEqual(a['summa_exkl'], 3706.31)
        self.assertAlmostEqual(a['summa_inkl'], 4632.89)

    def test_unknown_line_and_mismatch_are_flagged(self):
        _, notes = parse_cost_lines(FORTUM.replace('Fossilfri ingår', 'Nytt påslag').replace('0,00 kr', '5,00 kr', 1))
        self.assertTrue(any('okänd kostnadsrad' in n for n in notes))


class CostColumns(unittest.TestCase):
    def test_prices_per_kwh(self):
        row = {'bolag': 'Vattenfall', 'specifikation': VATTENFALL, 'forbrukning_kwh': 3211.0}
        c, notes = cost_columns(row)
        self.assertEqual(notes, [])
        self.assertEqual(c['Energipris exkl. moms (öre/kWh)'], 108.45)
        self.assertEqual(c['Rörliga kostnader exkl. moms (SEK)'], 206.15)
        self.assertEqual(c['Påslag och elcertifikat exkl. moms (öre/kWh)'], 14.82)  # påslag + rörliga + elcert
        self.assertEqual(c['Pris exkl. moms (öre/kWh)'], 115.43)
        self.assertEqual(c['Pris inkl. moms (öre/kWh)'], 144.28)
        # utan rabatter: 3706,31 + 168,58 + 120,00 = 3994,89 kr
        self.assertEqual(c['Ordinarie pris exkl. moms (öre/kWh)'], 124.41)

    def test_no_kwh_gives_blank_prices_but_amounts(self):
        row = {'bolag': 'Skekraft', 'specifikation': SKEKRAFT, 'forbrukning_kwh': None}
        c, _ = cost_columns(row)
        self.assertEqual(c['Pris exkl. moms (öre/kWh)'], '')
        self.assertEqual(c['Summa exkl. moms (SEK)'], 1710.80)

    def test_elnat_and_bundled_are_skipped(self):
        for r in ({'bolag': 'Ellevio', 'specifikation': 'x 1,00 kr'},
                  {'bolag': 'Fortum', 'specifikation': 'Kombinerad faktura - Elhandel (Fortum): 1 kr'}):
            c, notes = cost_columns(r)
            self.assertEqual(set(c.values()), {''})
            self.assertEqual(notes, [])


if __name__ == '__main__':
    unittest.main()
