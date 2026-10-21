import {
  SignJWT,
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';

export * from './frontend-role-session.js';
export * from './profile-proxy.js';

export const RESERVED_JWT_CLAIMS = new Set([
  'actor_id',
  'aud',
  'exp',
  'iat',
  'iss',
  'jti',
  'nbf',
  'org_id',
  'roles',
  'sub',
]);

export interface JwtClaims {
  subject: string;
  expiresAt: Date;
  issuer?: string;
  audience?: string | string[];
  issuedAt?: Date;
  actorId?: string;
  roles: string[];
  orgId?: string;
  jti?: string;
  extra: Record<string, unknown>;
}

export interface CreateHs256TokenOptions {
  secret: string;
  subject: string;
  expiresAt?: Date;
  expiresInSeconds?: number;
  issuer?: string;
  audience?: string;
  actorId?: string;
  roles?: string[];
  orgId?: string;
  jti?: string;
  extraClaims?: Record<string, unknown>;
}

export interface VerifyHs256TokenOptions {
  secret: string;
  issuer?: string;
  audience?: string;
}

export interface VerifyRs256TokenOptions {
  jwks: JSONWebKeySet;
  issuer?: string;
  audience?: string;
}

export interface Hs256ServiceJwtConfig {
  mode: 'hs256';
  secret: string;
  issuer?: string;
  audience?: string;
}

export interface ReadHs256ServiceJwtConfigOptions {
  developmentSecretFallback?: string;
  production?: boolean;
}

export class ServiceJwtConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceJwtConfigurationError';
  }
}

const KNOWN_CLAIMS = new Set([
  'actor_id',
  'aud',
  'exp',
  'iat',
  'iss',
  'jti',
  'nbf',
  'org_id',
  'roles',
  'sub',
]);

const PRODUCTION_SECRET_PLACEHOLDERS = new Set([
  'change-me',
  'changeme',
  'dev-insecure-change-me',
  'replace-with-service-jwt-secret',
  'replace-with-service-jwt-secret-at-least-32-bytes',
  'your-service-jwt-secret',
]);

export function readHs256ServiceJwtConfig(
  env: Partial<Record<string, string | undefined>>,
  options: ReadHs256ServiceJwtConfigOptions = {},
): Hs256ServiceJwtConfig {
  const production = options.production ?? readOptional(env.NODE_ENV) === 'production';
  const configuredMode = readOptional(env.REACHANY_SERVICE_JWT_MODE)?.toLowerCase();

  if (configuredMode !== undefined && configuredMode !== 'hs256') {
    throw new ServiceJwtConfigurationError('Service JWT mode must be hs256');
  }
  if (production && configuredMode !== 'hs256') {
    throw new ServiceJwtConfigurationError(
      'Production service JWT mode must be explicitly set to hs256',
    );
  }

  const configuredSecret = readOptional(env.REACHANY_SERVICE_JWT_SECRET);
  const secret =
    configuredSecret ?? (production ? undefined : readOptional(options.developmentSecretFallback));
  if (secret === undefined) {
    throw new ServiceJwtConfigurationError('Service JWT secret is required');
  }

  const issuer = readOptional(env.REACHANY_SERVICE_JWT_ISSUER);
  const audience = readOptional(env.REACHANY_SERVICE_JWT_AUDIENCE);
  if (production) {
    if (new TextEncoder().encode(secret).byteLength < 32) {
      throw new ServiceJwtConfigurationError(
        'Production service JWT secret must be at least 32 UTF-8 bytes',
      );
    }
    if (PRODUCTION_SECRET_PLACEHOLDERS.has(secret.trim().toLowerCase())) {
      throw new ServiceJwtConfigurationError(
        'Production service JWT secret must not be a placeholder',
      );
    }
    if (issuer === undefined) {
      throw new ServiceJwtConfigurationError('Production service JWT issuer is required');
    }
    if (audience === undefined) {
      throw new ServiceJwtConfigurationError('Production service JWT audience is required');
    }
  }

  return { mode: 'hs256', secret, issuer, audience };
}

export async function createHs256Token(options: CreateHs256TokenOptions): Promise<string> {
  const now = new Date();
  const expiresAt =
    options.expiresAt ?? new Date(now.getTime() + (options.expiresInSeconds ?? 15 * 60) * 1000);
  const extraClaims = options.extraClaims ?? {};
  const reservedClaim = [...RESERVED_JWT_CLAIMS].find((claim) => claim in extraClaims);

  if (reservedClaim) {
    throw new Error(`extraClaims cannot overwrite reserved JWT claim: ${reservedClaim}`);
  }

  const payload: JWTPayload & Record<string, unknown> = {
    ...extraClaims,
    sub: options.subject,
    jti: options.jti ?? globalThis.crypto.randomUUID(),
  };

  if (options.actorId !== undefined) {
    payload.actor_id = options.actorId;
  }
  if (options.roles !== undefined) {
    payload.roles = options.roles;
  }
  if (options.orgId !== undefined) {
    payload.org_id = options.orgId;
  }

  const signer = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .setIssuedAt(Math.floor(now.getTime() / 1000));

  if (options.issuer !== undefined) {
    signer.setIssuer(options.issuer);
  }
  if (options.audience !== undefined) {
    signer.setAudience(options.audience);
  }

  return signer.sign(encodeSecret(options.secret));
}

export async function verifyHs256Token(
  token: string,
  options: VerifyHs256TokenOptions,
): Promise<JwtClaims> {
  const { payload } = await jwtVerify(token, encodeSecret(options.secret), {
    algorithms: ['HS256'],
    issuer: options.issuer,
    audience: options.audience,
    requiredClaims: ['exp', 'sub'],
  });

  return toJwtClaims(payload);
}

export async function verifyRs256Token(
  token: string,
  options: VerifyRs256TokenOptions,
): Promise<JwtClaims> {
  const header = decodeProtectedHeader(token);
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new Error('RS256 token header must include kid');
  }

  const matchingKey = options.jwks.keys.find((key) => key.kid === header.kid);
  if (matchingKey === undefined) {
    throw new Error('No matching JWKS key');
  }

  const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: [matchingKey] }), {
    algorithms: ['RS256'],
    issuer: options.issuer,
    audience: options.audience,
    requiredClaims: ['exp', 'sub'],
  });

  return toJwtClaims(payload);
}

function toJwtClaims(payload: JWTPayload): JwtClaims {
  if (typeof payload.sub !== 'string') {
    throw new Error('JWT subject must be a string');
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('JWT expiration must be a numeric date');
  }

  const extra = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !KNOWN_CLAIMS.has(key)),
  );

  return {
    subject: payload.sub,
    expiresAt: new Date(payload.exp * 1000),
    issuer: payload.iss,
    audience: payload.aud,
    issuedAt: typeof payload.iat === 'number' ? new Date(payload.iat * 1000) : undefined,
    actorId: typeof payload.actor_id === 'string' ? payload.actor_id : undefined,
    roles: Array.isArray(payload.roles) ? payload.roles.filter(isString) : [],
    orgId: typeof payload.org_id === 'string' ? payload.org_id : undefined,
    jti: typeof payload.jti === 'string' ? payload.jti : undefined,
    extra,
  };
}

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function readOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
