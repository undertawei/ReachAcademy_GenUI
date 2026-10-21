import type { Pool } from 'pg';
import {
  messagePage,
  type LearningRecordMessage,
  type LearningRecordMessageQuery,
  type LearningRecordMessagePage,
  type MessageWatermark,
} from '../learning-record-messages.js';

// Preserve PostgreSQL microseconds in the keyset; Date would discard tied sub-millisecond rows.
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const LEARNING_RECORD_MESSAGES_SQL = `
WITH requested AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(
    "organizationId" uuid, "actorAccountId" uuid, "attemptId" text, "moduleVersionId" text)
), legacy AS (
  SELECT r.* FROM public.ai_run r JOIN requested s
    ON s."organizationId" = r.organization_id AND s."actorAccountId" = r.actor_account_id
    AND s."attemptId" = r.domain_scope ->> 'attemptId'
    AND s."moduleVersionId" = r.domain_scope ->> 'moduleVersionId'
  WHERE r.scene_key = 'student.tutor'
    AND r.input -> 'learningContext' ->> 'schemaVersion' IN
      ('reach-deck-tutor-context/v1','reach-deck-learning-fence-context/v1','video-tutor-context/v1')
    AND r.input -> 'learningContext' ->> 'attemptId' = s."attemptId"
    AND COALESCE(r.domain_scope ->> 'tutorDomain','ordinary') IN ('ordinary','learning_fence')
    AND NOT EXISTS (SELECT 1 FROM public.ai_tutor_round tr WHERE tr.run_id = r.id)
), raw AS (
  SELECT 'ai_run'::text AS source, r.id::text AS source_id, r.organization_id, r.actor_account_id,
    r.domain_scope ->> 'attemptId' AS attempt_id, r.domain_scope ->> 'moduleVersionId' AS module_version_id,
    r.thread_id, r.id AS run_id, NULL::uuid AS round_id, NULL::text AS reply_message_id,
    r.input ->> 'replyToRunId' AS reply_run_id, 'student'::text AS role,
    NULL::uuid AS agent_id, NULL::text AS display_name, r.input -> 'learningContext' AS context,
    NULL::text AS sequence_number, NULL::text AS author_kind, NULL::text AS context_watermark,
    'completed'::text AS status, r.input ->> 'message' AS content,
    r.queued_at AS created_at, NULL::timestamptz AS completed_at, r.queued_at AS recorded_at
  FROM legacy r WHERE jsonb_typeof(r.input -> 'message') = 'string'
  UNION ALL
  SELECT 'ai_run_event', e.id::text, r.organization_id, r.actor_account_id,
    r.domain_scope ->> 'attemptId', r.domain_scope ->> 'moduleVersionId',
    r.thread_id, r.id, NULL::uuid, 'ai_run:' || r.id::text, NULL::text, 'assistant',
    NULL::uuid, NULL::text, r.input -> 'learningContext', NULL::text, NULL::text, NULL::text, 'completed',
    e.payload ->> 'text', e.created_at, e.created_at, e.created_at
  FROM legacy r JOIN public.ai_run_event e ON e.run_id = r.id
  WHERE e.event_type = 'message.completed' AND jsonb_typeof(e.payload -> 'text') = 'string'
  UNION ALL
  SELECT 'ai_tutor_message', m.id::text, m.organization_id, t.actor_account_id,
    t.domain_scope ->> 'attemptId', t.domain_scope ->> 'moduleVersionId',
    m.thread_id, tr.run_id, m.round_id,
    CASE WHEN m.reply_to_message_id IS NOT NULL THEN 'ai_tutor_message:' || m.reply_to_message_id::text END,
    NULL::text, CASE WHEN m.author_kind = 'actor' THEN 'student' ELSE COALESCE(m.author_role,'assistant') END,
    m.author_agent_id, m.author_display_name, m.learning_context, m.sequence_number::text,
    m.author_kind::text, m.context_watermark::text,
    m.status, m.content, m.created_at, m.completed_at,
    CASE WHEN m.author_kind = 'actor' THEN m.created_at ELSE m.completed_at END
  FROM public.ai_thread t JOIN requested s
    ON s."organizationId" = t.organization_id AND s."actorAccountId" = t.actor_account_id
    AND s."attemptId" = t.domain_scope ->> 'attemptId'
    AND s."moduleVersionId" = t.domain_scope ->> 'moduleVersionId'
  JOIN public.ai_tutor_message m ON m.thread_id = t.id AND m.organization_id = t.organization_id
  LEFT JOIN public.ai_tutor_round tr ON tr.id = m.round_id AND tr.thread_id = t.id AND tr.organization_id = t.organization_id
  WHERE t.scene_key = 'student.tutor'
    AND (
      (COALESCE(t.domain_scope ->> 'tutorDomain','ordinary') = 'ordinary'
        AND m.learning_context ->> 'schemaVersion' IN ('reach-deck-tutor-context/v1','video-tutor-context/v1'))
      OR (t.domain_scope ->> 'tutorDomain' = 'learning_fence'
        AND m.learning_context ->> 'schemaVersion' = 'reach-deck-learning-fence-context/v1'
        AND (t.domain_scope ->> 'fenceId' IS NULL OR t.domain_scope ->> 'fenceId' = m.learning_context ->> 'fenceId')
        AND (t.domain_scope ->> 'pageId' IS NULL OR t.domain_scope ->> 'pageId' = m.learning_context ->> 'pageId')
        AND (t.domain_scope ->> 'questionId' IS NULL OR t.domain_scope ->> 'questionId' = m.learning_context ->> 'questionId')
        AND (t.domain_scope ->> 'sceneId' IS NULL OR t.domain_scope ->> 'sceneId' = m.learning_context ->> 'sceneId'))
    )
    AND m.learning_context ->> 'attemptId' = s."attemptId"
    AND ((m.author_kind = 'actor' AND m.author_account_id = s."actorAccountId")
      OR (m.author_kind <> 'actor' AND m.status IN ('completed','interrupted','failed') AND m.completed_at IS NOT NULL))
), eligible AS (
  SELECT *, (source || ':' || source_id) COLLATE "C" AS message_id FROM raw
  WHERE recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz AND recorded_at <= $4::timestamptz
), upper_key AS (
  SELECT recorded_at, message_id FROM eligible
  WHERE $7::timestamptz IS NULL OR (recorded_at,message_id) <= ($7::timestamptz,$8::text COLLATE "C")
  ORDER BY recorded_at DESC,message_id DESC LIMIT 1
), page AS (
  SELECT e.* FROM eligible e CROSS JOIN upper_key u
  WHERE (e.recorded_at,e.message_id) <= (u.recorded_at,u.message_id)
    AND ($5::timestamptz IS NULL OR (e.recorded_at,e.message_id) > ($5::timestamptz,$6::text COLLATE "C"))
  ORDER BY e.recorded_at,e.message_id LIMIT $9::integer
)
SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'source',source,'sourceRecordId',source_id,'messageId',message_id,
  'organizationId',organization_id,'actorAccountId',actor_account_id,
  'attemptId',attempt_id,'moduleVersionId',module_version_id,
  'activityType',CASE WHEN context ->> 'schemaVersion' = 'video-tutor-context/v1' THEN 'video' ELSE 'reach-deck' END,
  'tutorDomain',CASE WHEN context ->> 'schemaVersion' = 'reach-deck-learning-fence-context/v1' THEN 'learning_fence' ELSE 'ordinary' END,
  'threadId',thread_id,'runId',run_id,'roundId',round_id,
  'replyToMessageId',reply_message_id,'replyToRunId',reply_run_id,'role',role,
  'authorKind',author_kind,'authorAgentId',agent_id,'authorDisplayName',display_name,
  'pageId',context ->> 'pageId','fenceId',context ->> 'fenceId',
  'sceneId',context ->> 'sceneId','questionId',context ->> 'questionId',
  'positionSeconds',CASE WHEN jsonb_typeof(context -> 'positionSeconds') = 'number' THEN context -> 'positionSeconds' END,
  'sequenceNumber',sequence_number,'contextWatermark',context_watermark,'status',status,'content',content,
  'createdAt',${utc('created_at')},'completedAt',${utc('completed_at')},'recordedAt',${utc('recorded_at')}
) ORDER BY recorded_at,message_id) FROM page),'[]'::jsonb) AS messages,
(SELECT jsonb_build_object('recordedAt',${utc('recorded_at')},'messageId',message_id) FROM upper_key) AS upper_watermark`;

export async function queryLearningRecordMessages(
  pool: Pool,
  query: LearningRecordMessageQuery,
): Promise<LearningRecordMessagePage> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await client.query<{
      messages: LearningRecordMessage[];
      upper_watermark: MessageWatermark | null;
    }>(LEARNING_RECORD_MESSAGES_SQL, [
      JSON.stringify(query.scopes),
      query.from,
      query.to,
      query.readCutoff,
      query.after?.recordedAt ?? null,
      query.after?.messageId ?? null,
      query.upperWatermark?.recordedAt ?? null,
      query.upperWatermark?.messageId ?? null,
      query.limit + 1,
    ]);
    await client.query('COMMIT');
    const row = result.rows[0];
    if (!row) throw new Error('Learning record messages returned no page metadata');
    return messagePage(query, row.messages, query.upperWatermark ?? row.upper_watermark);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
