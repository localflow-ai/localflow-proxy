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

try:
    from stopwords import STOPWORDS as _STOPWORDS
except Exception:
    _STOPWORDS = frozenset()  # list unavailable → prose detection off (legacy behaviour)

_NOISE    = re.compile(r'Numéro de compte:|Nom du rapport:|^Page \d+ sur \d+$')
_COL_GAP  = 5.5  # pt — minimum inter-column gap for word-based mode
_ROW_YTOL = 3    # pt — max vertical distance to consider words on the same row
_ROW_MERGE_OVL = 2  # pt — min vertical box overlap to pull a wrapped-name fragment
                    # down onto the value row below it (see _merge_orphan_rows_down)
# A wrapped cell (e.g. a 2-line security name) is vertically centred next to its
# single-line value, so each of its lines is offset from the value by ~half a
# line and the top-only grouping above splits them into separate rows. Two such
# visual lines belong to the *same* logical row when their vertical extents
# overlap by at least this fraction of the shorter line's height: a centred name
# line overlaps the value line by ~0.4, while consecutive *distinct* table rows
# (which always have leading between them) never overlap — so merging on this
# signal reunites a name with its value without ever fusing real rows.
_ROW_OVERLAP_FRAC = 0.30

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

# --- Prose detection (so a justified paragraph can't define the column grid) ---
# The word-based path sizes the column grid from the row with the most gap-groups.
# A justified paragraph splits into one gap-group per word (its stretched spaces
# exceed the column-gap threshold), so it can out-"column" a real table and force
# the table onto a bogus grid. `_is_grid_prose` bars such a row from defining the
# grid. It requires BOTH signals, because neither alone is sufficient:
#
#   1. Every gap-group is a single word. This is the signature of *justification*:
#      it stretches every inter-word space past the column gap, so each word
#      splits into its own group. A real table row — even a stop-word-heavy
#      French header like «du capital | de liquidités» — keeps its multi-word
#      labels tight in one cell, so it has at least one multi-word group.
#   2. Stop-word density >= _PROSE_DENSITY — the share of tokens that are stop
#      words. This separates prose from a wide row of single-token numbers/codes
#      (also one-word-per-group, but ~zero stop words).
#
# Density alone fails on French statements: column headers («de liquidités»,
# «du capital», «de titres») measure ~0.38 — *denser* than the prose we want to
# drop (~0.29) — so no density threshold separates them. The single-word-groups
# test is what tells a justified paragraph from a stop-word-dense header.
#
# Density tokens strip surrounding punctuation ("les," -> "les") but keep the
# token whole otherwise (a code like "LU0823413074" stays one token, matching
# nothing). To tune for a new document run `python3 scripts/prose_density.py
# <pdf>`: it prints each contending row's groups, multi-word-group count and
# density with the resulting verdict. Stop-word lists live in stopwords.py.
_PROSE_DENSITY = 0.20
_DENSITY_EDGE = re.compile(r"^[^0-9a-zà-ÿœ']+|[^0-9a-zà-ÿœ']+$")


def _stopword_density(words) -> float:
    """Share (0..1) of a row's whitespace tokens that are stop words."""
    toks = [_DENSITY_EDGE.sub('', w['text'].lower()) for w in words]
    toks = [t for t in toks if t]
    if not toks:
        return 0.0
    return sum(1 for t in toks if t in _STOPWORDS) / len(toks)


def _is_grid_prose(groups) -> bool:
    """True if a row is justified running prose and so must not define the grid.

    `groups` is the row's gap-groups (each a list of word dicts). See the block
    comment above for why both signals — every group a single word, AND
    stop-word density >= _PROSE_DENSITY — are required.
    """
    if any(len(g) >= 2 for g in groups):
        return False
    return _stopword_density([w for g in groups for w in g]) >= _PROSE_DENSITY


def _normalize(text: str) -> str:
    """Final text clean-up applied to every page."""
    # Some PDFs encode spaces (incl. the thousands separator in numbers) as the
    # U+FFFF/U+FFFE noncharacter glyph; pdfplumber keeps it inside the word, so
    # "Hoche￿Patrimoine" / "2￿843￿528" come out glued. These code points are never
    # valid text — restore the intended space.
    text = text.replace('￿', ' ').replace('￾', ' ')
    # The euro sign is sometimes mis-encoded as the generic currency sign ¤
    # (U+00A4): a font draws € at the Latin-1 0xA4 slot but declares no ToUnicode
    # map, so extraction faithfully decodes it as ¤. In this euro-denominated
    # corpus ¤ always stands for €; restore it so the preview shows the real
    # symbol and money parsers don't choke on it.
    text = text.replace('¤', '€')
    return _PUNCT_FIX.sub(r'\1\2', text)


# ---------------------------------------------------------------------------
# Word-based helpers (fallback path)
# ---------------------------------------------------------------------------

