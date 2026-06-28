#!/usr/bin/env python3
# PDF text extraction using pdfplumber.
# Reads raw PDF bytes from stdin, writes JSON to stdout.
# JSON shape: { pages: [{pageNum, text}], metadata: {...} }
#
# Extraction strategy (tried in order per page):
#
#   1. Column-guided extraction (for tabular financial PDFs):
#      Uses visible ruling lines to identify column X-boundaries, then
#      assigns each word to its column by center-X position and groups
#      words into rows by Y-proximity (3pt tolerance).
#
#      Handles the common bank-statement layout where only vertical column
#      lines are drawn: pdfplumber's extract_table() merges all transaction
#      rows into a single blob because there are no horizontal row separators.
#      We detect blob rows (multiple dates in one cell) and re-extract those
#      rows using manual word-to-column assignment, while keeping pdfplumber's
#      clean cell data for non-blob rows (e.g. "solde précédent").
#
#   2. Word-based column detection (fallback for borderless pages):
#      Groups words into rows by Y (3pt tolerance), splits each row into
#      columns at gaps >= 5.5pt.  Rows are indented relative to the page's
#      left content margin:
#        depth 0 (no indent)  : within 10pt — section headers, titles
#        depth 1 (2 spaces)   : 10–60pt     — sub-categories
#        depth 2 (4 spaces)   : > 60pt      — individual data rows
#
#   3. Plain text fallback for scanned / image-only pages.
#
import sys
import json
import io
import re

try:
    import pdfplumber
except ImportError:
    json.dump({'error': 'pdfplumber not installed. Run: pip3 install pdfplumber'}, sys.stdout)
    sys.exit(1)

_NOISE    = re.compile(r'Numéro de compte:|Nom du rapport:|^Page \d+ sur \d+$')
_COL_GAP  = 5.5  # pt — minimum inter-column gap for word-based mode
_ROW_YTOL = 3    # pt — max vertical distance to consider words on the same row

# Word splitting. Many PDFs encode spaces as gaps (no space glyph), and the gap
# width scales with font size: a real space is ~0.25*fontsize, intra-word kerning
# is ~0. A fixed x_tolerance fails on tightly-set/justified text (a 9pt line has
# ~2.25pt spaces, below a 3pt tolerance, so words merge). x_tolerance_ratio makes
# the threshold font-relative (tol = ratio*fontsize per char pair), so spaces are
# detected regardless of font size. 0.15 sits safely between intra-word (~0.02)
# and inter-word (~0.25) ratios. Over-splitting is harmless: the column logic
# rejoins words within a cell with a single space (gaps < _COL_GAP).
_X_TOL_RATIO = 0.15
_WORD_KW  = {'x_tolerance': 3, 'y_tolerance': 3, 'x_tolerance_ratio': _X_TOL_RATIO}

# Font-relative word splitting occasionally splits a word from a trailing comma or
# full stop whose pre-glyph gap happens to reach space width. A space before ',' or
# '.' is never valid (French puts thin spaces before ; : ! ? « » — but never before
# a comma or period), so collapse it. Anchored on a preceding word char so it can't
# touch a lone '.'/'-' cell or the ' | ' column separators.
_PUNCT_FIX = re.compile(r'(\w) ([,.])')

# A "value" cell: a number with the usual financial decoration (thousands marks,
# decimals, %, currency, sign) and at least one digit, but no letters — so it
# matches "127,5022", "3 995,92", "6,31%", "1'117'653", "150.74" but not a name,
# an ISIN ("CH1335392721"), or a header word. Used to require that a column split
# is evidenced by real data rows, not multi-line headers or chart-axis labels.
_VALUE_RE = re.compile(r"^[\d.,'’\s%€$¤+\-]*\d[\d.,'’\s%€$¤+\-]*$")


