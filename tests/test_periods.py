import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from finalize import check_period_continuity  # noqa: E402
from summarize import ALL, LAST_12, summarize, window_start  # noqa: E402


def row(start, end, bolag='Vattenfall', nr='', typ='Elhandel', anl='Byggnad A'):
    return {'Anläggning': anl, 'Typ': typ, 'Bolag': bolag, 'Fakturanummer': nr,
            'Period start': start, 'Period slut': end, 'Granska': ''}


class PeriodContinuity(unittest.TestCase):
    def test_contiguous_months_across_supplier_switch_are_ok(self):
        rows = [row('2024-01-01', '2024-01-31', 'Fortum', '1'), row('2024-02-01', '2024-02-29', 'Vattenfall', '2')]
        self.assertEqual(check_period_continuity(rows), [])

    def test_gap_is_flagged_on_following_invoice(self):
        rows = [row('2024-01-01', '2024-01-31', nr='1'), row('2024-03-01', '2024-03-31', nr='2')]
        issues = check_period_continuity(rows)
        self.assertEqual(len(issues), 1)
        self.assertIn('lucka: 29 dagar', issues[0][3])
        self.assertIn('lucka', rows[1]['Granska'])
        self.assertEqual(rows[0]['Granska'], '')

    def test_gaps_before_the_checked_range_are_ignored(self):
        rows = [row('2021-01-01', '2021-01-31', nr='1'), row('2023-03-01', '2023-03-31', nr='2')]
        self.assertEqual(check_period_continuity(rows), [])
        rows = [row('2022-12-01', '2022-12-31', nr='1'), row('2023-03-01', '2023-03-31', nr='2')]
        self.assertEqual(check_period_continuity(rows), [])          # föregående period slutar före 2023
        rows = [row('2023-01-01', '2023-01-31', nr='1'), row('2023-03-01', '2023-03-31', nr='2')]
        self.assertEqual(len(check_period_continuity(rows)), 1)      # luckan ligger inom kontrollerat intervall

    def test_overlap_is_flagged(self):
        rows = [row('2024-01-01', '2024-01-31', nr='1'), row('2024-01-15', '2024-02-15', nr='2')]
        self.assertIn('överlappar', check_period_continuity(rows)[0][3])

    def test_same_invoice_twice_is_not_reported_as_overlap(self):
        rows = [row('2024-01-01', '2024-01-31', nr='1'), row('2024-01-01', '2024-01-31', nr='1')]
        self.assertEqual(check_period_continuity(rows), [])

    def test_elnat_and_elhandel_are_checked_separately(self):
        rows = [row('2024-01-01', '2024-01-31', 'Ellevio', '1', typ='Elnät'),
                row('2024-01-01', '2024-01-31', 'Vattenfall', '2')]
        self.assertEqual(check_period_continuity(rows), [])

    def test_rows_without_period_are_ignored(self):
        self.assertEqual(check_period_continuity([row('', '', nr='1'), row('2024-01-01', '2024-01-31', nr='2')]), [])


def rec(start, end, kwh=1000.0, exkl=1000.0, anl='A', bolag='B'):
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    return {'anl': anl, 'bolag': bolag, 'year': start[:4], 'start': s, 'end': e, 'kwh': kwh,
            'exkl': exkl, 'inkl': exkl * 1.25, 'rorligt': exkl, 'ordinarie': exkl}


class Summarize(unittest.TestCase):
    def test_window_start_is_first_of_month_eleven_months_back(self):
        self.assertEqual(window_start(date(2024, 12, 31)), date(2024, 1, 1))
        self.assertEqual(window_start(date(2025, 2, 28)), date(2024, 3, 1))

    def test_price_is_weighted_by_kwh_not_averaged(self):
        out = summarize([rec('2024-01-01', '2024-01-31', kwh=1000, exkl=1000),   # 100 öre/kWh
                         rec('2024-02-01', '2024-02-29', kwh=100, exkl=200)])    # 200 öre/kWh
        year = next(o for o in out if o['Anläggning'] == 'A' and o['Period'] == '2024')
        self.assertEqual(year['Pris exkl. moms (öre/kWh)'], round(1200 / 1100 * 100, 2))
        self.assertEqual(year['Pris inkl. moms (öre/kWh)'], round(1500 / 1100 * 100, 2))

    def test_last_12_months_ends_at_suppliers_last_period(self):
        recs = [rec(f'2023-{m:02d}-01', f'2023-{m:02d}-28') for m in range(1, 13)]
        recs.append(rec('2024-01-01', '2024-01-31'))
        last = next(o for o in summarize(recs) if o['Anläggning'] == 'A' and o['Period'] == LAST_12)
        self.assertEqual(last['Antal fakturor'], 12)  # jan 2023 faller utanför
        self.assertEqual(str(last['Från']), '2023-02-01')
        self.assertEqual(str(last['Till']), '2024-01-31')

    def test_incomplete_coverage_is_visible_in_days(self):
        recs = [rec('2024-01-01', '2024-01-31'), rec('2024-03-01', '2024-03-31')]
        last = next(o for o in summarize(recs) if o['Anläggning'] == 'A' and o['Period'] == LAST_12)
        self.assertEqual(last['Dagar täckta'], 62)

    def test_all_facilities_row_is_included(self):
        out = summarize([rec('2024-01-01', '2024-01-31', anl='A'), rec('2024-01-01', '2024-01-31', anl='B')])
        total = next(o for o in out if o['Anläggning'] == ALL and o['Period'] == '2024')
        self.assertEqual(total['Förbrukning (kWh)'], 2000)


if __name__ == '__main__':
    unittest.main()
