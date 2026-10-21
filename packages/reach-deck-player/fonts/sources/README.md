# Reach Deck source fonts

This directory contains the 15 TTF/OTF source-font binaries used to generate the sibling WOFF2
webfont bundle and to render imported Office documents in AI Runtime workers. They are ordinary Git
files by project decision; do not replace them with Git LFS pointers or download them during a
business-image build.

- `SHA256SUMS` is the byte-level integrity contract consumed by the worker base image.
- `manifest.json` records the embedded family/version metadata, upstream provenance and license
  document for every binary.
- `licenses/` contains the applicable license text or an upstream notice. The repository's own
  license does not cover these font binaries.
- The sibling `../manifest.json`, `../fonts.css` and `../*.woff2` files are the generated web
  artifacts. Do not edit a WOFF2 independently of its source-font record.

When replacing a source, update its hash, provenance/version, applicable notices and every generated
WOFF2 artifact in one change. Validate all binaries with `fc-scan` or an equivalent OpenType parser
before committing. For GPL-covered fonts, preserve the accompanying complete license/exception and
the upstream project/release location recorded in the manifest; if that location can no longer be
relied on, obtain legal review and bundle any corresponding source required for redistribution or
stop distributing that binary.

Alibaba PuHuiTi is not OFL. Alibaba's official materials state free commercial use, but the supplied
font's name table says “All rights reserved” and the public terms are less explicit about
redistributing or re-hosting the font software than the open-source licenses below. The project
owner has chosen to bundle the official download; review `licenses/ALIBABA-PUHUITI-3-NOTICE.md`
before any distribution outside ReachAny-controlled products or registries.

Liberation Sans/Serif are old 1.05/1.04 binaries, not the current OFL release. They are governed by
the historical GPLv2 plus Liberation exceptions in
`licenses/LIBERATION-GPL-2.0-WITH-EXCEPTIONS.txt`. Corresponding source and historical releases
remain available from the upstream URL recorded in the manifest.
