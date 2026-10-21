/** Browser-facing self-profile boundary shared by the three role applications. */
export const PROFILE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const PROFILE_REQUEST_MAX_BYTES = PROFILE_IMAGE_MAX_BYTES + 16 * 1024;
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
export interface SelfProfile {
  username: string;
  displayName: string | null;
  avatarRevision: string | null;
  lockVersion: string;
}
export function readSelfProfile(value: unknown): SelfProfile | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (
    typeof p.username !== 'string' ||
    p.username.length > 2048 ||
    (p.displayName !== null &&
      (typeof p.displayName !== 'string' || p.displayName.length > 2048)) ||
    (p.avatarRevision !== null &&
      (typeof p.avatarRevision !== 'string' || !/^[a-f0-9]{64}$/.test(p.avatarRevision))) ||
    typeof p.lockVersion !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(p.lockVersion)
  )
    return null;
  return {
    username: p.username,
    displayName: p.displayName as string | null,
    avatarRevision: p.avatarRevision as string | null,
    lockVersion: p.lockVersion,
  };
}
export function profileError(error: string, status: number) {
  return Response.json({ error }, { status, headers: PRIVATE_HEADERS });
}
export function isProfileSameOrigin(request: Request, publicOrigin: string | undefined): boolean {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (!origin || !publicOrigin || (site && site !== 'same-origin')) return false;
  try {
    // Next may normalize a public 127.0.0.1 URL to localhost. Only server configuration
    // defines the browser origin; request URLs and forwarding headers are not authorities.
    const expected = new URL(publicOrigin.trim());
    if (
      !['http:', 'https:'].includes(expected.protocol) ||
      expected.username ||
      expected.password ||
      expected.pathname !== '/' ||
      expected.search ||
      expected.hash
    )
      return false;
    return origin === expected.origin;
  } catch {
    return false;
  }
}
async function boundedBytes(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > max) throw new RangeError('size');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function profileForm(request: Request): Promise<FormData> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(type) || type.length > 256)
    throw new Error('input');
  if (Number(request.headers.get('content-length')) > PROFILE_REQUEST_MAX_BYTES)
    throw new RangeError('size');
  const bytes = await boundedBytes(
    request.body,
    PROFILE_REQUEST_MAX_BYTES,
    AbortSignal.timeout(15_000),
  );
  const form = await new Response(bytes, { headers: { 'Content-Type': type } }).formData();
  const allowed = new Set(['expectedLockVersion', 'displayName', 'avatarAction', 'image', 'crop']);
  const seen = new Set<string>();
  for (const [key, value] of form) {
    if (!allowed.has(key) || seen.has(key)) throw new Error('input');
    seen.add(key);
    if (key !== 'image' && (typeof value !== 'string' || value.length > 512))
      throw new Error('input');
  }
  const version = form.get('expectedLockVersion');
  const action = form.get('avatarAction');
  if (
    typeof version !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(version) ||
    !['keep', 'replace', 'default'].includes(String(action))
  )
    throw new Error('input');
  const image = form.get('image');
  const crop = form.get('crop');
  if (action === 'replace') {
    if (!image || typeof image === 'string' || image.size === 0 || typeof crop !== 'string')
      throw new Error('input');
    if (image.size > PROFILE_IMAGE_MAX_BYTES) throw new RangeError('size');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type)) throw new Error('input');
    const parsed = JSON.parse(crop) as Record<string, unknown>;
    if (
      !parsed ||
      Object.keys(parsed).sort().join() !== 'height,width,x,y' ||
      !Object.values(parsed).every(
        (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4096,
      ) ||
      parsed.width !== parsed.height ||
      Number(parsed.width) < 1 ||
      Number(parsed.x) + Number(parsed.width) > 4096 ||
      Number(parsed.y) + Number(parsed.height) > 4096
    )
      throw new Error('input');
    form.set('image', image, 'avatar');
  } else if (image !== null || crop !== null) throw new Error('input');
  return form;
}
const SAFE_ERRORS = new Set([
  'display_name_invalid',
  'avatar_size_exceeded',
  'avatar_dimensions_invalid',
  'avatar_crop_invalid',
  'avatar_animation_not_allowed',
  'avatar_content_type_invalid',
  'avatar_media_type_mismatch',
  'avatar_encoding_invalid',
  'avatar_decode_failed',
  'avatar_truncated',
  'avatar_processor_busy',
  'avatar_not_found',
]);
export async function proxySelfProfile(
  request: Request,
  options: {
    accessToken: string;
    authBaseUrl: string;
    /** Trusted server-side public origin, never derived from request headers. */
    publicOrigin: string | undefined;
    avatar?: boolean;
    fetcher?: typeof fetch;
  },
): Promise<Response> {
  if (request.method === 'PUT' && !isProfileSameOrigin(request, options.publicOrigin))
    return profileError('forbidden', 403);
  let body: FormData | undefined;
  if (request.method === 'PUT') {
    try {
      body = await profileForm(request);
    } catch (error) {
      return profileError(
        error instanceof RangeError ? 'avatar_size_exceeded' : 'profile_payload_invalid',
        error instanceof RangeError ? 413 : 400,
      );
    }
  }
  const signal = AbortSignal.timeout(45_000);
  try {
    const upstream = await (options.fetcher ?? fetch)(
      new URL('/api/v1/auth/profile' + (options.avatar ? '/avatar' : ''), options.authBaseUrl),
      {
        method: request.method,
        body,
        ...{ cache: 'no-store' },
        redirect: 'error',
        signal,
        headers: { Authorization: 'Bearer ' + options.accessToken },
      },
    );
    const bytes = await boundedBytes(
      upstream.body,
      options.avatar ? PROFILE_IMAGE_MAX_BYTES : 16 * 1024,
      signal,
    );
    if (options.avatar && upstream.ok) {
      if (upstream.headers.get('content-type')?.split(';')[0] !== 'image/webp')
        return profileError('profile_unavailable', 502);
      return new Response(bytes, {
        headers: {
          ...PRIVATE_HEADERS,
          'Content-Type': 'image/webp',
          'Content-Disposition': 'inline; filename="avatar.webp"',
        },
      });
    }
    if (upstream.status === 401) return profileError('session_expired', 401);
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return profileError('profile_unavailable', 502);
    }
    const profile = readSelfProfile(envelope.data);
    if (upstream.ok && profile)
      return Response.json({ data: profile }, { headers: PRIVATE_HEADERS });
    if (upstream.status === 409 && profile)
      return Response.json(
        { error: 'profile_conflict', data: profile },
        { status: 409, headers: PRIVATE_HEADERS },
      );
    const safe =
      typeof envelope.message === 'string' && SAFE_ERRORS.has(envelope.message)
        ? envelope.message
        : 'profile_unavailable';
    return profileError(
      safe,
      [400, 403, 404, 413].includes(upstream.status) ? upstream.status : 503,
    );
  } catch {
    return profileError(
      request.method === 'PUT' ? 'profile_save_uncertain' : 'profile_unavailable',
      503,
    );
  }
}
