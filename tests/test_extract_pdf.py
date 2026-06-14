"""
Regression tests for scripts/extract_pdf.py.

Run with:  python3 -m pytest tests/
"""

import io
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import extract_pdf  # noqa: E402

SAMPLES = os.path.join(os.path.dirname(__file__), '..', 'pdf-samples')

# All sample PDFs exercised by the suite. pdf-samples/ is git-ignored (the files
# are real, non-public statements), so a fresh checkout won't have them — tests
# skip rather than fail when a sample is missing.
SAMPLE_FILES = [
    'nouveau-releve-compte.pdf',
    'C92P006.pdf',
    'C92P007.pdf',
    'Investment_Management_Report_-Bankers-_20260504115703.pdf',
    'Investment_Management_Report_-Bankers-_20260428180919.pdf',
    'Javal Portfolio Review March 2026.pdf',
    'Synthèse EdR EJ - 2026.03.31.pdf',
]


def load(filename: str) -> bytes:
    path = os.path.join(SAMPLES, filename)
    if not os.path.exists(path):
        pytest.skip(f'sample not present: pdf-samples/{filename}')
    with open(path, 'rb') as f:
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


def test_invest_report_detail_holdings_complete(invest_report):
    """
    Regression: the 'Détail du portefeuille' table was detected as a 2-column
    currency+value strip, so holdings whose quantity/name sit in the left margin
    (outside the cells) were dropped — MSCI WORLD, S&P500, SPDR DIVIDEND, GOLD.
    The under-segmentation guard (words form many more columns than the ruling
    lines found → use word-based extraction) keeps them.
    """
    text = '\n'.join(p['text'] for p in invest_report['pages'])
    for name in ['MSCI WORLD', 'S&P500', 'STAT.STR.SPDR S&P DIVIDEND', 'SPDR GOLD TRUST']:
        assert name in text, f'detail holding dropped: {name}'


# ---------------------------------------------------------------------------
# Portfolio statement page 1  (C92P006.pdf)
#
# Regression: the column ruling lines on page 1 span only the header band, so
# find_tables detected just the title + column header (≈9% of the words) and
# the table path silently dropped every data row below it. The coverage guard
# (>25% of words below the last table → fall back to word-based extraction)
# must keep page 1's positions.
# ---------------------------------------------------------------------------

def test_portfolio_page1_not_empty(portfolio):
    """Page 1 used to come back as header-only — it must contain position rows."""
    text = page_text(portfolio, 1)
    isin_lines = [l for l in text.splitlines()
                  if re.match(r'[A-Z]{2}[A-Z0-9]{10} \|', l)]
    assert len(isin_lines) >= 15, f'page 1 dropped data rows: only {len(isin_lines)} found'


def test_portfolio_page1_known_rows(portfolio):
    text = page_text(portfolio, 1)
    assert ('US02079K3059 | ALPHABET CL.A | 1 800,00 UNT | 0,00 UNT | 250,946854 '
            '| 31/03/2026 | 21,61720550 | 451 704,34 | 5,23 | 412 793,37') in text
    assert ('US67066G1040 | NVIDIA | 3 295,00 UNT | 0,00 UNT | 152,194782 '
            '| 31/03/2026 | 12,63913800 | 501 481,81 | 5,81 | 459 835,85') in text


def test_portfolio_page1_total_number_not_split(portfolio):
    """
    Regression: the TOTAL row's grand total is a wide number that sits across two
    data-row columns. Per-word center-x binning sliced it into '8 629 | 202,44';
    assigning whole gap-groups to columns keeps it as one cell.
    """
    text = page_text(portfolio, 1)
    assert '8 629 202,44' in text
    assert '8 629 | 202,44' not in text


# ---------------------------------------------------------------------------
# Portfolio statement  (C92P007.pdf) — same layout family as C92P006
# ---------------------------------------------------------------------------

@pytest.fixture(scope='module')
def portfolio7():
    return extract_pdf.extract(load('C92P007.pdf'))


def test_portfolio7_page_count(portfolio7):
    assert portfolio7['metadata']['totalPdfPages'] == 3


def test_portfolio7_page1_has_positions(portfolio7):
    """Same page-1 coverage regression as C92P006."""
    text = page_text(portfolio7, 1)
    isin_lines = [l for l in text.splitlines()
                  if re.match(r'[A-Z]{2}[A-Z0-9]{10} \|', l)]
    assert len(isin_lines) >= 10, f'page 1 dropped data rows: only {len(isin_lines)} found'


def test_portfolio7_page1_alphabet(portfolio7):
    text = page_text(portfolio7, 1)
    assert ('US02079K3059 | ALPHABET CL.A | 700,00 UNT | 0,00 UNT | 250,946854 '
            '| 31/03/2026 | 21,62337140 | 175 662,80 | 5,20 | 160 526,44') in text


