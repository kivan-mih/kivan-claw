---
name: document-tools
description: "Extract text, convert and OCR PDF / DOC / DOCX / XLS / XLSX / PPTX / images via CLI tools baked into the runtime container."
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "requires":
          {
            "bins":
              [
                "pdftotext",
                "pdftoppm",
                "pdfinfo",
                "qpdf",
                "gs",
                "libreoffice",
                "pandoc",
                "tesseract",
                "ssconvert",
                "antiword",
                "catdoc",
                "convert",
              ],
          },
      },
  }
---

# Document Tools

CLI toolbox for working with office documents inside the OpenClaw container. All
tools below are pre-installed in the runtime image — no extra install step is
needed.

## When to Use

✅ **USE this skill when:**

- Extracting plain text from a PDF, DOCX, DOC, XLSX, XLS, PPTX or ODT
- Converting between document formats (DOCX → PDF, XLSX → CSV, MD → DOCX, …)
- Running OCR on a scanned PDF or image (Russian or English text)
- Inspecting / splitting / merging PDF pages
- Rasterizing a PDF page to PNG/JPG for vision models

❌ **DON'T use this skill when:**

- The document already lives in a structured format an SDK can read directly
  (e.g. a JSON / CSV / Markdown file — just read it)
- The user wants editing-with-instructions on a PDF — use the `nano-pdf` skill
- The file is an audio / video — use the media-understanding pipeline instead

## Quick Reference

| Source            | Target       | Command                                                             |
| ----------------- | ------------ | ------------------------------------------------------------------- |
| `*.pdf`           | plain text   | `pdftotext -layout in.pdf -`                                        |
| `*.pdf`           | PNG per page | `pdftoppm -r 200 -png in.pdf page`                                  |
| `*.pdf` (scanned) | OCR text     | `pdftoppm -r 300 -png in.pdf p && tesseract p-1.png out -l rus+eng` |
| `*.docx`/`*.odt`  | PDF          | `libreoffice --headless --convert-to pdf in.docx`                   |
| `*.docx`          | Markdown     | `pandoc -f docx -t markdown in.docx -o out.md`                      |
| `*.doc` (legacy)  | text         | `antiword in.doc`                                                   |
| `*.xlsx`/`*.xls`  | CSV (fast)   | `ssconvert in.xlsx out.csv`                                         |
| `*.xls` (legacy)  | text         | `catdoc -s 8bit -d utf-8 in.xls`                                    |
| `*.pptx`          | PDF          | `libreoffice --headless --convert-to pdf in.pptx`                   |
| image             | OCR text     | `tesseract scan.png out -l rus+eng`                                 |
| `*.md` / HTML     | DOCX         | `pandoc in.md -o out.docx`                                          |

## PDF

```bash
# Plain text, preserve layout columns
pdftotext -layout in.pdf out.txt
pdftotext -layout in.pdf -          # stdout

# Page range
pdftotext -f 2 -l 5 in.pdf -

# Metadata + page count
pdfinfo in.pdf

# Rasterize pages to PNG (300 dpi here; -r 150 is usually enough)
pdftoppm -r 300 -png in.pdf page    # writes page-1.png, page-2.png, …
pdftoppm -r 200 -png -f 1 -l 1 in.pdf page   # first page only

# Split / merge / re-encrypt
qpdf in.pdf --pages in.pdf 1-3 -- out.pdf      # extract pages 1-3
qpdf --empty --pages a.pdf b.pdf -- merged.pdf # concat
qpdf --decrypt --password=PASS in.pdf out.pdf  # strip password (if known)

# Optimize / down-rasterize (Ghostscript)
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dPDFSETTINGS=/ebook \
   -dNOPAUSE -dQUIET -dBATCH -sOutputFile=out.pdf in.pdf
```

## DOC / DOCX / ODT / RTF

```bash
# Best fidelity: round-trip through PDF via LibreOffice headless
libreoffice --headless --convert-to pdf in.docx        # writes in.pdf
libreoffice --headless --convert-to txt in.docx        # writes in.txt
libreoffice --headless --convert-to "html:HTML (StarWriter)" in.docx
libreoffice --headless --convert-to pdf --outdir /tmp in.docx

# Lightweight text/markdown extraction (no LibreOffice spin-up)
pandoc -f docx -t plain    in.docx -o out.txt
pandoc -f docx -t markdown in.docx -o out.md
pandoc -f docx -t gfm      in.docx -o out.md          # GitHub-flavored MD

# Legacy .doc (Word 97-2003) when LibreOffice is overkill
antiword in.doc                                        # plain text to stdout
```

