import { describe, expect, it } from 'vitest';
import {
  AnswerMediaOrigins,
  independentAnswerAttachments,
  moveIndependentAnswerAttachment,
} from '../src/answer-media.js';

const asset = (id: string, key = id) => ({ assetId: id, objectKey: key, name: id });
const doc = (...assets: ReturnType<typeof asset>[]) => ({
  type: 'doc',
  content: assets.map((attrs) => ({ type: 'image', attrs })),
});

describe('answer media projections', () => {
  it('hides inline aliases but retains conflicting identities and standalone files', () => {
    expect(
      independentAnswerAttachments(
        [asset('one', 'stable'), asset('two', 'tmp'), asset('file')],
        doc(asset('one', 'tmp')),
      ),
    ).toEqual([asset('two', 'tmp'), asset('file')]);
    expect(independentAnswerAttachments([{ objectKey: 'old' }], doc(asset('one', 'old')))).toEqual(
      [],
    );
  });
  it('drops only the final inline reference and restores its registration on undo after promotion', () => {
    const origins = new AnswerMediaOrigins();
    const original = asset('image', 'tmp/image');
    origins.registerInline(original);
    origins.finishInsertion(doc(original));
    const stable = asset('image', 'stable/image');
    expect(origins.effective([stable], doc(stable, stable))).toHaveLength(1);
    expect(origins.effective([stable], doc(stable))).toHaveLength(1);
    expect(origins.effective([stable], doc())).toEqual([]);
    expect(origins.independent([stable], doc())).toEqual([]);
    expect(origins.effective([stable], doc(original))).toEqual([{ ...stable, order: 0 }]);
  });
  it('keeps pending uploads hidden, downgrading uninserted files at the completion boundary', () => {
    const origins = new AnswerMediaOrigins();
    const uploaded = asset('uploaded');
    origins.registerInline(uploaded);
    expect(origins.independent([uploaded], doc())).toEqual([]);
    expect(origins.effective([uploaded], doc())).toHaveLength(1);
    origins.finishInsertion(doc());
    expect(origins.independent([uploaded], doc())).toEqual([uploaded]);
  });
  it('remembers a key-only legacy body reference even when its backing row has an asset ID', () => {
    const origins = new AnswerMediaOrigins();
    const registered = asset('legacy', 'legacy/photo');
    const document = { type: 'image', attrs: { objectKey: registered.objectKey } };
    expect(origins.independent([registered], document)).toEqual([]);
    expect(origins.effective([registered], doc())).toEqual([]);
    expect(origins.effective([registered], document)).toHaveLength(1);
  });
  it('moves only visible independent files among hidden registry entries', () => {
    const inline = asset('inline');
    const first = asset('first');
    const last = asset('last');
    expect(moveIndependentAnswerAttachment([inline, first, last], [first, last], 1, -1)).toEqual([
      inline,
      last,
      first,
    ]);
  });
  it('does not silently truncate an undo that exceeds the upload limit', () => {
    const origins = new AnswerMediaOrigins();
    const inline = asset('inline');
    origins.observe(doc(inline));
    const registry = [inline, ...Array.from({ length: 10 }, (_, i) => asset(String(i)))];
    expect(origins.effective(registry, doc())).toHaveLength(10);
    expect(origins.effective(registry, doc(inline))).toHaveLength(11);
  });
});
