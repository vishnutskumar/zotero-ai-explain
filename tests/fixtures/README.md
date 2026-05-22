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

## `sample-multipage.pdf`

A minimal, hand-crafted **three-page** PDF used by the AC-0 PDF.js entry-point smoke test
(`tests/e2e/pdfworker-smoke.e2e.test.ts`). The smoke test imports it through
`Zotero.Attachments.importFromFile`, calls `Zotero.PDFWorker.getFullText(attachmentID)`, and asserts
that `text.split('\f').length === totalPages` — a multi-page PDF exercises the form-feed page-split
that a single-page PDF (`sample.pdf`) cannot.

### Provenance

- **Author:** generated programmatically by this project (no third-party source). Same primitive
  PDF-object recipe as `sample.pdf`, extended to three page objects.
- **License:** CC0 1.0 (Public Domain Dedication). No third-party content. Each page renders one
  distinct ASCII string: "Page One Alpha", "Page Two Bravo", "Page Three Charlie".
- **Size:** 1129 bytes.
- **SHA-256:** `4344232ba89fc6a822f8dbcfe66976d580381eff80a4ab1a2bda8dbab0b014e5`
- **Page count:** 3.
- **PDF version:** 1.4.

### Regeneration recipe (if needed)

Standard PDF structure with nine indirect objects:

1. `1 0 obj` -- Catalog (`/Type /Catalog /Pages 2 0 R`)
2. `2 0 obj` -- Pages (`/Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3`)
3. `3 0 obj` -- Font (Helvetica, Type 1; shared by all pages)
4. `4 0 obj`, `6 0 obj`, `8 0 obj` -- Page objects (US Letter `[0 0 612 792]`)
5. `5 0 obj`, `7 0 obj`, `9 0 obj` -- Content streams rendering one page string each at (72, 720) in
   24-point Helvetica.

`file tests/fixtures/sample-multipage.pdf` reports "PDF document, version 1.4, 3 pages".

## `corrupt.pdf`

A deliberately malformed file used by the AC-0 smoke test's adversarial case. It carries the
`%PDF-1.4` header (so Zotero's content sniffer registers it as `application/pdf` and
`isPDFAttachment()` returns true) but its body is garbage with no valid objects, xref table, or
trailer. `Zotero.PDFWorker.getFullText` MUST reject when handed this attachment; the test asserts
the rejection is surfaced (`e2e:pdfworker:corrupt:rejected=true`), not silently swallowed.

### Provenance

- **Author:** generated programmatically by this project (no third-party source).
- **License:** CC0 1.0 (Public Domain Dedication). No third-party content.
- **Size:** 132 bytes.
- **SHA-256:** `96015784d79fc02582bd5d94095d217ba57d1714e72e504c849a41d5f085ef8c`
- **Not a valid PDF by design** — only the leading `%PDF-1.4` header is well-formed.

### Regeneration recipe (if needed)

```python
data = b'%PDF-1.4\n' + b'this is not a valid pdf body ' * 4 + b'\n%%EOF\n'
open('tests/fixtures/corrupt.pdf', 'wb').write(data)
```