def _normalize(text: str) -> str:
    """Final text clean-up applied to every page."""
    # Some PDFs encode spaces (incl. the thousands separator in numbers) as the
    # U+FFFF/U+FFFE noncharacter glyph; pdfplumber keeps it inside the word, so
    # "Hoche￿Patrimoine" / "2￿843￿528" come out glued. These code points are never
    # valid text — restore the intended space.
    text = text.replace('￿', ' ').replace('￾', ' ')
    return _PUNCT_FIX.sub(r'\1\2', text)


# ---------------------------------------------------------------------------
# Word-based helpers (fallback path)
# ---------------------------------------------------------------------------

def _refine_split_columns(row_groups, col_bounds):
    """Split a derived column that actually holds two x-separated stacks of content.

    The densest-row grid (see `_words_to_text`) only sees columns present on that
    one row, so it misses a column never populated on the same row as its
    neighbours — e.g. a narrow left *classification* column (Actions / Mixtes /
    Autres) whose label rows differ from the rows carrying the security name —
    and that column collapses into the adjacent one.  Detect and re-split it,
    tightly guarded so existing extractions stay byte-identical:

      * Only the *leftmost* column is considered (the observed shape: a row label
        swallowed by the name).
      * Geometry is read only from *tabular* rows (>= 3 populated columns), so
        prose/title/sub-header rows — which span the page width and would paper
        over the inter-column gap — don't corrupt it.
      * The split needs a clean vertical stripe between SPLIT_GAP_MIN and
        SPLIT_GAP_MAX wide (a moderate gap; a far wider void is a hanging indent,
        not a column) that no group crosses.
      * The two sides must be *vertically segregated* (never share a row — else
        they're one cell, e.g. the currency-prefixed value "USD -0.01"), each
        recur on >= 2 rows with real width, and each be evidenced by an actual
        data row (a numeric value), not just multi-line headers / chart labels.
    """
    SPLIT_GAP_MIN = 14.0   # pt — a real column separator, well above intra-cell gaps
    SPLIT_GAP_MAX = 40.0   # pt — but a far wider void is a hanging indent (e.g. a
                           # sub-total label vs an indented holding), not a column

    def _col_of(mid):
        for i, (cx0, cx1) in enumerate(col_bounds):
            if cx0 <= mid < cx1:
                return i
        return min(range(len(col_bounds)),
                   key=lambda i: abs(mid - (col_bounds[i][0] + col_bounds[i][1]) / 2))

    # Bucket gap-groups into columns, but only from rows that look tabular
    # (>= 3 distinct columns populated). Each entry is (gx0, gx1, row_index).
    # Also flag rows that carry a numeric value — a real column split must be
    # evidenced by data, not by multi-line headers or chart-axis labels.
    per_col = [[] for _ in col_bounds]
    data_rows = set()
    for ri, groups in enumerate(row_groups):
        bucketed = []
        for g in groups:
            gx0 = min(w['x0'] for w in g)
            gx1 = max(w['x1'] for w in g)
            text = ' '.join(w['text'] for w in g)
            if _VALUE_RE.match(text):
                data_rows.add(ri)
            bucketed.append((_col_of((gx0 + gx1) / 2), gx0, gx1))
        if len({ci for ci, _, _ in bucketed}) < 3:
            continue  # prose / header / total row — not column geometry
        for ci, gx0, gx1 in bucketed:
            per_col[ci].append((gx0, gx1, ri))

    refined = []
    for ci, ((cx0, cx1), groups) in enumerate(zip(col_bounds, per_col)):
        split_x = None
        # Only the leftmost column: the merged-label case is a narrow first
        # column (a classification / row-label) swallowed by the security name.
        # Restricting to column 0 matches that shape and keeps interior columns
        # (and the diverse tables that have them) untouched.
        if ci == 0 and len(groups) >= 3:
            groups.sort(key=lambda t: t[0])
            # Widest gap not crossed by any group (groups may overlap in x, so
            # track a running right edge rather than comparing only neighbours).
            cover_end = groups[0][1]
            best_gap, best_at = 0.0, None
            for gx0, gx1, _ in groups[1:]:
                if gx0 - cover_end > best_gap:
                    best_gap, best_at = gx0 - cover_end, (cover_end, gx0)
                cover_end = max(cover_end, gx1)
            if SPLIT_GAP_MIN <= best_gap <= SPLIT_GAP_MAX and best_at:
                stripe = (best_at[0] + best_at[1]) / 2
                left  = [(gx0, gx1, ri) for gx0, gx1, ri in groups if gx1 <= stripe]
                right = [(gx0, gx1, ri) for gx0, gx1, ri in groups if gx0 >= stripe]
                left_rows  = {ri for _, _, ri in left}
                right_rows = {ri for _, _, ri in right}
                MIN_BAND = 12.0  # pt — each side must be a real column, not a stray
                if (left and right
                        # vertical segregation: the two stacks never share a row
                        # (else they're one cell, e.g. a currency-prefixed value),
                        and not (left_rows & right_rows)
                        # each side must recur and have real width — rejects a
                        # one-off header word, a peeled page number, etc.
                        and len(left_rows) >= 2 and len(right_rows) >= 2
                        and max(b for _, b, _ in left)  - min(a for a, _, _ in left)  >= MIN_BAND
                        and max(b for _, b, _ in right) - min(a for a, _, _ in right) >= MIN_BAND
                        # evidenced by data on both sides — not a header/chart split
                        and (left_rows & data_rows) and (right_rows & data_rows)):
                    split_x = stripe
        if split_x is not None:
            refined.append((cx0, split_x))
            refined.append((split_x, cx1))
        else:
            refined.append((cx0, cx1))
    return refined


