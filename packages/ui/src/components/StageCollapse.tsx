'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useId, useMemo, useState } from 'react';

import { IconButton } from './IconButton';

/** Page-local presentation state; callers can lift it above expandable table rows. */
export function useStageCollapse() {
  const instanceId = useId();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const key = (trackId: string, stageId: string) => JSON.stringify([trackId, stageId]);
  const toggle = useCallback((trackId: string, stageId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      const id = key(trackId, stageId);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const expand = useCallback((trackId: string, stageId: string) => {
    setCollapsed((current) => {
      const id = key(trackId, stageId);
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);
  return useMemo(
    () => ({
      isCollapsed: (trackId: string, stageId: string) => collapsed.has(key(trackId, stageId)),
      contentId: (trackId: string, stageId: string, lane = 'content') =>
        `${instanceId}-${encodeURIComponent(key(trackId, stageId))}-${lane}`,
      toggle,
      expand,
    }),
    [collapsed, instanceId, toggle, expand],
  );
}

export type StageCollapseState = ReturnType<typeof useStageCollapse>;

export function StageCollapseButton({
  collapsed,
  controls,
  onToggle,
  title,
  t,
}: {
  collapsed: boolean;
  controls: string;
  onToggle: () => void;
  title: string;
  t: (key: 'shared.stage.collapse' | 'shared.stage.expand', values: { name: string }) => string;
}) {
  return (
    <IconButton
      aria-controls={controls}
      aria-expanded={!collapsed}
      className="shrink-0"
      icon={collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      label={t(collapsed ? 'shared.stage.expand' : 'shared.stage.collapse', { name: title })}
      onClick={onToggle}
      size="sm"
    />
  );
}
