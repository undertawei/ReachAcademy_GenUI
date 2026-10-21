export type AnswerMediaReference = { assetId?: string; objectKey: string };

export function answerMediaIdentity(asset: AnswerMediaReference): string {
  return asset.assetId ? `asset:${asset.assetId}` : `key:${asset.objectKey}`;
}

export function collectAnswerMedia(document: unknown): AnswerMediaReference[] {
  const found: AnswerMediaReference[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if ((node.type === 'image' || node.type === 'attachment') && node.attrs) {
      const attrs = node.attrs as Record<string, unknown>;
      if (typeof attrs.objectKey === 'string')
        found.push({
          objectKey: attrs.objectKey,
          ...(typeof attrs.assetId === 'string' ? { assetId: attrs.assetId } : {}),
        });
    }
    Object.values(node).forEach(visit);
  };
  visit(document);
  return found;
}

function matches(left: AnswerMediaReference, right: AnswerMediaReference): boolean {
  // A conflicting asset identity must never hide an unrelated object.
  if (left.assetId && right.assetId) return left.assetId === right.assetId;
  return left.objectKey === right.objectKey;
}

export function independentAnswerAttachments<T extends AnswerMediaReference>(
  attachments: readonly T[] | null | undefined,
  document: unknown,
): T[] {
  const inline = collectAnswerMedia(document);
  return (attachments ?? []).filter((asset) => !inline.some((node) => matches(asset, node)));
}

export function countAnswerMedia(
  attachments: readonly AnswerMediaReference[],
  document: unknown,
): number {
  const media = [...attachments];
  for (const node of collectAnswerMedia(document)) {
    if (!media.some((asset) => matches(asset, node))) media.push(node);
  }
  return media.length;
}

/** Origin memory survives document deletion and undo; the host retains the descriptor registry. */
export class AnswerMediaOrigins {
  private inline = new Set<string>();
  private pending = new Set<string>();
  private observeRegistry(registry: readonly AnswerMediaReference[], document: unknown): void {
    const nodes = collectAnswerMedia(document);
    for (const asset of registry) {
      if (nodes.some((node) => matches(asset, node))) {
        const id = answerMediaIdentity(asset);
        this.inline.add(id);
        this.pending.delete(id);
      }
    }
  }
  observe(document: unknown): void {
    for (const asset of collectAnswerMedia(document)) {
      const id = answerMediaIdentity(asset);
      this.inline.add(id);
      this.pending.delete(id);
    }
  }
  registerInline(asset: AnswerMediaReference): void {
    this.pending.add(answerMediaIdentity(asset));
  }
  /** Hosts serialize uploads per editor; successful uploads never inserted become independent. */
  finishInsertion(document: unknown): void {
    this.observe(document);
    this.pending.clear();
  }
  effective<T extends AnswerMediaReference>(
    registry: readonly T[],
    document: unknown,
  ): (T & { order: number })[] {
    this.observe(document);
    this.observeRegistry(registry, document);
    const active = collectAnswerMedia(document);
    const seen = new Set<string>();
    return registry
      .filter((asset) => {
        const id = answerMediaIdentity(asset);
        if (seen.has(id)) return false;
        seen.add(id);
        return (
          !this.inline.has(id) ||
          this.pending.has(id) ||
          active.some((node) => matches(asset, node))
        );
      })
      .map((asset, order) => ({ ...asset, order }));
  }
  independent<T extends AnswerMediaReference>(registry: readonly T[], document: unknown): T[] {
    this.observe(document);
    this.observeRegistry(registry, document);
    return independentAnswerAttachments(registry, document).filter((asset) => {
      const id = answerMediaIdentity(asset);
      return !this.inline.has(id) && !this.pending.has(id);
    });
  }
}

/** Move within the visible subset while retaining hidden registry entries in their slots. */
export function moveIndependentAnswerAttachment<T extends AnswerMediaReference>(
  registry: readonly T[],
  visible: readonly T[],
  index: number,
  delta: -1 | 1,
): T[] {
  const next = [...visible];
  const target = index + delta;
  if (!next[index] || !next[target]) return [...registry];
  [next[index], next[target]] = [next[target]!, next[index]!];
  const ids = new Set(visible.map(answerMediaIdentity));
  let position = 0;
  return registry.map((asset) => (ids.has(answerMediaIdentity(asset)) ? next[position++]! : asset));
}
