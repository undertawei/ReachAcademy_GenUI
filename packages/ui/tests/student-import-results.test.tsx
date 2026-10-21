import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StudentImportResults } from '../src/StudentImportResults';

describe('StudentImportResults', () => {
  it('renders the four statistics and accessible classification colors', () => {
    const markup = renderToStaticMarkup(
      <StudentImportResults
        labels={{ existing: 'Existing', invalid: 'Invalid', new: 'New', total: 'Total' }}
        rows={[
          { classification: 'new', content: 'new row', key: 'new' },
          { classification: 'existing', content: 'existing row', key: 'existing' },
          { classification: 'invalid', content: 'invalid row', key: 'invalid' },
        ]}
        statistics={{ existing: 1, invalid: 1, new: 1, total: 3 }}
      />,
    );

    expect(markup).toContain('bg-emerald-50');
    expect(markup).toContain('bg-amber-50');
    expect(markup).toContain('bg-red-50');
    expect(markup).toContain('aria-label="Existing"');
    expect(markup).toContain('aria-label="Invalid"');
    expect(markup).toContain('aria-label="New"');
    expect(markup).toContain('class="col-span-full"');
    expect(markup).toContain('grid-cols-4');
    expect(markup).toContain('grid-template-columns:repeat(4, minmax(0, 1fr))');
  });

  it('renders the identical accessible states with zh-CN labels', () => {
    const markup = renderToStaticMarkup(
      <StudentImportResults
        labels={{ existing: '已有学生', invalid: '无效学生', new: '新学生', total: '学生总数' }}
        rows={[
          { classification: 'existing', content: '机构内已有学生', key: 'existing' },
          { classification: 'invalid', content: '无法导入', key: 'invalid' },
        ]}
        statistics={{ existing: 1, invalid: 1, new: 0, total: 2 }}
      />,
    );

    expect(markup).toContain('aria-label="已有学生"');
    expect(markup).toContain('aria-label="无效学生"');
    expect(markup).toContain('机构内已有学生');
  });
});
