'use client';

import {
  StudentReachDeckConversation,
  type StudentReachDeckConversationProps,
} from './StudentReachDeckConversation';

export function StudentReachDeckFenceConversation(
  props: Pick<
    StudentReachDeckConversationProps,
    | 'domainScope'
    | 'learningContext'
    | 'onRunSettled'
    | 'readOnly'
    | 'openingMessage'
    | 'readOnlyNotice'
    | 'systemNotice'
  >,
) {
  return <StudentReachDeckConversation {...props} pages={[]} variant="learning-fence" />;
}
