import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from granska import rows_to_review  # noqa: E402


def row(period, granska, fakturadatum=''):
    return {'Period start': period, 'Fakturadatum': fakturadatum, 'Granska': granska}


class Review(unittest.TestCase):
    def test_only_flagged_rows_from_the_given_month(self):
        rows = [row('2022-12-01', 'gammal'), row('2023-01-01', 'ny'), row('2024-05-01', ''), row('2026-09-01', 'senaste')]
        self.assertEqual([r['Granska'] for r in rows_to_review(rows, '2023-01')], ['ny', 'senaste'])

    def test_invoice_date_is_used_when_period_is_missing(self):
        self.assertEqual(len(rows_to_review([row('', 'saknar period', fakturadatum='2024-02-03')], '2023-01')), 1)
        self.assertEqual(len(rows_to_review([row('', 'saknar period', fakturadatum='2021-02-03')], '2023-01')), 0)

    def test_everything_since_an_earlier_month(self):
        self.assertEqual(len(rows_to_review([row('2021-03-01', 'a'), row('2022-03-01', 'b')], '2020-01')), 2)


if __name__ == '__main__':
    unittest.main()
