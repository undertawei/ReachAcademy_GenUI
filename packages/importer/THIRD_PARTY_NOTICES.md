# Third-party notices

## OpenMAIC

Design and implementation reference:

- Repository: <https://github.com/ReachAny/OpenMAIC>
- Pinned commit: `63fc81d8e1e8e13d04106618ef29f713541a520e`
- Referenced area: `packages/@openmaic/importer`

The OpenMAIC project is distributed under the following license:

```text
MIT License

Copyright (c) 2026 THU-MAIC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## officemath2latex.js

`src/pptx/math/omml.ts` is an independent TypeScript implementation, but its
construct coverage and several of its mappings were taken from
<https://github.com/555555555a555/officemath2latex.js> — a JavaScript OMML to
LaTeX converter with field experience on real Office documents. What was adopted
from it: the matrix, equation-array, box and border-box constructs; the
bar-less-fraction-in-delimiters binomial idiom; the accent, group-character and
n-ary operator tables; the legacy Equation Editor field codes (`eq \o(…,/)`,
`eq \x \to (…)`) that survive as plain math text; and the bar element's default
position. No source was copied: that repository publishes no license, so this is
a behavioural reference only, in the same sense as the OpenMAIC entry above.

## DrawingML preset shape definitions

`src/pptx/geometry/presetShapeDefinitions.generated.ts` is generated from the preset shape geometry
table of the Office Open XML standard (ECMA-376 Part 1 Annex D / ISO-IEC 29500-1, electronic insert
`OfficeOpenXML-DrawingMLGeometries.zip`, file `presetShapeDefinitions.xml`), which the standard
publishes so implementers can reproduce PowerPoint's built-in shapes. It holds the standard's guide
formulas and path coordinates verbatim; the generator is
`scripts/generate-pptx-preset-shapes.ts`.

## KaTeX

MAIC interactive import uses KaTeX 0.16.33 at import time and embeds its minified JavaScript runtime
for offline MathML rendering when imported interactions create formulas dynamically. KaTeX is
distributed under the MIT License: <https://github.com/KaTeX/KaTeX/blob/v0.16.33/LICENSE>.

## parse5

MAIC interactive import uses parse5 7.3.0 for structural HTML analysis and serialization. parse5
is distributed under the MIT License: <https://github.com/inikulin/parse5/blob/v7.3.0/LICENSE>.
