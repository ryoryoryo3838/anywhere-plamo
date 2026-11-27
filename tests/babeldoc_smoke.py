"""Exercise the installed sidecar with a real local model and a two-page PDF.

Run in the BabelDOC environment with reportlab installed. Supply the URL of
an already-running loopback llama-server hosting a PLaMo Translate GGUF.
"""
import argparse
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import pymupdf
from reportlab.pdfgen import canvas


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-url', required=True)
    args = parser.parse_args()
    script = Path(__file__).resolve().parents[1] / 'scripts/babeldoc_pdf.py'
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'input.pdf'
        output = Path(directory) / 'translated.pdf'
        pdf = canvas.Canvas(str(source), pagesize=(420, 600))
        for sentence in ['The library is open every morning.', 'Readers can borrow books from the library.']:
            pdf.setFont('Helvetica', 15)
            pdf.drawString(45, 500, sentence)
            pdf.setFillColorRGB(0.1, 0.3, 0.8)
            pdf.rect(50, 200, 100, 70, stroke=0, fill=1)
            pdf.showPage()
        pdf.save()
        subprocess.run([sys.executable, '-I', str(script), str(source), str(output),
                        '--target', 'ja', '--server-url', args.server_url,
                        '--preview-dir', str(Path(directory) / 'pages')], check=True)
        with pymupdf.open(source) as before, pymupdf.open(output) as after:
            assert len(before) == len(after) == 2
            for original, translated in zip(before, after):
                with pymupdf.open(Path(directory) / 'pages' / f'{translated.number + 1}.pdf') as preview:
                    assert len(preview) == 1 and preview[0].get_text().strip() == translated.get_text().strip()
                assert original.rect == translated.rect
                text = translated.get_text().strip()
                assert re.search(r'[ぁ-んァ-ヶ一-龯]', text), text
                assert original.get_pixmap().pixel(95, 360) == translated.get_pixmap().pixel(95, 360)
                print(f'page {translated.number + 1}: {text}')


if __name__ == '__main__':
    main()