# ---------------------------------------------------------------------------
# Investment management report  (…_20260428180919.pdf) — sibling of the 0504 file
# ---------------------------------------------------------------------------

@pytest.fixture(scope='module')
def invest_report_0428():
    return extract_pdf.extract(
        load('Investment_Management_Report_-Bankers-_20260428180919.pdf')
    )


def test_invest_report_0428_page_count(invest_report_0428):
    assert invest_report_0428['metadata']['totalPdfPages'] == 16


def test_invest_report_0428_page5_quarterly_row(invest_report_0428):
    text = page_text(invest_report_0428, 5)
    assert "31.03.2026 | -0.53 | 6'515'490" in text


# ---------------------------------------------------------------------------
# Equity review  (Javal Portfolio Review March 2026.pdf)
# ---------------------------------------------------------------------------

@pytest.fixture(scope='module')
def javal_review():
    return extract_pdf.extract(load('Javal Portfolio Review March 2026.pdf'))


def test_javal_page_count(javal_review):
    assert javal_review['metadata']['totalPdfPages'] == 7


def test_javal_page2_top_holding(javal_review):
    text = page_text(javal_review, 2)
    assert 'ROLLS-ROYCE HOLDINGS' in text
    assert 'Industrials' in text
    assert '8.00' in text


# ---------------------------------------------------------------------------
# Insurance synthesis  (Synthèse EdR EJ - 2026.03.31.pdf)
# ---------------------------------------------------------------------------

@pytest.fixture(scope='module')
def edr_synthese():
    return extract_pdf.extract(load('Synthèse EdR EJ - 2026.03.31.pdf'))


def test_edr_page_count(edr_synthese):
    assert edr_synthese['metadata']['totalPdfPages'] == 9


def test_edr_page6_investments_section(edr_synthese):
    text = page_text(edr_synthese, 6)
    assert 'DÉTAILS DES INVESTISSEMENTS' in text


# ---------------------------------------------------------------------------
# Generic coverage guard — across every sample PDF
#
# This is the future-proof regression net for the page-1 bug class: any page
# that pdfplumber sees as text-dense must extract to a comparable amount of
# text. A dense page (>150 words) that collapses to a near-empty extraction is
# exactly the dropped-content failure mode, regardless of which PDF triggers it.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('filename', SAMPLE_FILES)
def test_dense_pages_not_dropped(filename):
    import pdfplumber
    data = load(filename)  # skips if the sample is absent
    result = extract_pdf.extract(data)
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            words = page.extract_words(x_tolerance=3, y_tolerance=3)
            if len(words) <= 150:
                continue  # sparse / cover page — not a coverage concern
            text = page_text(result, i)
            # A properly extracted page reproduces its words plus ' | ' separators,
            # so char count comfortably exceeds word count. The buggy header-only
            # extraction produced far less text than the page had words.
            assert len(text) >= len(words), (
                f'{filename} page {i}: {len(words)} words but only {len(text)} '
                f'chars extracted — content was dropped'
            )


# ---------------------------------------------------------------------------
# Baseline snapshot — the full extraction output of every sample is compared to
# a saved baseline, so ANY change to the extractor surfaces immediately and
# shows exactly where. Baselines live in tests/baselines/<sample>.txt and are
# git-ignored (private statements). After an INTENDED change, review the diff
# then re-bless with:  python3 tests/update_baselines.py
# Skips when a baseline (or the sample) is absent — CI / fresh checkout.
# ---------------------------------------------------------------------------

BASELINES = os.path.join(os.path.dirname(__file__), 'baselines')


def full_text(result: dict) -> str:
    return '\n'.join(f"## Page {p['pageNum']}\n{p['text']}" for p in result['pages'])


@pytest.mark.parametrize('filename', SAMPLE_FILES)
def test_extraction_matches_baseline(filename):
    baseline_path = os.path.join(BASELINES, filename + '.txt')
    if not os.path.exists(baseline_path):
        pytest.skip(f'no baseline for {filename} — run tests/update_baselines.py')
    with open(baseline_path, encoding='utf-8') as f:
        expected = f.read()
    actual = full_text(extract_pdf.extract(load(filename)))  # load() skips if sample absent
    if actual != expected:
        import difflib
        diff = '\n'.join(difflib.unified_diff(
            expected.splitlines(), actual.splitlines(),
            fromfile='baseline', tofile='current', lineterm='', n=1))
        pytest.fail(
            f'extraction changed for {filename} (review, then re-bless with '
            f'tests/update_baselines.py):\n{diff[:4000]}'
        )
