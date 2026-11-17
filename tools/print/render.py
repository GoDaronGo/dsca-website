"""Render the printable handouts in tools/print/ to PDFs in static/print/.

Usage: python3 tools/print/render.py [--png]
--png also writes a preview image of each page next to this script.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent.parent / "static" / "print"
DOCS = {
    "welcome-flyer.html": "dsca-welcome-flyer.pdf",
    "new-homeowner-form.html": "dsca-new-homeowner-form.pdf",
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 816, "height": 1056})
        for src, pdf in DOCS.items():
            path = HERE / src
            if not path.exists():
                continue
            page.goto(path.as_uri())
            page.wait_for_load_state("networkidle")
            page.evaluate("document.fonts.ready")
            page.pdf(path=str(OUT / pdf), format="Letter", print_background=True,
                     margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})
            if "--png" in sys.argv:
                page.screenshot(path=str(HERE / (pdf[:-4] + ".png")), full_page=True)
            print("wrote", OUT / pdf)
        browser.close()


if __name__ == "__main__":
    main()