def _words_to_text(words, left_margin=None, derive_col_bounds=False) -> str:
    """Convert words to indented pipe-separated column text (word-based fallback).

    derive_col_bounds: when True, infer a shared column grid from the row with
    the most gap-detected groups and apply it to every row.  Only meaningful
    for full-page tabular content (Attempt 2 fallback).  Must be False for
    header/gap regions extracted from within a table-guided page, where the
    words are informational prose that should not be forced into a column grid.
    """
    if not words:
        return ''

    sorted_words = sorted(words, key=lambda w: w['top'])
    rows = [[sorted_words[0]]]
    for w in sorted_words[1:]:
        if w['top'] - rows[-1][0]['top'] <= _ROW_YTOL:
            rows[-1].append(w)
        else:
            rows.append([w])

    if left_margin is None:
        all_x0 = [sorted(row, key=lambda w: w['x0'])[0]['x0'] for row in rows]
        left_margin = min(all_x0) if all_x0 else 0

    def _gap_groups(row):
        row = sorted(row, key=lambda w: w['x0'])
        groups = [[row[0]]]
        for i in range(1, len(row)):
            if row[i]['x0'] - row[i - 1]['x1'] >= _COL_GAP:
                groups.append([row[i]])
            else:
                groups[-1].append(row[i])
        return groups

    # Derive column X-bounds from the row with the most gap-detected columns.
    # This ensures rows with fewer words (e.g. only 2-3 columns populated) are
    # still split at the same column boundaries as the header/densest row.
    col_bounds = None
    if derive_col_bounds:
        row_groups = [_gap_groups(r) for r in rows]
        best_groups = max(row_groups, key=len, default=[])
        if len(best_groups) >= 3:
            bounds = []
            for i, g in enumerate(best_groups):
                gx0 = min(w['x0'] for w in g)
                gx1 = max(w['x1'] for w in g)
                left  = (max(w['x1'] for w in best_groups[i - 1]) + gx0) / 2 if i > 0 else 0
                right = (gx1 + min(w['x0'] for w in best_groups[i + 1])) / 2 if i < len(best_groups) - 1 else 1e6
                bounds.append((left, right))
            # A column populated only on rows that never carry its neighbours
            # (e.g. a left classification label vs the security name) is invisible
            # to the single densest row above and collapses into the adjacent one;
            # split such under-segmented columns back apart.
            col_bounds = _refine_split_columns(row_groups, bounds)

    lines = []
    for row in rows:
        row_sorted = sorted(row, key=lambda w: w['x0'])
        row_text = ' '.join(w['text'] for w in row_sorted)
        if _NOISE.search(row_text.strip()):
            continue

        indent = row_sorted[0]['x0'] - left_margin
        depth  = 0 if indent < 10 else (1 if indent < 60 else 2)

        if col_bounds:
            # Assign whole gap-groups — not individual words — to columns. A run of
            # words with sub-column spacing (e.g. the space-separated groups of a
            # number like "8 629 202,44") must land in a single cell even when the
            # grid derived from data rows would slice through it: a wide total sits
            # across two data-row columns, and per-word binning would split it.
            cols_words = [[] for _ in col_bounds]
            for g in _gap_groups(row_sorted):
                gx0 = min(w['x0'] for w in g)
                gx1 = max(w['x1'] for w in g)
                mid = (gx0 + gx1) / 2
                assigned = None
                for i, (cx0, cx1) in enumerate(col_bounds):
                    if cx0 <= mid < cx1:
                        assigned = i
                        break
                if assigned is None:
                    assigned = min(range(len(col_bounds)),
                                   key=lambda i: abs(mid - (col_bounds[i][0] + col_bounds[i][1]) / 2))
                cols_words[assigned].append(' '.join(w['text'] for w in g))
            line = ' | '.join(' '.join(c) for c in cols_words)
        else:
            groups = _gap_groups(row_sorted)
            line = '  ' * depth + ' | '.join(' '.join(w['text'] for w in g) for g in groups)

        if line.strip():
            lines.append(line)

    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Column-guided extraction helpers (primary path)