def _merge_orphan_rows_down(grid):
    """Pull a wrapped-name fragment down onto the value row below it.

    A multi-line cell (a wrapped security name) is vertically centred next to the
    single-line value beside it, so the line-based grouping splits it into a
    name-only row above, a value row whose name cell is blank, and a name-only row
    below.  The blank-name value row is the form the LLM struggles with.  Merge
    the *above* fragment down onto the value row, strictly guarded so it only
    touches this case (the trailing fragment is left for the model to append):

      * one direction (down), into the row directly below;
      * a row moves only if EVERY non-empty cell vertically overlaps the next row
        (the "sticky" rule) — so a value row, whose just-merged name fragment no
        longer reaches the next line, is never dragged further down;
      * each cell moves only into an EMPTY cell below — stacked same-column text
        (wrapped titles, multi-line headers) is left untouched, and nothing is
        ever concatenated.

    `grid` is a list of rows; each row is a list of cells; each cell is a list of
    word dicts (kept so we can read their vertical extents).  Returns the merged
    grid.
    """
    def _ext(words):
        return (min(w['top'] for w in words), max(w['bottom'] for w in words))

    out = [list(r) for r in grid]
    i = 0
    while i < len(out) - 1:
        cur, nxt = out[i], out[i + 1]
        nxt_words = [w for c in nxt for w in c]
        nb = _ext(nxt_words) if nxt_words else None
        can_move = nb is not None and any(cur) and all(
            (not cell) or (
                not nxt[ci]  # target cell must be free — no overwrite, no concat
                and min(_ext(cell)[1], nb[1]) - max(_ext(cell)[0], nb[0]) >= _ROW_MERGE_OVL
            )
            for ci, cell in enumerate(cur)
        )
        if can_move:
            for ci, cell in enumerate(cur):
                if cell:
                    nxt[ci] = cell
            out.pop(i)  # cur merged into nxt; re-check the merged row (now at i)
        else:
            i += 1
    return out


def _group_rows(words):
    """Group words into logical rows, merging vertically-overlapping lines.

    Two passes:
      1. top-Y grouping (words within `_ROW_YTOL` of the row's first word), and
      2. merge consecutive rows whose vertical extents overlap by at least
         `_ROW_OVERLAP_FRAC` of the shorter row's height.

    Pass 2 is what reunites a wrapped cell (a security name on two lines, each
    offset ~half a line from the single-line value beside it) with its value:
    each name line overlaps the value line, so the three visual lines collapse
    into one logical row whose densest gap-grouping now *includes* the name —
    giving the name a real column instead of an orphaned blank-name row.

    Two guards keep it from fusing unrelated content:
      * the vertical overlap must reach `_ROW_OVERLAP_FRAC` of the shorter line
        — distinct table rows keep inter-row leading and never overlap; and
      * the rows' horizontal extents must overlap too — a wrapped cell sits
        *within* its row's column span, whereas a tall left-hand title and a
        small right-hand running header overlap vertically yet live in separate
        layout regions and must stay apart (else the header's "Numéro de
        compte:" text would fold into the title row and take it down with the
        _NOISE filter).

    Returns rows ordered top-down; word order within a row is not significant
    here (callers stringify cells in reading order).
    """
    sw = sorted(words, key=lambda w: w['top'])
    rows = [[sw[0]]]
    for w in sw[1:]:
        if w['top'] - rows[-1][0]['top'] <= _ROW_YTOL:
            rows[-1].append(w)
        else:
            rows.append([w])

    merged = [rows[0]]
    ptop = min(w['top'] for w in rows[0])
    pbot = max(w['bottom'] for w in rows[0])
    px0  = min(w['x0'] for w in rows[0])
    px1  = max(w['x1'] for w in rows[0])
    for r in rows[1:]:
        rtop = min(w['top'] for w in r)
        rbot = max(w['bottom'] for w in r)
        rx0  = min(w['x0'] for w in r)
        rx1  = max(w['x1'] for w in r)
        overlap = min(pbot, rbot) - max(ptop, rtop)
        shorter = min(pbot - ptop, rbot - rtop)
        x_overlap = max(px0, rx0) < min(px1, rx1)
        if shorter > 0 and overlap >= _ROW_OVERLAP_FRAC * shorter and x_overlap:
            merged[-1].extend(r)
            ptop, pbot = min(ptop, rtop), max(pbot, rbot)  # grow so a centred
            px0,  px1  = min(px0, rx0), max(px1, rx1)       # value bridges both
            #                                                halves of a name
        else:
            merged.append(r)
            ptop, pbot, px0, px1 = rtop, rbot, rx0, rx1
    return merged


