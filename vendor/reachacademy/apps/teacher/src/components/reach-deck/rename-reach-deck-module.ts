import type { ReachDeckModuleContext } from '@reachany/reach-deck-client';

import type { PortalTranslator } from '@/src/lib/i18n';

/** Rename the course node; the Deck document's own title is independent. */
export async function renameReachDeckModule(
  context: ReachDeckModuleContext,
  title: string,
  t: PortalTranslator,
): Promise<string> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error(t('teacher.courses.renameRequired'));
  const base = `/teacher/courses/${encodeURIComponent(context.courseId)}`;
  try {
    const navigationResponse = await fetch(`${base}/draft-navigation`, { cache: 'no-store' });
    const navigation = (await navigationResponse.json()) as {
      ok?: boolean;
      result?: {
        courseId?: string;
        nodes?: { courseNodeId?: string; moduleId?: string }[];
        workspace?: { lockVersion?: number };
      };
    };
    const lockVersion = navigation.result?.workspace?.lockVersion;
    if (
      !navigationResponse.ok ||
      navigation.ok !== true ||
      navigation.result?.courseId !== context.courseId ||
      !Number.isSafeInteger(lockVersion) ||
      (lockVersion as number) < 0 ||
      !navigation.result.nodes?.some(
        (node) => node.courseNodeId === context.courseNodeId && node.moduleId === context.moduleId,
      )
    ) {
      throw new Error(t('teacher.courses.renameError'));
    }
    const response = await fetch(`${base}/authoring/ops`, {
      body: JSON.stringify({
        action: 'rename-node',
        courseNodeId: context.courseNodeId,
        expectedLockVersion: lockVersion,
        title: trimmedTitle,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': globalThis.crypto.randomUUID(),
      },
      method: 'POST',
    });
    if (response.status === 409) throw new Error(t('teacher.courses.renameConflict'));
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: { courseNodeId?: string; title?: string; lockVersion?: number };
    };
    if (!response.ok || payload.ok !== true) throw new Error(t('teacher.courses.renameError'));
    if (
      payload.result?.courseNodeId !== context.courseNodeId ||
      typeof payload.result.title !== 'string' ||
      !payload.result.title.trim() ||
      !Number.isSafeInteger(payload.result.lockVersion)
    ) {
      throw new Error(t('teacher.courses.renameResponseError'));
    }
    return payload.result.title;
  } catch (error) {
    // Transport and protocol errors must not leak implementation details into the inline form.
    const messages = ['renameError', 'renameConflict', 'renameResponseError'].map((key) =>
      t(`teacher.courses.${key}`),
    );
    if (error instanceof Error && messages.includes(error.message)) throw error;
    throw new Error(t('teacher.courses.renameError'));
  }
}
