#!/usr/bin/env python3
"""Inspect stop-word density per row, to set / tune ``extract_pdf._PROSE_DENSITY``.

Usage:
    python3 scripts/prose_density.py <pdf> [page]

For each page, prints the rows with the most gap-groups — the ones that compete
to define the column grid in the word-based extraction path — with their
gap-group count, multi-word-group count, stop-word density, and the resulting
``_is_grid_prose`` verdict (PROSE = barred from defining the grid).

A row is judged prose only when BOTH `multiword == 0` (every gap-group is a
single word — the justification signature) and `density >= _PROSE_DENSITY`. To
vet a new document, run this and confirm: its justified paragraphs show
`multiword 0` + a high density (PROSE), while its real table rows/headers show
either `multiword >= 1` or a low density (`--`). Note French headers («de
liquidités») are stop-word-dense too — it's the multi-word group that keeps
them out of PROSE, not a density threshold. Tune `_PROSE_DENSITY` only to slot
between a document's numeric rows (~0) and its prose (~0.3).
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pdfplumber  # noqa: E402
import extract_pdf as E  # noqa: E402


def _gap_groups(row):
    row = sorted(row, key=lambda w: w['x0'])
    groups = [[row[0]]]
    for i in range(1, len(row)):
        if row[i]['x0'] - row[i - 1]['x1'] >= E._COL_GAP:
            groups.append([row[i]])
        else:
            groups[-1].append(row[i])
    return groups


def _rows(page):
    ws = page.extract_words(**E._WORD_KW)
    if not ws:
        return []
    sw = sorted(ws, key=lambda w: w['top'])
    rows = [[sw[0]]]
    for w in sw[1:]:
        if w['top'] - rows[-1][0]['top'] <= E._ROW_YTOL:
            rows[-1].append(w)
        else:
            rows.append([w])
    return rows


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    path = sys.argv[1]
    only = int(sys.argv[2]) if len(sys.argv) > 2 else None
    with open(path, 'rb') as f:
        data = f.read()
    print(f"_PROSE_DENSITY = {E._PROSE_DENSITY}  (rows with density >= this are barred "
          f"from defining the column grid)\n")
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            if only and i != only:
                continue
            scored = []
            for r in _rows(page):
                g = _gap_groups(r)
                multi = sum(1 for grp in g if len(grp) >= 2)
                txt = ' '.join(w['text'] for w in sorted(r, key=lambda w: w['x0']))
                scored.append((len(g), multi, E._stopword_density(r), E._is_grid_prose(g), txt))
            if not scored:
                continue
            scored.sort(reverse=True)  # most gap-groups first = grid contenders
            print(f"== Page {i} ==")
            for ngroups, multi, d, prose, txt in scored[:6]:
                flag = 'PROSE ' if prose else '  --  '
                print(f"  {flag} groups={ngroups:>2}  multiword={multi:>2}  density={d:.2f} | {txt[:62]}")
            print()


if __name__ == '__main__':
    main()
