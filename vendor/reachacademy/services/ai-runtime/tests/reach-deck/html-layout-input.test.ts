import { describe, expect, it } from 'vitest';
import { getReferenceEntry } from '@reachany/reach-deck-dsl/reference-library';
import {
  projectHtmlAsset,
  projectHtmlComponent,
} from '../../lib/reach-deck/prompts/html-layout-input.js';

describe('HTML asset projection', () => {
  it('provides a display ratio without exposing source pixel dimensions', () => {
    const asset = projectHtmlAsset(
      {
        assetId: 'photo-1',
        kind: 'image',
        purpose: 'Examine the object',
        alt: 'A photographed object',
        placement: 'primary',
        aspectRatio: '3:2',
      },
      undefined,
      { width: 1279, height: 853 },
    );

    expect(asset.ratio).toBe('1.50');
    expect(JSON.stringify(asset)).not.toContain('1279');
    expect(JSON.stringify(asset)).not.toContain('853');
  });
});

describe('HTML component projection', () => {
  it('never asks the layout model for a page number it cannot know', () => {
    const projected = projectHtmlComponent(
      getReferenceEntry('components', 'component.page-number-progress-rail-v1'),
    );
    expect(projected.id).toBe('component.page-number-progress-rail-v1');
    expect(projected.name).not.toContain('页码与');
    expect(projected.name).toContain('不写页码');
  });

  it('keeps other component names verbatim', () => {
    const entry = getReferenceEntry('components', 'component.editorial-index-row-v1');
    expect(projectHtmlComponent(entry).name).toBe(entry.name);
  });
});
