# Document Translation Build Evidence

Validation was run on 2026-10-03 in the `feat/document-translation` worktree.

## Dependencies and loading

- `fflate` `0.8.3` is used for OOXML package reads and writes. It is bundled in
  the on-demand `DocumentTranslationMode-Cu1s-kXt.js` chunk at `40,385` bytes
  minified (`16,408` bytes gzip).
- `pdfjs-dist` `6.3.289` is loaded with dynamic `import()` only when a PDF is
  parsed. The PDF worker is emitted as the local `pdf.worker-*.js` asset and is
  selected with a Vite `new URL()` reference. No CDN `workerSrc` or remote
  resource is configured.
- The shell's entry chunk is `360,420` bytes (351.97 KiB), below the existing
  372 KiB first-screen baseline. The shell does not reference `pdfjs-dist` or
  `fflate`; the document parser and PDF worker are on-demand chunks.
- The build emits the on-demand PDF assets `pdf-*.js` (`487,951` bytes) and
  `pdf.worker-*.js` (`1,194,075` bytes). The document Worker/fallback bundle is
  `worker-*.js` (`510,962` bytes); this is also on demand.

## PDF resources and offline cache

`pdfjs-dist` ships 168 `.bcmap` files. The client build copies them to
`dist/pdfjs/cmaps/`; their total size is `1,165,667` bytes (`1.6M` on disk).
No `.pfb` files are emitted. The PDF worker requests CMaps from the same-origin
`pdfjs/cmaps/` path, and the service-worker glob includes them in the offline
precache.

The service-worker report changed from the 26-file / 1.55 MB baseline to 207
files / 4.84 MB (`+181` files / `+3.29 MB`). The PDF parser, worker, document
worker, provider chunks, and all CMaps are present in that manifest. The root,
internal, and `/mintranslate` sub-path builds all passed the external-reference
and no-analytics gates.

## OQ4 fixture

`src/lib/document/fixtures/cid-stsong.pdf` is a 2,917-byte, two-page PDF made
in a scratch virtual environment with ReportLab's
`UnicodeCIDFont("STSong-Light")`. `pdftotext` reads the text layer in page order:

```text
第一页：中文文本层
这是一个用于 PDF 提取测试的段落。

第二页：保持页序
```

The fixture is under the 50 KB limit. The local `pdftotext` result is recorded
for the fixture, but browser extraction was not run in this dispatch.

## Browser and accessibility checks

Browser, preview-server, screenshot, and Lighthouse checks were not run in this
dispatch. TASK.md prohibits browser and server work, so OpenSpec tasks 8.4 and
8.5 remain explicitly unchecked. Real model output quality, live 429 timing,
and opening rebuilt files in Word, Excel, or PowerPoint remain unverified.
