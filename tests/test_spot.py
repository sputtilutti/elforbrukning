import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from common import load_spot  # noqa: E402
from finalize import SPOT_COLS, spot_columns, spot_for_period  # noqa: E402
from summarize import SPOT_COL, summarize  # noqa: E402

SPOT = {'2024-01': 80.0, '2024-02': 50.0, '2024-03': 60.0}


class SpotForPeriod(unittest.TestCase):
    def test_single_month(self):
        self.assertEqual(spot_for_period(date(2024, 1, 1), date(2024, 1, 31), SPOT), (80.0, []))

    def test_multi_month_is_weighted_by_days(self):
        # 31 dagar januari (80) + 29 dagar februari (50): (31*80 + 29*50) / 60
        value, missing = spot_for_period(date(2024, 1, 1), date(2024, 2, 29), SPOT)
        self.assertEqual(value, round((31 * 80 + 29 * 50) / 60, 2))
        self.assertEqual(missing, [])

    def test_missing_month_gives_none(self):
        self.assertEqual(spot_for_period(date(2024, 3, 1), date(2024, 4, 30), SPOT), (None, ['2024-04']))

    def test_period_across_year_end(self):
        spot = {'2023-12': 70.0, '2024-01': 90.0}
        value, _ = spot_for_period(date(2023, 12, 16), date(2024, 1, 15), spot)
        self.assertEqual(value, round((16 * 70 + 15 * 90) / 31, 2))


class SpotColumns(unittest.TestCase):
    COSTS = {'Pris exkl. moms (öre/kWh)': 96.45, 'Ordinarie pris exkl. moms (öre/kWh)': 100.45}

    def test_difference_to_spot(self):
        cols, notes = spot_columns(self.COSTS, '2024-01-01', '2024-01-31', SPOT)
        self.assertEqual(notes, [])
        self.assertEqual(cols[SPOT_COLS[0]], 80.0)
        self.assertEqual(cols[SPOT_COLS[1]], 16.45)
        self.assertEqual(cols[SPOT_COLS[2]], 20.45)

    def test_before_spot_data_is_blank_without_note(self):
        cols, notes = spot_columns(self.COSTS, '2021-01-01', '2021-01-31', SPOT)
        self.assertEqual((set(cols.values()), notes), ({''}, []))

    def test_missing_month_after_start_of_data_is_flagged(self):
        cols, notes = spot_columns(self.COSTS, '2024-04-01', '2024-04-30', SPOT)
        self.assertEqual(set(cols.values()), {''})
        self.assertEqual(notes, ['saknar spotpris för 2024-04'])

    def test_rows_without_cost_breakdown_are_skipped(self):
        empty = {k: '' for k in self.COSTS}
        self.assertEqual(spot_columns(empty, '2024-01-01', '2024-01-31', SPOT), ({c: '' for c in SPOT_COLS}, []))


def rec(start, end, kwh, exkl, spot):
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    return {'anl': 'A', 'bolag': 'B', 'year': start[:4], 'start': s, 'end': e, 'kwh': kwh, 'exkl': exkl,
            'inkl': exkl * 1.25, 'rorligt': exkl, 'ordinarie': exkl,
            'spot_sek': None if spot is None else spot * kwh / 100}


class SummarizeSpot(unittest.TestCase):
    def test_spot_is_weighted_by_kwh_and_difference_computed(self):
        out = summarize([rec('2024-01-01', '2024-01-31', 1000, 1000, 80.0),   # 100 öre, spot 80
                         rec('2024-02-01', '2024-02-29', 3000, 2400, 50.0)])  # 80 öre, spot 50
        year = next(o for o in out if o['Anläggning'] == 'A' and o['Period'] == '2024')
        self.assertEqual(year[SPOT_COL], 57.5)                          # (800 + 1500) / 4000
        self.assertEqual(year['Pris exkl. moms (öre/kWh)'], 85.0)       # 3400 / 4000
        self.assertEqual(year['Skillnad mot spot exkl. moms (öre/kWh)'], 27.5)

    def test_group_with_missing_spot_is_blank(self):
        out = summarize([rec('2024-01-01', '2024-01-31', 1000, 1000, 80.0),
                         rec('2024-02-01', '2024-02-29', 1000, 1000, None)])
        year = next(o for o in out if o['Anläggning'] == 'A' and o['Period'] == '2024')
        self.assertEqual((year[SPOT_COL], year['Skillnad mot spot exkl. moms (öre/kWh)']), ('', ''))


class LoadSpot(unittest.TestCase):
    def test_project_csv_has_expected_months(self):
        spot = load_spot()
        self.assertEqual(spot['2023-01'], 92.6)
        self.assertEqual(spot['2026-01'], 108.4)
        self.assertGreaterEqual(len(spot), 45)


if __name__ == '__main__':
    unittest.main()
