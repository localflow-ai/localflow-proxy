#!/usr/bin/env python3
"""Extract text from a Word document (.docx) received on stdin; emit JSON on stdout.

Mirrors extract_xlsx.py's output shape. Paragraphs and tables are emitted in
document order; table rows use the pipe-separated column convention formulas
parse with splitCols(). A .docx has no real pages (pagination is a rendering
artifact), so the whole document is one "page".

Requires python-docx (pip install python-docx).
"""
import io
import json
import re
import sys


def _clean(s):
    # One cell/paragraph stays one line: collapse whitespace, neutralize '|'.
    return re.sub(r'\s+', ' ', s.replace('|', ' ')).strip()


def _table_lines(table):
    lines = []
    for row in table.rows:
        cells = [_clean(cell.text) for cell in row.cells]
        # Merged cells repeat their value in every covered cell — collapse runs.
        deduped = [c for i, c in enumerate(cells) if i == 0 or c != cells[i - 1]]
        while deduped and deduped[-1] == '':
            deduped.pop()
        if deduped:
            lines.append(' | '.join(deduped))
    return lines


def extract(data: bytes) -> dict:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    doc = Document(io.BytesIO(data))
    lines = []
    # Iterate body children so paragraphs and tables keep their document order.
    body = doc.element.body
    for child in body.iterchildren():
        tag = child.tag.split('}')[-1]
        if tag == 'p':
            text = _clean(Paragraph(child, doc).text)
            if text:
                lines.append(text)
        elif tag == 'tbl':
            lines.extend(_table_lines(Table(child, doc)))
    return {
        'pages': [{'pageNum': 1, 'text': '\n'.join(lines)}],
        'metadata': {
            'totalPages': 1,
        },
    }


if __name__ == '__main__':
    data = sys.stdin.buffer.read()
    if not data:
        json.dump({'error': 'No data received on stdin'}, sys.stdout)
        sys.exit(1)
    try:
        result = extract(data)
    except ImportError:
        json.dump({'error': 'python-docx is not installed on the proxy — pip install python-docx'}, sys.stdout)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 — surface any parse failure as JSON
        json.dump({'error': f'docx extraction failed: {e}'}, sys.stdout)
        sys.exit(1)
    json.dump(result, sys.stdout, ensure_ascii=False)