def _read_order(words):
    """Words in human reading order: top-to-bottom by visual line, then left-to-right.

    A merged row (see `_group_rows`) can carry several visual lines, so a cell
    must be stringified by line first — otherwise a 2-line name sorted purely by
    x interleaves ("BNP EUROPE PARIBAS CLASSIC CONVERTIBLES"). Lines are clustered
    by top within `_ROW_YTOL` (not by rounding the coordinate, which would split a
    line at an integer boundary and promote a slightly-raised superscript — e.g.
    a "(2)" footnote marker — ahead of the word it annotates).
    """
    if not words:
        return words
    ws = sorted(words, key=lambda w: w['top'])
    keyed, line, ref = [], 0, ws[0]['top']
    for w in ws:
        if w['top'] - ref > _ROW_YTOL:
            line += 1
            ref = w['top']
        keyed.append((line, w['x0'], w))
    return [w for _, _, w in sorted(keyed, key=lambda t: (t[0], t[1]))]


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

    rows = _group_rows(words)

    if left_margin is None:
        all_x0 = [sorted(row, key=lambda w: w['x0'])[0]['x0'] for row in rows]
        left_margin = min(all_x0) if all_x0 else 0

    def _gap_groups(row):
        # Split at gaps measured against the running right edge of the group, not
        # the immediately preceding word: a merged row (see `_group_rows`) carries
        # several visual lines, so an x-sorted scan interleaves them, and a short
        # line-2 word (e.g. a wrapped "ISR" under "BNP") would otherwise leave a
        # false gap before the next line-1 word ("PARIBAS") and split one cell in
        # two. Tracking the max x1 keeps such an overlapping name in one group.
        row = sorted(row, key=lambda w: w['x0'])
        groups = [[row[0]]]
        cover = row[0]['x1']
        for w in row[1:]:
            if w['x0'] - cover >= _COL_GAP:
                groups.append([w])
                cover = w['x1']
            else:
                groups[-1].append(w)
                cover = max(cover, w['x1'])
        return groups

    # Derive column X-bounds from the row with the most gap-detected columns.
    # This ensures rows with fewer words (e.g. only 2-3 columns populated) are
    # still split at the same column boundaries as the header/densest row.
    col_bounds = None
    if derive_col_bounds:
        row_groups = [_gap_groups(r) for r in rows]
        # Size the grid from the densest row that is NOT justified prose — a
        # justified paragraph would otherwise set one column per word. Fall back
        # to every row if the whole region reads as prose.
        candidates = [rg for rg in row_groups if not _is_grid_prose(rg)]
        best_groups = max(candidates or row_groups, key=len, default=[])
        if len(best_groups) >= 3:
            col_bounds = []
            for i, g in enumerate(best_groups):
                gx0 = min(w['x0'] for w in g)
                gx1 = max(w['x1'] for w in g)
                left  = (max(w['x1'] for w in best_groups[i - 1]) + gx0) / 2 if i > 0 else 0
                right = (gx1 + min(w['x0'] for w in best_groups[i + 1])) / 2 if i < len(best_groups) - 1 else 1e6
                col_bounds.append((left, right))

    lines = []
    grid = []  # col_bounds path: rows of cells, each cell a list of word dicts
    for row in rows:
        row_sorted = sorted(row, key=lambda w: w['x0'])
        row_text = ' '.join(w['text'] for w in row_sorted)
        if _NOISE.search(row_text.strip()):
            continue

        if col_bounds:
            # Assign whole gap-groups — not individual words — to columns. A run of
            # words with sub-column spacing (e.g. the space-separated groups of a
            # number like "8 629 202,44") must land in a single cell even when the
            # grid derived from data rows would slice through it: a wide total sits
            # across two data-row columns, and per-word binning would split it.
            cells = [[] for _ in col_bounds]
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
                cells[assigned].extend(g)  # keep the words — the merge needs their y
            if any(cells):
                grid.append(cells)
        else:
            indent = row_sorted[0]['x0'] - left_margin
            depth  = 0 if indent < 10 else (1 if indent < 60 else 2)
            groups = _gap_groups(row_sorted)
            line = '  ' * depth + ' | '.join(
                ' '.join(w['text'] for w in _read_order(g)) for g in groups)
            if line.strip():
                lines.append(line)

    # Pull wrapped-name fragments down onto their value rows before stringifying,
    # so no blank-name value rows are left for the LLM to puzzle over.
    for cells in _merge_orphan_rows_down(grid):
        line = ' | '.join(' '.join(w['text'] for w in _read_order(c)) for c in cells)
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

    grid = []
    for row in rows:
        cells = [[] for _ in col_bounds]
        for w in sorted(row, key=lambda w: w['x0']):
            word_mid = (w['x0'] + w['x1']) / 2
            assigned = False
            for i, (cx0, cx1) in enumerate(col_bounds):
                if cx0 <= word_mid <= cx1:
                    cells[i].append(w)
                    assigned = True
                    break
            if not assigned:
                nearest = min(
                    range(len(col_bounds)),
                    key=lambda i: abs(word_mid - (col_bounds[i][0] + col_bounds[i][1]) / 2)
                )
                cells[nearest].append(w)
        if any(cells):
            grid.append(cells)

    # Same wrapped-cell reassembly as the word-based path: pull a row down onto
    # the one below when every non-empty cell overlaps it and lands in an empty
    # cell — so a borderless holdings table whose name wraps (value row left with
    # a blank name) gets the name back too.
    lines = []
    for cells in _merge_orphan_rows_down(grid):
        line = ' | '.join(' '.join(w['text'] for w in c) for c in cells)
        if line.strip():
            lines.append(line)

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
