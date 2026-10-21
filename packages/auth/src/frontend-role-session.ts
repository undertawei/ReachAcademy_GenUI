export type FrontendRoleKind = 'student' | 'teacher';

export interface FrontendRoleSessionTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  roleGrantId: string;
  roleKind: FrontendRoleKind;
  subject: string;
}

export interface RefreshFrontendRoleSessionOptions {
  authBaseUrl: string;
  expectedRoleKind: FrontendRoleKind;
  fetchFn?: typeof fetch;
  orgId?: string;
  refreshToken: string;
  roleGrantId: string;
  subject: string;
}

export class FrontendRoleSessionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly authoritative = false,
  ) {
    super(message);
    this.name = 'FrontendRoleSessionError';
  }
}

export async function refreshFrontendRoleSession(
  options: RefreshFrontendRoleSessionOptions,
): Promise<FrontendRoleSessionTokens> {
  const fetchFn = options.fetchFn ?? fetch;
  const apiBaseUrl = buildApiBaseUrl(options.authBaseUrl);
  const refreshed = await requestData(fetchFn, `${apiBaseUrl}/oauth/portal-session/refresh`, {
    body: JSON.stringify({
      refreshToken: options.refreshToken,
      ...(options.orgId === undefined ? {} : { orgId: options.orgId }),
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const refreshedSubject = requireString(refreshed.subject, 'refresh subject');
  if (refreshedSubject !== options.subject)
    throw new FrontendRoleSessionError('Frontend refresh subject mismatch', 403, true);
  const accessToken = requireString(refreshed.accessToken, 'refresh access token');
  const refreshToken = requireString(refreshed.refreshToken, 'refresh token');

  const activated = await requestData(fetchFn, `${apiBaseUrl}/oauth/role-activations`, {
    body: JSON.stringify({ refreshToken, roleGrantId: options.roleGrantId }),
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  const activeRole = requireRecord(activated.activeRole, 'active role');
  const activatedSubject = requireString(activated.subject, 'activation subject');
  const roleGrantId = requireString(activeRole.roleGrantId, 'activation role grant');
  const roleKind = requireString(activeRole.roleKind, 'activation role kind');
  if (
    activatedSubject !== options.subject ||
    activated.target !== 'portal' ||
    roleGrantId !== options.roleGrantId ||
    roleKind !== options.expectedRoleKind
  ) {
    throw new FrontendRoleSessionError('Frontend role activation mismatch', 403, true);
  }

  return {
    accessToken: requireString(activated.accessToken, 'activation access token'),
    expiresIn: requirePositiveNumber(activated.expiresIn, 'activation expiry'),
    refreshToken: requireString(activated.refreshToken, 'activation refresh token'),
    roleGrantId,
    roleKind: options.expectedRoleKind,
    subject: activatedSubject,
  };
}

/**
 * 自助修改密码的失败原因。auth-service 的 R 信封用数字 code，这里收敛成前端可直接
 * 分支的机器码，避免各应用重复解析数字。
 */
export type ChangeFrontendPasswordFailure =
  | 'invalid_credentials'
  | 'invalid_input'
  | 'session_expired'
  | 'unavailable';

export interface ChangeFrontendPasswordOptions {
  accessToken: string;
  authBaseUrl: string;
  currentPassword: string;
  fetchFn?: typeof fetch;
  newPassword: string;
}

/**
 * 调用 auth-service `POST /api/v1/auth/password` 修改当前登录账号的密码。
 *
 * 成功返回 null。该接口同时会把 must_change_password 置回 false，因此它也是管理员
 * 重置密码后，教师/学生清掉「必须改密」标记的唯一途径。
 */
export async function changeFrontendRolePassword(
  options: ChangeFrontendPasswordOptions,
): Promise<ChangeFrontendPasswordFailure | null> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${buildApiBaseUrl(options.authBaseUrl)}/auth/password`, {
      body: JSON.stringify({
        currentPassword: options.currentPassword,
        newPassword: options.newPassword,
      }),
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
  } catch {
    return 'unavailable';
  }

  let envelope: { code?: unknown } = {};
  try {
    envelope = (await response.json()) as { code?: unknown };
  } catch {
    // 空响应体在 2xx 下视为成功，其余交给下面的状态码判断。
    if (response.ok) return null;
  }
  const code = typeof envelope.code === 'number' ? envelope.code : undefined;
  if (response.ok && (code === undefined || code === 0)) return null;
  if (response.status >= 500) return 'unavailable';
  if (code === 4013) return 'invalid_credentials';
  if (code === 400 || response.status === 400) return 'invalid_input';
  if (response.status === 401 || response.status === 403) return 'session_expired';
  if (code === 401 || code === 4011 || code === 4012) return 'session_expired';
  return 'unavailable';
}

function buildApiBaseUrl(value: string): string {
  const baseUrl = value.replace(/\/+$/, '');
  return baseUrl.endsWith('/api/v1') ? baseUrl : `${baseUrl}/api/v1`;
}

async function requestData(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, init);
  if (!response.ok) {
    throw new FrontendRoleSessionError(
      `Frontend role session request failed: ${response.status}`,
      response.status,
      response.status === 401 || response.status === 403,
    );
  }
  const payload = await response.json();
  const record = requireRecord(payload, 'response');
  return 'data' in record ? requireRecord(record.data, 'response data') : record;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`${field} is invalid`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is invalid`);
  return value;
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}