# ---------------------------------------------------------------------------

def _col_bounds_from_table(table):
    """Return [(x_left, x_right), ...] using the row with the most non-None cells.

    Rows with spanning cells (e.g. "solde précédent" across 3 columns) have
    fewer non-None cell entries than the data rows, so we pick the most
    populated row to get accurate per-column boundaries.
    """
    try:
        best = max(table.rows, key=lambda r: sum(1 for c in r.cells if c is not None))
        cells = [c for c in best.cells if c is not None]
        if cells:
            return [(c[0], c[2]) for c in cells]
    except Exception:
        pass
    return None


def _is_blob_row(row_data):
    """True if pdfplumber merged many rows into one table row.

    Two layouts trigger this when only vertical column rules are drawn (no
    horizontal separators):
      - bank statements: a cell holds many transaction dates;
      - borderless holdings tables: several columns each hold many stacked
        text lines (e.g. all security names in one cell, all ISINs in the
        next, …).  Requiring >= 2 such columns avoids misfiring on a single
        wrapped header/label cell, whose line count also stays well below the
        threshold (a wrapped header is ~2-3 lines, a merged blob is dozens).
    """
    date_blob = any(
        cell and len(re.findall(r'\d{2}/\d{2}/\d{2}', cell)) > 2
        for cell in row_data
    )
    multiline_cols = sum(
        1 for cell in row_data if cell and len(cell.splitlines()) > 5
    )
    return date_blob or multiline_cols >= 2


def _words_to_cols(words, col_bounds) -> str:
    """Group words by Y into rows, assign each to a column by center-X.

    Words outside all column bounds are assigned to the nearest column.
    This is the core routine for PDFs where only vertical column lines are
    drawn: we get correct per-column assignment without horizontal row lines.
    """
    if not words:
        return ''

    sorted_words = sorted(words, key=lambda w: w['top'])
    rows = [[sorted_words[0]]]
    for w in sorted_words[1:]:
        if w['top'] - rows[-1][0]['top'] <= _ROW_YTOL:
            rows[-1].append(w)
        else:
            rows.append([w])

    lines = []
    for row in rows:
        cols = [[] for _ in col_bounds]
        for w in sorted(row, key=lambda w: w['x0']):
            word_mid = (w['x0'] + w['x1']) / 2
            assigned = False
            for i, (cx0, cx1) in enumerate(col_bounds):
                if cx0 <= word_mid <= cx1:
                    cols[i].append(w['text'])
                    assigned = True
                    break
            if not assigned:
                nearest = min(
                    range(len(col_bounds)),
                    key=lambda i: abs(word_mid - (col_bounds[i][0] + col_bounds[i][1]) / 2)
                )
                cols[nearest].append(w['text'])

        col_texts = [' '.join(c) for c in cols]
        if any(col_texts):
            lines.append(' | '.join(col_texts))

    return '\n'.join(ln for ln in lines if ln.strip())


