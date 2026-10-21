'use client';

import { UserRound } from 'lucide-react';
import { useState } from 'react';

/**
 * 讲稿区左侧的讲者头像：课程「教师」角色智能体的头像，经同源 BFF 按本次学习记录鉴权读取。
 * 课程没有启用教师智能体或没上传头像时接口返回 404，这里退回通用人像图标。
 */
export function StudentDeckNarratorAvatar({
  attemptId,
  moduleVersionId,
  selectionId,
}: {
  attemptId: string;
  moduleVersionId: string;
  selectionId: string;
}) {
  const source = studentDeckNarratorAvatarUrl({ attemptId, moduleVersionId, selectionId });
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (failedSource === source) return <UserRound aria-hidden="true" size={28} />;
  return (
    // 头像字节由同源 BFF 鉴权返回，不经过 next/image 的优化管线。
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" data-student-narrator-avatar onError={() => setFailedSource(source)} src={source} />
  );
}

export function studentDeckNarratorAvatarUrl({
  attemptId,
  moduleVersionId,
  selectionId,
}: {
  attemptId: string;
  moduleVersionId: string;
  selectionId: string;
}): string {
  return `/api/student/reach-deck/track-modules/${encodeURIComponent(selectionId)}/attempts/${encodeURIComponent(attemptId)}/course-agent-avatar/teacher?moduleVersionId=${encodeURIComponent(moduleVersionId)}`;
}
