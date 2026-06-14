#!/usr/bin/env python3
"""Regenerate extraction baselines from the current extractor output.

Run after an INTENDED change to scripts/extract_pdf.py, once you've reviewed the
diff reported by `test_extraction_matches_baseline` and confirmed it's correct:

    python3 tests/update_baselines.py

Writes tests/baselines/<sample>.txt for every PDF in pdf-samples/. Baselines are
git-ignored (the samples are real, non-public statements).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import extract_pdf  # noqa: E402

HERE = os.path.dirname(__file__)
SAMPLES = os.path.join(HERE, '..', 'pdf-samples')
BASELINES = os.path.join(HERE, 'baselines')


def full_text(result: dict) -> str:
    return '\n'.join(f"## Page {p['pageNum']}\n{p['text']}" for p in result['pages'])


def main() -> None:
    if not os.path.isdir(SAMPLES):
        print(f'pdf-samples not found at {SAMPLES}', file=sys.stderr)
        sys.exit(1)
    os.makedirs(BASELINES, exist_ok=True)
    count = 0
    for name in sorted(os.listdir(SAMPLES)):
        if not name.endswith('.pdf'):
            continue
        with open(os.path.join(SAMPLES, name), 'rb') as fh:
            text = full_text(extract_pdf.extract(fh.read()))
        with open(os.path.join(BASELINES, name + '.txt'), 'w', encoding='utf-8') as out:
            out.write(text)
        count += 1
        print(f'  wrote {name}.txt')
    print(f'{count} baselines written to tests/baselines/')


if __name__ == '__main__':
    main()
