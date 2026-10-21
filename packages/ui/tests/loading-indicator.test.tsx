import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoadingIndicator, LoadingIndicatorProvider, Spinner, Table } from '../src/index';

describe('application loading visual', () => {
  it('keeps the default spinner and the original shared consumer graphic', () => {
    const markup = renderToStaticMarkup(
      <>
        <Spinner label="Loading" />
        <LoadingIndicator>
          <i data-original="true" />
        </LoadingIndicator>
      </>,
    );
    expect(markup).toContain('class="rx-spinner rx-spinner-md"');
    expect(markup).toContain('data-original="true"');
    expect(markup).not.toContain('rx-brand-loader');
  });

  it('opts into the three-stroke logo without losing spinner label, size or span attributes', () => {
    const markup = renderToStaticMarkup(
      <LoadingIndicatorProvider variant="brand">
        <Spinner className="action-slot" data-action="save" label="Saving" size="sm" />
        <LoadingIndicator size="sm">
          <i data-original="true" />
        </LoadingIndicator>
      </LoadingIndicatorProvider>,
    );
    expect(markup).toContain('rx-spinner-brand rx-spinner-sm action-slot');
    expect(markup).toContain('data-action="save"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Saving');
    expect(markup.match(/rx-brand-loader-stroke-top/g)).toHaveLength(2);
    expect(markup).not.toContain('data-original');
  });

  it('lets nested surfaces explicitly keep their original loading graphic', () => {
    const markup = renderToStaticMarkup(
      <LoadingIndicatorProvider variant="brand">
        <LoadingIndicatorProvider variant="spinner">
          <Spinner />
        </LoadingIndicatorProvider>
      </LoadingIndicatorProvider>,
    );
    expect(markup).not.toContain('rx-brand-loader');
  });

  it('keeps a semantic full-column table loading body with the previous row footprint', () => {
    const markup = renderToStaticMarkup(
      <Table
        columns={[
          { key: 'name', title: 'Name' },
          { key: 'value', title: 'Value' },
        ]}
        loading
        loadingFallback={<div role="status">Loading records</div>}
        loadingRows={7}
        rowKey="name"
        rows={[]}
      />,
    );
    expect(markup).toContain('<th');
    expect(markup).toContain('colSpan="2"');
    expect(markup).toContain('--rx-table-loading-rows:7');
    expect(markup).toContain('Loading records');
    expect(markup).not.toContain('rx-table-row-skeleton');
  });

  it('keeps existing rows mounted below a local refresh indicator', () => {
    const markup = renderToStaticMarkup(
      <Table
        columns={[{ key: 'name', title: 'Name' }]}
        loading
        loadingFallback={<div role="status">Refreshing</div>}
        rowKey="name"
        rows={[{ name: 'Existing record' }]}
      />,
    );
    expect(markup).toContain('Existing record');
    expect(markup).toContain('rx-table-loading-overlay');
    expect(markup).toContain('Refreshing');
  });
});
