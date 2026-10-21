export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function validationMessage(error: unknown): string {
  // Only use this for our local parsers. Never forward a provider response or fetch error.
  return error instanceof Error
    ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1800)
    : '数据格式不正确。';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requestObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new HttpError(400, 'invalid_request', '请求必须是 JSON 对象，且只能包含接口声明的字段。');
  }
  return value;
}

export function textField(
  value: unknown,
  name: string,
  maximum: number,
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new HttpError(400, 'invalid_request', `${name} 必须是 1–${maximum} 个字符的文本。`);
  }
  return value.trim();
}
