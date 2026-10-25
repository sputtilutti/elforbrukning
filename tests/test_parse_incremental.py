import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.modules.setdefault('pdfplumber', types.ModuleType('pdfplumber'))   # PDF-läsningen ersätts av en stub nedan

import parse  # noqa: E402


class Incremental(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pdfs = os.path.join(self.tmp.name, 'pdfs')
        self.work = os.path.join(self.tmp.name, 'work')
        os.makedirs(os.path.join(self.pdfs, '2026'))
        self.calls = []
        self.fail_on = set()

        def fake_process(path, base):
            rel = os.path.relpath(path, base)
            self.calls.append(rel)
            if rel in self.fail_on:
                return [{'fil': rel, 'bolag': 'FEL', 'granska': f'{parse.READ_ERROR}: tillfälligt'}]
            return [{'fil': rel, 'bolag': 'Fortum', 'granska': '', 'hash': parse.file_hash(path)}]

        patches = [
            mock.patch.object(parse, 'WORKDIR', self.work),
            mock.patch.object(parse, 'ROWS_JSON', os.path.join(self.work, 'rows.json')),
            mock.patch.object(parse, 'PARSE_INDEX_JSON', os.path.join(self.work, 'parse-index.json')),
            mock.patch.object(parse, 'process_file', fake_process),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)

    def add(self, name, content=b'pdf'):
        with open(os.path.join(self.pdfs, name), 'wb') as f:
            f.write(content)

    def run_parse(self, *extra):
        self.calls.clear()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            parse.main([self.pdfs, *extra])
        with open(os.path.join(self.work, 'rows.json'), encoding='utf-8') as f:
            return json.load(f), out.getvalue()

    def test_first_run_parses_everything_and_second_run_nothing(self):
        self.add('2026/a.pdf', b'1')
        self.add('2026/b.pdf', b'2')
        rows, _ = self.run_parse()
        self.assertEqual(sorted(self.calls), [os.path.join('2026', 'a.pdf'), os.path.join('2026', 'b.pdf')])
        again, out = self.run_parse()
        self.assertEqual(self.calls, [])
        self.assertEqual(again, rows)
        self.assertIn('0 nya, 0 ändrade, 2 oförändrade', out)

    def test_new_file_is_added_without_touching_the_others(self):
        self.add('2026/a.pdf', b'1')
        self.run_parse()
        self.add('2026/sep.pdf', b'sept')
        rows, out = self.run_parse()
        self.assertEqual(self.calls, [os.path.join('2026', 'sep.pdf')])
        self.assertEqual(sorted(r['fil'] for r in rows), [os.path.join('2026', 'a.pdf'), os.path.join('2026', 'sep.pdf')])
        self.assertIn('1 nya, 0 ändrade, 1 oförändrade', out)
        self.assertIn('(ny)', out)

    def test_changed_file_is_reparsed(self):
        self.add('2026/a.pdf', b'1')
        self.add('2026/b.pdf', b'2')
        self.run_parse()
        self.add('2026/a.pdf', b'ny version')
        rows, out = self.run_parse()
        self.assertEqual(self.calls, [os.path.join('2026', 'a.pdf')])
        self.assertIn('(ändrad)', out)
        self.assertEqual(next(r for r in rows if r['fil'].endswith('a.pdf'))['hash'], parse.file_hash(os.path.join(self.pdfs, '2026', 'a.pdf')))

    def test_changed_parser_code_reparses_everything(self):
        self.add('2026/a.pdf')
        self.run_parse()
        with mock.patch.object(parse, 'code_signature', return_value='annan kod'):
            _, out = self.run_parse()
        self.assertEqual(len(self.calls), 1)
        self.assertIn('alla fakturor tolkas om', out)

    def test_full_flag_reparses_everything(self):
        self.add('2026/a.pdf')
        self.run_parse()
        self.run_parse('--full')
        self.assertEqual(len(self.calls), 1)

    def test_files_that_failed_to_read_are_retried(self):
        self.add('2026/a.pdf')
        self.fail_on = {os.path.join('2026', 'a.pdf')}
        self.run_parse()
        self.fail_on = set()
        rows, _ = self.run_parse()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(rows[0]['bolag'], 'Fortum')

    def test_missing_files_keep_their_rows_unless_pruned(self):
        self.add('2026/a.pdf', b'1')
        self.add('2026/b.pdf', b'2')
        self.run_parse()
        os.remove(os.path.join(self.pdfs, '2026', 'b.pdf'))
        rows, out = self.run_parse()
        self.assertEqual(len(rows), 2)
        self.assertIn('Varning', out)
        rows, out = self.run_parse('--prune')
        self.assertEqual([r['fil'] for r in rows], [os.path.join('2026', 'a.pdf')])
        self.assertIn('Tog bort', out)

    def test_rows_from_one_file_stay_together(self):
        # En kombinerad faktura ger två rader från samma fil, och båda ska behållas
        self.add('2026/a.pdf')
        two = lambda path, base: [{'fil': os.path.relpath(path, base), 'bolag': b, 'granska': ''} for b in ('Fortum', 'Ellevio')]
        with mock.patch.object(parse, 'process_file', two):
            self.run_parse()
            rows, _ = self.run_parse()
        self.assertEqual([r['bolag'] for r in rows], ['Fortum', 'Ellevio'])

    def test_corrupt_index_falls_back_to_full_parse(self):
        self.add('2026/a.pdf')
        self.run_parse()
        with open(os.path.join(self.work, 'parse-index.json'), 'w') as f:
            f.write('{trasig')
        self.run_parse()
        self.assertEqual(len(self.calls), 1)


class VattenfallConsumption(unittest.TestCase):
    # Utdrag ur en Vattenfall-faktura där månaden delats i två förbrukningsperioder i diagrammet (634 + 201 = 835 kWh)
    SPLIT = (
        "Fakturanummer: 521000000000\nFakturadatum: 2026-06-01\nAvser: 2026-05-01 - 2026-05-31\nFaktura el\n803,05 kr\n"
        "Period Förbrukning\n3500 2026-05-01 - 2026-05-21 634 kWh\nPeriod Förbrukning\n2026-05-22 - 2026-05-31 201 kWh\n"
        "Det här betalar du för:\nSpecificering Period Kvantitet Pris Summa\n"
        "Medelspotpris 2026-05-01 - 2026-05-31 835kWh 77,05öre/kWh 643,37 kr\n"
        "Rörliga kostnader 2026-05-01 - 2026-05-31 835kWh 6,99öre/kWh 58,37 kr\n"
        "Summa Vattenfall AB Försäljning 803,05 kr\nDetaljer om ditt elhandelsavtal\n"
    )

    def test_consumption_is_the_billed_quantity_not_the_first_chart_period(self):
        d = parse.parse_vattenfall(self.SPLIT, 'x.pdf')
        self.assertEqual(d['forbrukning_kwh'], 835.0)

    def test_thousands_separator_and_several_price_periods_are_summed(self):
        text = self.SPLIT.replace('835kWh 77,05', '1 377kWh 77,05') + "Medelspotpris 2026-05-15 - 2026-05-31 100kWh 70,00öre/kWh 70,00 kr\n"
        self.assertEqual(parse.parse_vattenfall(text, 'x.pdf')['forbrukning_kwh'], 1477.0)

    def test_falls_back_to_the_first_period_when_there_are_no_energy_lines(self):
        text = "Fakturadatum: 2026-06-01\n2026-05-01 - 2026-05-31 1 377 kWh\n"
        self.assertEqual(parse.parse_vattenfall(text, 'x.pdf')['forbrukning_kwh'], 1377.0)


if __name__ == '__main__':
    unittest.main()
