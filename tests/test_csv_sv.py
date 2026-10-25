import csv
import os
import sys
import tempfile
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from common import swedish_value, write_csv_sv  # noqa: E402


class SwedishCsv(unittest.TestCase):
    def test_numbers_get_decimal_comma_and_no_trailing_zero(self):
        self.assertEqual(swedish_value(1579.08), '1579,08')
        self.assertEqual(swedish_value(4369.0), '4369')
        self.assertEqual(swedish_value(-25.41), '-25,41')
        self.assertEqual(swedish_value(0.0), '0')
        self.assertEqual(swedish_value(12), '12')
        self.assertEqual(swedish_value(55.720000000000006), '55,72')   # flyttalsbrus rundas bort

    def test_text_blank_and_dates_are_left_alone(self):
        self.assertEqual(swedish_value(''), '')
        self.assertEqual(swedish_value(None), '')
        self.assertEqual(swedish_value('Byggnad C'), 'Byggnad C')
        self.assertEqual(swedish_value('735999000000000001'), '735999000000000001')   # ID-text förblir text
        self.assertEqual(swedish_value(date(2026, 9, 30)), '2026-09-30')

    def test_file_uses_semicolon_bom_and_keeps_text_with_commas_and_semicolons_intact(self):
        rows = [{'Bolag': 'Vattenfall', 'Belopp': 1579.08, 'Anteckning': 'a; b, c', 'Tom': ''}]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'x-sv.csv')
            write_csv_sv(rows, ['Bolag', 'Belopp', 'Anteckning', 'Tom'], path)
            raw = open(path, 'rb').read()
            self.assertTrue(raw.startswith(b'\xef\xbb\xbf'))                       # BOM för Excel
            with open(path, newline='', encoding='utf-8-sig') as f:
                parsed = list(csv.reader(f, delimiter=';'))
        self.assertEqual(parsed[0], ['Bolag', 'Belopp', 'Anteckning', 'Tom'])
        self.assertEqual(parsed[1], ['Vattenfall', '1579,08', 'a; b, c', ''])
        self.assertEqual(float(parsed[1][1].replace(',', '.')), 1579.08)            # går att läsa tillbaka utan förlust

    def test_missing_columns_are_blank(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'y.csv')
            write_csv_sv([{'A': 1.5}], ['A', 'B'], path)
            with open(path, newline='', encoding='utf-8-sig') as f:
                self.assertEqual(list(csv.reader(f, delimiter=';'))[1], ['1,5', ''])


if __name__ == '__main__':
    unittest.main()