def _extract_table(page, tbl, page_words_cache) -> list:
    """Extract one table's rows as pipe-separated strings.

    Non-blob rows (e.g. "solde précédent" spanning row) use pdfplumber's
    clean cell data directly.  Blob rows (all transactions merged into one
    because there are no horizontal separators) are re-extracted via
    _words_to_cols using the column bounds from the blob row itself.
    """
    tbl_data = tbl.extract()
    if not tbl_data or len(tbl_data[0]) < 3:
        return []

    col_bounds = _col_bounds_from_table(tbl)
    lines = []

    for row_data, tbl_row in zip(tbl_data, tbl.rows):
        if _is_blob_row(row_data) and col_bounds:
            # Re-extract this row's Y range word-by-word into columns
            non_none = [c for c in tbl_row.cells if c is not None]
            if non_none:
                y0 = min(c[1] for c in non_none)
                y1 = max(c[3] for c in non_none)
                if page_words_cache[0] is None:
                    page_words_cache[0] = page.extract_words(**_WORD_KW)
                row_words = [w for w in page_words_cache[0]
                             if y0 <= w['top'] <= y1]
                row_text = _words_to_cols(row_words, col_bounds)
                if row_text:
                    lines.append(row_text)
        else:
            # pdfplumber extracted this row cleanly — use its cell text directly
            cols = [' '.join((cell or '').split()) for cell in row_data]
            if any(c for c in cols):
                lines.append(' | '.join(cols))

    return lines


# ---------------------------------------------------------------------------
# Per-page extraction
# ---------------------------------------------------------------------------

def _table_max_cols(tbl) -> int:
    """Return the max non-None cell count across all rows in a table."""
    try:
        rows = tbl.extract()
        if not rows:
            return 0
        return max(sum(1 for c in r if c is not None) for r in rows)
    except Exception:
        return 0


def _word_col_count(words) -> int:
    """How many columns the raw word layout suggests, independent of ruling lines:
    the max number of gap-separated groups in any single word-row. Used to detect
    when a detected table under-segments the content (few ruling columns vs many
    word columns)."""
    if not words:
        return 0
    sorted_words = sorted(words, key=lambda w: w['top'])
    rows = [[sorted_words[0]]]
    for w in sorted_words[1:]:
        if w['top'] - rows[-1][0]['top'] <= _ROW_YTOL:
            rows[-1].append(w)
        else:
            rows.append([w])

    def _ncols(row):
        row = sorted(row, key=lambda w: w['x0'])
        n = 1
        for i in range(1, len(row)):
            if row[i]['x0'] - row[i - 1]['x1'] >= _COL_GAP:
                n += 1
        return n

    return max((_ncols(r) for r in rows), default=0)


