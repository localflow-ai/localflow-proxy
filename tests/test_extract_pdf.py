"""
Regression tests for scripts/extract_pdf.py.

Run with:  python3 -m pytest tests/
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import extract_pdf  # noqa: E402

SAMPLES = os.path.join(os.path.dirname(__file__), '..', 'pdf-samples')


def load(filename: str) -> bytes:
    with open(os.path.join(SAMPLES, filename), 'rb') as f:
        return f.read()


def page_text(result: dict, page_num: int) -> str:
    for p in result['pages']:
        if p['pageNum'] == page_num:
            return p['text']
    raise KeyError(f'page {page_num} not found')


# ---------------------------------------------------------------------------
# Bank statement  (nouveau-releve-compte.pdf)
# ---------------------------------------------------------------------------

@pytest.fixture(scope='module')
def bank_stmt():
    return extract_pdf.extract(load('nouveau-releve-compte.pdf'))


def test_bank_stmt_page_count(bank_stmt):
    assert bank_stmt['metadata']['totalPdfPages'] == 6


def test_bank_stmt_page1_header(bank_stmt):
    text = page_text(bank_stmt, 1)
    assert 'Date | Valeur | Nature de l’opération | Débit | Crédit' in text


def test_bank_stmt_page1_opening_balance(bank_stmt):
    text = page_text(bank_stmt, 1)
    assert 'solde pRécédent' in text
    assert '2 543,19' in text


def test_bank_stmt_page1_transactions(bank_stmt):
    text = page_text(bank_stmt, 1)
    assert '10/06/10 | 10/06/10 | VIR RECU 7141686480 |  | 109,43' in text
    assert '10/06/10 | 10/06/10 | CARTE X3403 0906 CARREFOURMARKET | 30,65' in text


def test_bank_stmt_page3_transactions(bank_stmt):
    text = page_text(bank_stmt, 3)
    assert '14/06/10 | 14/06/10 | CARTE X3403 12/06 CREP PIERRE DORE | 36,40' in text
    assert '29/06/10 | 29/06/10 | VIR RECU 9049406507 |  | 1 595,49' in text


def test_bank_stmt_page5_columns_not_merged(bank_stmt):
    """
    Regression: page 5 previously merged the Valeur date with the Nature
    description because the gap between those two columns was < 5.5 pt and
    the 'lines' strategy detected only 4 columns instead of 5.

    After the fix (prefer the strategy with the most columns, derive col
    bounds from the densest header row), each transaction must appear as
    five pipe-separated fields.
    """
    text = page_text(bank_stmt, 5)
    assert '07/07/10 | 07/07/10 | CARTE X3403 06/07 CAMILLE ALBANE | 24,00' in text
    assert '07/07/10 | 07/07/10 | CHEQUE 461 | 30,00' in text
    assert '09/07/10 | 09/07/10 | CHEQUE 467 | 32,96' in text


def test_bank_stmt_page5_valeur_nature_not_merged(bank_stmt):
    """Guard: the old merged form must never reappear."""
    text = page_text(bank_stmt, 5)
    assert '07/07/10 CARTE X3403' not in text
    assert '07/07/10 CHEQUE 461' not in text


def test_bank_stmt_page1_section_title_no_spurious_pipes(bank_stmt):
    """
    Regression: col_bounds derived from the densest row in the header area
    were applied to all header rows, scattering section titles across empty
    columns — e.g. 'Relevé | des opéRations |  | …'.  After the fix
    (derive_col_bounds=False for header/gap regions) the title must appear
    as a continuous string, matchable without pipe escaping.
    """
    text = page_text(bank_stmt, 1)
    assert 'Relevé des opéRations' in text
    assert 'Relevé | des opéRations' not in text


# ---------------------------------------------------------------------------
# Portfolio statement  (C92P006.pdf)
# ---------------------------------------------------------------------------

@pytest.fixture(scope='module')
def portfolio():
    return extract_pdf.extract(load('C92P006.pdf'))


def test_portfolio_page_count(portfolio):
    assert portfolio['metadata']['totalPdfPages'] == 2


def test_portfolio_page2_column_header(portfolio):
    text = page_text(portfolio, 2)
    assert 'Code Valeur | Libellé | Quantité' in text


def test_portfolio_page2_ten_column_rows(portfolio):
    """
    Regression: switching strategy order once collapsed page 2 from 10
    columns to 1.  Every ISIN row must have exactly 9 pipes (= 10 columns).
    """
    text = page_text(portfolio, 2)
    isin_lines = [l for l in text.splitlines()
                  if re.match(r'[A-Z]{2}[A-Z0-9]{10} \|', l)]
    assert len(isin_lines) >= 10, 'expected at least 10 position rows'
    for line in isin_lines:
        assert line.count('|') == 9, f'wrong column count in: {line!r}'


def test_portfolio_page2_ferrari(portfolio):
    text = page_text(portfolio, 2)
    assert ('NL0011585146 | FERRARI | 490,00 UNT | 0,00 UNT | 289,00 '
            '| 31/03/2026 | 212,76295910 | 141 610,00 | 1,64 | 37 356,15') in text


def test_portfolio_page2_hermes(portfolio):
    text = page_text(portfolio, 2)
    assert ('FR0000052292 | HERMES INTL | 120,00 UNT | 0,00 UNT | 1 609,00 '
            '| 31/03/2026 | 1 238,90341660 | 193 080,00 | 2,24 | 44 411,59') in text


# ---------------------------------------------------------------------------
# Investment management report  (Investment_Management_Report_-Bankers-…pdf)
# ---------------------------------------------------------------------------

@pytest.fixture(scope='module')
def invest_report():
    return extract_pdf.extract(
        load('Investment_Management_Report_-Bankers-_20260504115703.pdf')
    )


def test_invest_report_page_count(invest_report):
    assert invest_report['metadata']['totalPdfPages'] == 19


def test_invest_report_page5_performance_table(invest_report):
    text = page_text(invest_report, 5)
    assert 'Description' in text
    assert 'Total | 3.50' in text


def test_invest_report_page7_quarterly_rows(invest_report):
    text = page_text(invest_report, 7)
    assert "30.04.2026 | 3.65 | 6'751'498" in text
    assert "31.03.2026 | -0.14 | 6'515'490" in text
    assert "31.12.2025 | 0.51 | 5'426'955" in text
