import JSZip from 'jszip';

const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export async function buildDocxFixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="${CONTENT_TYPES_NAMESPACE}">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
      <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument" Target="word/document.xml"/>
    </Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
      <w:body>
        <w:p><w:r><w:t>第一段正文</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏正文</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="图示"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="diagram.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
      </w:body>
    </w:document>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
      <Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/image" Target="media/diagram.png"/>
    </Relationships>`,
  );
  zip.file(
    'word/media/diagram.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function buildDocxHiddenTextFixture(): Promise<Uint8Array> {
  const bytes = await buildDocxFixture();
  const zip = await JSZip.loadAsync(bytes);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>可见正文</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>直接隐藏答案</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>显式可见正文</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:rStyle w:val="HiddenChild"/></w:rPr><w:t>样式隐藏答案</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:rStyle w:val="VisibleOverride"/></w:rPr><w:t>样式覆盖可见正文</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="HiddenParagraph"/></w:pPr><w:r><w:t>段落样式隐藏答案</w:t></w:r></w:p>
      </w:body>
    </w:document>`,
  );
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="character" w:styleId="HiddenBase"><w:rPr><w:vanish/></w:rPr></w:style>
      <w:style w:type="character" w:styleId="HiddenChild"><w:basedOn w:val="HiddenBase"/></w:style>
      <w:style w:type="character" w:styleId="VisibleOverride"><w:basedOn w:val="HiddenBase"/><w:rPr><w:vanish w:val="false"/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="HiddenParagraph"><w:rPr><w:webHidden/></w:rPr></w:style>
    </w:styles>`,
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function buildAllHiddenDocxFixture(): Promise<Uint8Array> {
  const bytes = await buildDocxFixture();
  const zip = await JSZip.loadAsync(bytes);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>只有隐藏内容</w:t></w:r></w:p></w:body>
    </w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function buildXlsxFixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="${CONTENT_TYPES_NAMESPACE}">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
    </Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
      <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}">
      <sheets><sheet name="成绩" sheetId="1" state="visible" r:id="rId1"/></sheets>
    </workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
      <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/styles" Target="styles.xml"/>
    </Relationships>`,
  );
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
      <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
      <borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>
      <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
    </styleSheet>`,
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>姓名</t></is></c><c r="B1"><f>SUM(1,2)</f><v>3</v></c></row>
        <row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>隐藏</t></is></c></row>
      </sheetData>
    </worksheet>`,
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function buildPptxFixture(hiddenValue: '0' | 'false' = '0'): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="${CONTENT_TYPES_NAMESPACE}">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
      <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
      <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
    </Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
      <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument" Target="ppt/presentation.xml"/>
    </Relationships>`,
  );
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}">
      <p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
      <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
    </p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
      <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/slide" Target="slides/slide1.xml"/>
      <Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/slide" Target="slides/slide2.xml"/>
    </Relationships>`,
  );
  zip.file('ppt/slides/slide1.xml', slideXml('第一页标题'));
  zip.file('ppt/slides/slide2.xml', slideXml('隐藏页面', hiddenValue));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function buildForgedBinaryEntryDocx(): Promise<Uint8Array> {
  const bytes = await buildDocxFixture();
  const zip = await JSZip.loadAsync(bytes);
  const entryName = 'word/media/expanded-payload.bin';
  zip.file(entryName, new Uint8Array(2 * 1024 * 1024));
  const generated = Buffer.from(
    await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
  );
  patchDeclaredUncompressedSize(generated, entryName, 1);
  return generated;
}

export async function buildCompressedDocxBomb(): Promise<Uint8Array> {
  const bytes = await buildDocxFixture();
  const zip = await JSZip.loadAsync(bytes);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${'x'.repeat(2 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function buildMacroDocxFixture(): Promise<Uint8Array> {
  const bytes = await buildDocxFixture();
  const zip = await JSZip.loadAsync(bytes);
  zip.file('word/vbaProject.bin', new Uint8Array([1, 2, 3]));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function slideXml(text: string, hiddenValue?: '0' | 'false'): string {
  return `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"${hiddenValue === undefined ? '' : ` show="${hiddenValue}"`}>
    <p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
  </p:sld>`;
}

function patchDeclaredUncompressedSize(bytes: Buffer, entryName: string, size: number): void {
  let localPatched = false;
  let centralPatched = false;
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50 && offset + 30 <= bytes.byteLength) {
      const nameLength = bytes.readUInt16LE(offset + 26);
      const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
      if (name === entryName) {
        bytes.writeUInt32LE(size, offset + 22);
        localPatched = true;
      }
    }
    if (signature === 0x02014b50 && offset + 46 <= bytes.byteLength) {
      const nameLength = bytes.readUInt16LE(offset + 28);
      const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      if (name === entryName) {
        bytes.writeUInt32LE(size, offset + 24);
        centralPatched = true;
      }
    }
  }
  if (!localPatched || !centralPatched) throw new Error('ZIP fixture entry was not found');
}