def _extract_page(page) -> str:
    # --- Attempt 1: column-guided extraction using table line detection -----
    strategies = [
        {"vertical_strategy": "lines_strict", "horizontal_strategy": "lines_strict"},
        {"vertical_strategy": "lines",        "horizontal_strategy": "lines"},
    ]

    # Pick the strategy that yields the most columns in its densest table.
    # "lines" finds wider column sets for some PDFs; "lines_strict" is more
    # accurate for others (e.g. bank statements with thin separators).
    best_strategy = None
    best_found = None
    best_cols = 0
    for strategy in strategies:
        found = page.find_tables(strategy)
        if not found:
            continue
        cols = max(_table_max_cols(t) for t in found)
        if cols > best_cols:
            best_cols = cols
            best_found = found
            best_strategy = strategy

    # Coverage guards: discard table detection and fall through to the word-based
    # path (which reads the whole page) when the detected tables would drop content.
    if best_found:
        guard_words = page.extract_words(**_WORD_KW)
        # (a) A large share of words fall BELOW the last detected table — ruling
        #     lines only around a header band, data rows underneath get dropped.
        last_bottom = max(t.bbox[3] for t in best_found)
        below = sum(1 for w in guard_words if w['top'] > last_bottom)
        drop_below = bool(guard_words) and below / len(guard_words) > 0.25
        # (b) The words form many more columns than the ruling lines found — the
        #     table UNDER-SEGMENTS the content (e.g. a holdings table detected as a
        #     2-column currency+value strip, with names/quantities sitting outside
        #     the cells and getting lost). Word-based extraction reads them all.
        under_segmented = _word_col_count(guard_words) >= best_cols + 3
        if drop_below or under_segmented:
            best_found = None

    if best_found:
        found = best_found

        lines = []
        page_words_cache = [None]  # lazy-loaded once, shared across tables

        # Process tables in top-to-bottom order, capturing inter-table gaps
        sorted_found = sorted(found, key=lambda t: t.bbox[1])

        # Header text above the first table (account info, period, etc.)
        first_table_top = sorted_found[0].bbox[1]
        if first_table_top > 5:
            hdr_words = page.crop((0, 0, page.width, first_table_top)) \
                            .extract_words(**_WORD_KW)
            hdr = _words_to_text(hdr_words)
            if hdr:
                lines.append(hdr)

        for j, tbl in enumerate(sorted_found):
            # Gap text between previous table and this one (e.g. "nouveau solde")
            if j > 0:
                gap_y0 = sorted_found[j - 1].bbox[3]
                gap_y1 = tbl.bbox[1]
                if gap_y1 - gap_y0 > 5:
                    if page_words_cache[0] is None:
                        page_words_cache[0] = page.extract_words(**_WORD_KW)
                    gap_words = [w for w in page_words_cache[0]
                                 if gap_y0 < w['top'] < gap_y1]
                    gap_text = _words_to_text(gap_words)
                    if gap_text:
                        lines.append(gap_text)

            lines.extend(_extract_table(page, tbl, page_words_cache))

        result = '\n'.join(ln for ln in lines if ln.strip())
        if result:
            return result

    # --- Attempt 2: word-based column detection (borderless pages) ----------
    words = page.extract_words(**_WORD_KW)
    if words:
        return _words_to_text(words, derive_col_bounds=True)

    # --- Attempt 3: plain text (scanned / image-only pages) ----------------
    text = page.extract_text(**_WORD_KW) or ''
    return '\n'.join(l.rstrip() for l in text.splitlines() if l.strip())


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def extract(data: bytes) -> dict:
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        pages = []
        for i, page in enumerate(pdf.pages, 1):
            pages.append({'pageNum': i, 'text': _normalize(_extract_page(page))})

        meta = pdf.metadata or {}
        def m(key): return meta.get(key) or meta.get('/' + key) or None

        return {
            'pages': pages,
            'metadata': {
                'title':            m('Title')        or 'Unknown',
                'author':           m('Author')       or 'Unknown',
                'creator':          m('Creator')      or 'Unknown',
                'producer':         m('Producer')     or 'Unknown',
                'creationDate':     m('CreationDate'),
                'modificationDate': m('ModDate'),
                'totalPdfPages':    len(pdf.pages),
            }
        }


if __name__ == '__main__':
    data = sys.stdin.buffer.read()
    if not data:
        json.dump({'error': 'No data received on stdin'}, sys.stdout)
        sys.exit(1)
    result = extract(data)
    json.dump(result, sys.stdout, ensure_ascii=False)
