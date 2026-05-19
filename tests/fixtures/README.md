# Test fixtures

## `sample.pdf`

A minimal, hand-crafted single-page PDF used by the real-PDF e2e pipeline
(`tests/e2e/real-pdf-pipeline.e2e.test.ts`). The file is referenced from the spawned Zotero profile
via the `extensions.zotero-ai-explain.e2e-sample-pdf` pref; the in-plugin diagnostic driver imports
it through `Zotero.Attachments.importFromFile` and opens the result via `Zotero.Reader.open`.

### Provenance

- **Author:** generated programmatically by this project (no third-party source). The PDF is
  assembled from primitive PDF objects (catalog, pages, page, font, content stream) emitted as bytes
  — see the generator notes below for the exact structure.
- **License:** CC0 1.0 (Public Domain Dedication). The file contains no third-party content. The
  single visible glyph string is "Hello, Zotero".
- **Size:** 598 bytes.
- **SHA-256:** `ab2c7e357f004785244e00c73d1cdc375b5b38f2a9c045dfa09319be5b0220ce`
- **Page count:** 1.
- **PDF version:** 1.4.

### Why hand-crafted (not a third-party PDF)?

- No third-party license to track.
- Deterministic bytes: regenerable from the recipe below if the file is ever corrupted or
  reformatted by an over-eager tool. The SHA-256 above pins the exact bytes that pass the e2e suite.
- Small enough (<1 KB) to commit without triggering `check-added-large-files`.
- Real, parseable PDF -- `file tests/fixtures/sample.pdf` reports "PDF document, version 1.4, 1
  pages". Zotero's PDF.js-backed reader opens the file and renders the toolbar within the FINDING-8
  10-second probe window.

### Regeneration recipe (if needed)

Standard PDF structure with five indirect objects and a single content stream:

1. `1 0 obj` -- Catalog (`/Type /Catalog /Pages 2 0 R`)
2. `2 0 obj` -- Pages (`/Type /Pages /Kids [3 0 R] /Count 1`)
3. `3 0 obj` -- Page (US Letter `[0 0 612 792]`, font `F1` referencing object 4, content stream
   referencing object 5)
4. `4 0 obj` -- Font (Helvetica, Type 1)
5. `5 0 obj` -- Content stream rendering "Hello, Zotero" at (72, 720) in 24-point Helvetica.

The xref table records byte offsets of each object; the trailer points `/Root` at the catalog. Run
any third-party PDF validator (e.g., `pdfinfo`, `qpdf --check`) against the file to confirm
structural integrity.