## XLS / XLSX / ODS

```bash
# Fastest XLSX → CSV (single sheet, ~10× faster than LibreOffice for batches)
ssconvert in.xlsx out.csv

# Pick a specific sheet
ssconvert -S in.xlsx out.csv               # -S exports every sheet to out.csv.<n>
ssconvert --export-type=Gnumeric_stf:stf_csv -O 'sheet=Summary' in.xlsx out.csv

# All sheets at once via LibreOffice (preserves cell formatting better)
libreoffice --headless --convert-to csv in.xlsx
libreoffice --headless --convert-to pdf in.xlsx        # for a snapshot/preview

# Legacy .xls
catdoc -s 8bit -d utf-8 in.xls                          # cells as text rows
```

## PPTX / ODP

```bash
libreoffice --headless --convert-to pdf in.pptx        # use this for previews
libreoffice --headless --convert-to png in.pptx        # one PNG per slide
pdftoppm -r 150 -png in.pdf slide                       # then rasterize if needed
```

## OCR (Tesseract)

```bash
# Languages installed: eng, rus. Use both when the doc is mixed.
tesseract scan.png out -l rus+eng                       # writes out.txt

# stdout for piping
tesseract scan.png - -l rus+eng

# Higher accuracy: pass LSTM page-segmentation mode 6 for paragraphs of text
tesseract scan.png out -l rus+eng --psm 6

# OCR a scanned PDF (rasterize → OCR each page → concat)
mkdir -p /tmp/ocr && pdftoppm -r 300 -png scan.pdf /tmp/ocr/p
for img in /tmp/ocr/p-*.png; do
  tesseract "$img" - -l rus+eng --psm 6
done > out.txt
```

## Images (ImageMagick)

```bash
# Inspect
identify photo.jpg

# Format / resize / strip metadata
convert in.heic -quality 90 out.jpg
convert in.png -resize 1024x1024\> -strip out.jpg

# Multi-page image → single PDF
convert page1.png page2.png out.pdf
```

> **PDF + ImageMagick gotcha:** Debian's `/etc/ImageMagick-6/policy.xml` blocks
> `convert` from reading/writing PDF by default. **Always rasterize PDFs with
> `pdftoppm` instead of `convert in.pdf out.png`** — it's faster and works out
> of the box.

## Pandoc Universal Converter

```bash
pandoc in.md       -o out.docx               # MD  → DOCX
pandoc in.html     -o out.md                 # HTML → MD
pandoc in.docx -t gfm -o out.md              # DOCX → GitHub MD
pandoc in.md -t pdf --pdf-engine=xelatex -o out.pdf   # MD → PDF (needs xelatex; not installed)
pandoc in.md -o out.pdf --pdf-engine=weasyprint        # alt PDF engine (not installed)
# For MD → PDF without LaTeX, go via DOCX:
pandoc in.md -o /tmp/x.docx && libreoffice --headless --convert-to pdf /tmp/x.docx
```

## Notes / Gotchas

- **LibreOffice first run is slow** (~3-5 s) because it has to create
  `~/.config/libreoffice`. Subsequent calls are fast. For batch jobs prefer
  `ssconvert` or `pandoc` when they cover the format.
- **`libreoffice --headless` can't run two instances at once** against the same
  user profile. If you parallelize, pass `-env:UserInstallation=file:///tmp/lo-$$`
  per worker.
- **Cyrillic in LibreOffice PDFs:** `fonts-noto-core` is installed, so Russian
  text renders correctly. If a doc uses an embedded font we don't have,
  glyphs may fall back to Noto — visually close, not identical.
- **OCR languages:** only `eng` and `rus` are installed. For other languages,
  add `tesseract-ocr-<lang>` via the `OPENCLAW_DOCKER_APT_PACKAGES` build arg.
- **ImageMagick PDF policy:** see the gotcha above — use `pdftoppm` for PDF
  rasterization.
- **Encrypted PDFs:** `pdftotext` and `qpdf` need `--password=` (or
  `--password-file=` for qpdf) when the doc has an open password.
- **Working directory:** LibreOffice writes converted files next to the input
  by default. Use `--outdir <dir>` to redirect output.
