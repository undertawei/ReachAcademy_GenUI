import { describe, expect, it } from 'vitest';

import { parsePptxXml } from '../src/pptx/index.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('PPTX XML parsing', () => {
  it('preserves qualified names, attributes, child order, and text', () => {
    const result = parsePptxXml(
      '/ppt/slides/slide1.xml',
      bytes(
        '<p:sld xmlns:p="urn:p"><p:cSld name="A"><a:t xmlns:a="urn:a">Hi</a:t></p:cSld></p:sld>',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root).toMatchObject({
      name: 'p:sld',
      attributes: { 'xmlns:p': 'urn:p' },
      children: [
        {
          name: 'p:cSld',
          attributes: { name: 'A' },
          children: [{ name: 'a:t', text: 'Hi' }],
        },
      ],
    });
  });

  it('decodes XML character references for logical text while retaining raw content', () => {
    const result = parsePptxXml(
      '/ppt/slides/slide1.xml',
      bytes('<root>He said &quot;Hi&quot; &amp; &lt;x&gt; &#x1F642;</root>'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.text).toBe('He said "Hi" & <x> 🙂');
    expect(result.root.content).toEqual(['He said &quot;Hi&quot; &amp; &lt;x&gt; &#x1F642;']);
  });

  it.each([
    '<!DOCTYPE root><root/>',
    '<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>',
  ])('rejects declarations that can expand entities', (xml) => {
    const result = parsePptxXml('/ppt/presentation.xml', bytes(xml));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({
      code: 'pptx.xml.forbidden_declaration',
      severity: 'fatal',
    });
  });

  it('rejects malformed XML with a structured source location', () => {
    const result = parsePptxXml('/ppt/presentation.xml', bytes('<root><broken></root>'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({
      code: 'pptx.xml.malformed',
      location: { partPath: '/ppt/presentation.xml' },
    });
  });

  it('enforces depth and node limits before constructing the parsed tree', () => {
    const deep = parsePptxXml('/ppt/presentation.xml', bytes('<a><b><c/></b></a>'), {
      maxXmlDepth: 2,
    });
    expect(deep.ok).toBe(false);
    if (!deep.ok) expect(deep.diagnostics[0]?.code).toBe('pptx.xml.depth_limit_exceeded');

    const many = parsePptxXml('/ppt/presentation.xml', bytes('<a><b/><c/></a>'), {
      maxXmlNodes: 2,
    });
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.diagnostics[0]?.code).toBe('pptx.xml.node_limit_exceeded');
  });
});
