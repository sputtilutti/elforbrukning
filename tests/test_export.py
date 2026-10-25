import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from export_data import build_data, split_by_month  # noqa: E402


def rec(start, end, kwh=100.0, bolag='Fortum', exkl=100.0, anl='A'):
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    return {'anl': anl, 'bolag': bolag, 'start': s, 'end': e, 'kwh': kwh, 'exkl': exkl,
            'ordinarie': exkl, 'rorligt': exkl - 10,
            'energi': exkl - 30, 'paslag': 20.0, 'fast_brutto': 15.0, 'rabatt_rorlig': -5.0, 'rabatt_fast': 0.0}


class Export(unittest.TestCase):
    SPOT = {'2024-01': 50.0, '2024-02': 60.0}

    def test_period_is_split_by_days_between_months(self):
        self.assertEqual(split_by_month(date(2024, 1, 16), date(2024, 2, 15)), [('2024-01', 16), ('2024-02', 15)])

    def test_kwh_and_cost_are_allocated_by_days(self):
        data, _ = build_data([rec('2024-01-16', '2024-02-15', kwh=310.0, exkl=310.0)], self.SPOT)
        by_month = {m['manad']: m for m in data['manader']}
        self.assertAlmostEqual(by_month['2024-01']['kwh'], 160.0, places=1)   # 16 av 31 dagar
        self.assertAlmostEqual(by_month['2024-02']['kwh'], 150.0, places=1)

    def test_cost_parts_are_exported_and_allocated_by_days(self):
        # energi + påslag + fasta avgifter + rabatter ska gå ihop med totalen, även efter fördelning på månader
        data, _ = build_data([rec('2024-01-16', '2024-02-15', kwh=310.0, exkl=310.0)], self.SPOT)
        jan = next(m for m in data['manader'] if m['manad'] == '2024-01')
        share = 16 / 31
        self.assertAlmostEqual(jan['energi_exkl'], 280.0 * share, places=1)
        self.assertAlmostEqual(jan['paslag_exkl'], 20.0 * share, places=1)
        self.assertAlmostEqual(jan['fast_brutto_exkl'], 15.0 * share, places=1)
        self.assertAlmostEqual(jan['rabatt_rorlig_exkl'], -5.0 * share, places=1)

    def test_contract_type_comes_from_bolag_mapping(self):
        data, _ = build_data([rec('2024-01-01', '2024-01-31', bolag='Skekraft')], self.SPOT, {'Skekraft': 'fast'})
        self.assertEqual(data['manader'][0]['avtalstyp'], 'fast')

    def test_unknown_bolag_gets_okant_and_no_personal_fields(self):
        data, _ = build_data([rec('2024-01-01', '2024-01-31', bolag='Nytt AB')], self.SPOT, {})
        self.assertEqual(data['manader'][0]['avtalstyp'], 'okänt')
        self.assertEqual(set(data['manader'][0]), {'manad', 'anlaggning', 'bolag', 'avtalstyp', 'kwh',
                                                   'betalt_exkl', 'ordinarie_exkl', 'fast_exkl', 'rorliga_exkl',
                                                   'energi_exkl', 'paslag_exkl', 'fast_brutto_exkl', 'rabatt_rorlig_exkl', 'rabatt_fast_exkl'})

    def test_months_before_spot_data_are_dropped_and_undated_skipped(self):
        data, skipped = build_data([rec('2023-06-01', '2023-06-30'), rec('2024-01-01', '2024-01-31')], self.SPOT)
        self.assertEqual([m['manad'] for m in data['manader']], ['2024-01'])
        bad = rec('2024-01-01', '2024-01-31')
        bad['start'] = None
        self.assertEqual(build_data([bad], self.SPOT)[1], 1)


if __name__ == '__main__':
    unittest.main()
