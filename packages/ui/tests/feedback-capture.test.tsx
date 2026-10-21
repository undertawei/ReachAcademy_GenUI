import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeedbackCapture } from '../src/index';

describe('FeedbackCapture', () => {
  it('renders an accessible minimized launcher by default', () => {
    const markup = renderToStaticMarkup(<FeedbackCapture t={(key) => key} />);
    expect(markup).toContain('rx-feedback-launcher');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('feedback.launcher');
  });
});
