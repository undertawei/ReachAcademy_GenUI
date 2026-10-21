import { createHash } from 'node:crypto';

import type { CourseAgentMemberSnapshot } from './contracts.js';

interface PresetIdentity {
  name: string;
  role: CourseAgentMemberSnapshot['agentRole'];
  portableSha256: string;
  selfMentions: number;
  peerMentions?: number;
}

// Portable v1 metadata from java/admin-service/src/main/resources/platform-agent-presets.
// Hashes cover the FULL, decoded original preset instructions, not an arbitrary substring.
const PRESETS: Record<string, PresetIdentity> = {
  'course-agent.teacher.wuyin-mentor': {
    name: '无垠导师',
    role: 'teacher',
    portableSha256: '6d8168ec318ac5f868c6df62ab83a2584b52040cd894f72f02b15196277addfd',
    selfMentions: 0,
  },
  'course-agent.teaching-assistant.wuyin-assistant': {
    name: '无垠助教',
    role: 'teaching_assistant',
    portableSha256: '4406b6c3b105c08a852dfd313a114900ace80dd6080e2a987fdd635ba8d7f5e6',
    selfMentions: 0,
  },
  'course-agent.classmate.ruichi': {
    name: '瑞驰',
    role: 'classmate',
    portableSha256: '2977f7c5e2eaadc97abe831abef72b192a8956b6a2af2f49de8316a0e2adfc9d',
    selfMentions: 10,
  },
  'course-agent.classmate.zhiqi': {
    name: '知启',
    role: 'classmate',
    portableSha256: 'c8c4f213f0865930a67b441b86702a26bae95a5534c3330e0d2fd4f88dc8abe3',
    selfMentions: 10,
    peerMentions: 8,
  },
};

const DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts';

/** The preset catalog's canonical SHA-256 layout, including Jackson's field ordering/spaces. */
export function portablePresetHash(
  identity: Pick<PresetIdentity, 'name' | 'role'>,
  instructions: string,
): string {
  const canonical =
    '{"name": ' +
    JSON.stringify(identity.name) +
    ', "agentRole": ' +
    JSON.stringify(identity.role) +
    ', "avatarUri": null' +
    ', "ttsVoiceId": ' +
    JSON.stringify(DEFAULT_VOICE) +
    ', "description": null' +
    ', "instructions": ' +
    JSON.stringify(instructions) +
    ', "languageCode": ' +
    JSON.stringify('zh-CN') +
    '}';
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Only an exact trusted v1 persona may have names rewritten; no arbitrary CJK replacement. */
export function courseAgentBoundPersona(
  member: CourseAgentMemberSnapshot,
  roundMembers: readonly CourseAgentMemberSnapshot[],
): string {
  const preset = member.sourcePresetKey ? PRESETS[member.sourcePresetKey] : undefined;
  if (
    !preset ||
    member.sourcePresetVersion !== 1 ||
    member.agentRole !== preset.role ||
    portablePresetHash(preset, member.instructions) !== preset.portableSha256
  ) {
    return member.instructions;
  }
  if (preset.peerMentions !== undefined) {
    if (
      countOccurrences(member.instructions, preset.name) !== preset.selfMentions ||
      countOccurrences(member.instructions, '瑞驰') !== preset.peerMentions
    )
      return member.instructions;
    const peers = roundMembers.filter(
      (candidate) =>
        candidate.sourcePresetKey === 'course-agent.classmate.ruichi' &&
        candidate.sourcePresetVersion === 1 &&
        candidate.agentRole === 'classmate',
    );
    const peerName = peers.length === 1 ? peers[0]!.displayName : '另一名同学';
    // One pass over the VERIFIED original avoids replacing names inside a new display name.
    return member.instructions.replaceAll(/知启|瑞驰/g, (original) =>
      original === preset.name ? member.displayName : peerName,
    );
  }
  return (
    replaceExactCount(member.instructions, preset.name, member.displayName, preset.selfMentions) ??
    member.instructions
  );
}

function replaceExactCount(
  text: string,
  original: string,
  replacement: string,
  expectedCount: number,
): string | null {
  if (countOccurrences(text, original) !== expectedCount) return null;
  return text.replaceAll(original, replacement);
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}
