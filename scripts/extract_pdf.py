#!/usr/bin/env python3
# PDF text extraction using pdfplumber word-level column detection.
# Reads raw PDF bytes from stdin, writes JSON to stdout.
# JSON shape: { pages: [{pageNum, text}], metadata: {...} }
#
# Output format per line:
#   - Columns separated by " | " (space-pipe-space)
#   - Rows are indented proportionally to their x-distance from the page's left margin:
#       depth 0 (no indent)  : within 10pt of the left margin — section headers, titles
#       depth 1 (2 spaces)   : 10–60pt from the left margin — sub-categories
#       depth 2 (4 spaces)   : > 60pt from the left margin — individual data rows
#
# Column gap threshold: 5.5pt (fixed).
#   Within-word gaps in typical financial/business PDFs are 1–5pt; cross-column
#   gaps are 6pt or more. 5.5pt sits cleanly between these two ranges for fonts
#   from 7pt to ~12pt. For larger fonts (>14pt) some within-description words may
#   be incorrectly split into separate columns, but the semantic content is preserved
#   and any LLM can reconstruct the intent. Scanned / image-only pages fall back
#   to pdfplumber's layout=True text output.
import sys
import json
import io
import re
from collections import defaultdict

try:
    import pdfplumber
except ImportError:
    json.dump({'error': 'pdfplumber not installed. Run: pip3 install pdfplumber'}, sys.stdout)
    sys.exit(1)

_NOISE = re.compile(r'Numéro de compte:|Nom du rapport:|^Page \d+ sur \d+$')

_COL_GAP = 5.5   # pt — see module docstring


def _extract_page(page) -> str:
    words = page.extract_words(x_tolerance=3, y_tolerance=3)

    # Fallback for scanned / image-only pages.
    # layout=True requires pdfplumber >= 0.7; use plain extract_text() for compatibility.
    if not words:
        text = page.extract_text() or ''
        return '\n'.join(l.rstrip() for l in text.splitlines() if l.strip())

    # Group words into rows by y-position
    rows_dict: dict = defaultdict(list)
    for w in words:
        rows_dict[round(w['top'])].append(w)

    # Left content margin — used for relative depth, so thresholds are
    # meaningful regardless of page size or document margins.
    all_x0 = [
        sorted(rw, key=lambda w: w['x0'])[0]['x0']
        for rw in rows_dict.values() if rw
    ]
    left_margin = min(all_x0) if all_x0 else 0

    lines = []
    for y in sorted(rows_dict.keys()):
        row = sorted(rows_dict[y], key=lambda w: w['x0'])
        row_text = ' '.join(w['text'] for w in row)

        if _NOISE.search(row_text.strip()):
            continue

        indent = row[0]['x0'] - left_margin
        depth = 0 if indent < 10 else (1 if indent < 60 else 2)

        groups: list = [[row[0]['text']]]
        for i in range(1, len(row)):
            if row[i]['x0'] - row[i - 1]['x1'] >= _COL_GAP:
                groups.append([row[i]['text']])
            else:
                groups[-1].append(row[i]['text'])

        lines.append('  ' * depth + ' | '.join(' '.join(g) for g in groups))

    return '\n'.join(ln for ln in lines if ln.strip())


def extract(data: bytes) -> dict:
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        pages = []
        for i, page in enumerate(pdf.pages, 1):
            pages.append({'pageNum': i, 'text': _extract_page(page)})

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
