import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  createHs256Token,
  readHs256ServiceJwtConfig,
  verifyHs256Token,
  verifyRs256Token,
} from '../src/index.js';

const SECRET = 'reachany-test-secret-minimum-32-bytes';

describe('service JWT configuration', () => {
  it('requires the complete explicit HS256 trust contract in production', () => {
    expect(
      readHs256ServiceJwtConfig({
        NODE_ENV: 'production',
        REACHANY_SERVICE_JWT_MODE: 'hs256',
        REACHANY_SERVICE_JWT_SECRET: SECRET,
        REACHANY_SERVICE_JWT_ISSUER: 'reachany-service-mesh',
        REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
      }),
    ).toEqual({
      mode: 'hs256',
      secret: SECRET,
      issuer: 'reachany-service-mesh',
      audience: 'reachany-services',
    });
  });

  it.each([
    [{ REACHANY_SERVICE_JWT_SECRET: SECRET }, 'explicitly set to hs256'],
    [
      { REACHANY_SERVICE_JWT_MODE: 'rs256', REACHANY_SERVICE_JWT_SECRET: SECRET },
      'mode must be hs256',
    ],
    [
      { REACHANY_SERVICE_JWT_MODE: 'hs256', REACHANY_SERVICE_JWT_SECRET: 'too-short' },
      'at least 32 UTF-8 bytes',
    ],
    [
      {
        REACHANY_SERVICE_JWT_MODE: 'hs256',
        REACHANY_SERVICE_JWT_SECRET: SECRET,
        REACHANY_SERVICE_JWT_ISSUER: 'reachany-service-mesh',
      },
      'audience is required',
    ],
  ])('rejects an incomplete production contract', (overrides, message) => {
    expect(() => readHs256ServiceJwtConfig({ NODE_ENV: 'production', ...overrides })).toThrow(
      message,
    );
  });

  it('permits optional metadata in tests but still requires a secret', () => {
    expect(
      readHs256ServiceJwtConfig({ NODE_ENV: 'test', REACHANY_SERVICE_JWT_SECRET: 'test' }),
    ).toMatchObject({ mode: 'hs256', secret: 'test' });
    expect(() => readHs256ServiceJwtConfig({ NODE_ENV: 'test' })).toThrow(
      'Service JWT secret is required',
    );
  });

  it('rejects the literal production env-template secret', () => {
    expect(() =>
      readHs256ServiceJwtConfig({
        NODE_ENV: 'production',
        REACHANY_SERVICE_JWT_MODE: 'hs256',
        REACHANY_SERVICE_JWT_SECRET: 'replace-with-service-jwt-secret-at-least-32-bytes',
        REACHANY_SERVICE_JWT_ISSUER: 'reachany-service-mesh',
        REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
      }),
    ).toThrow('must not be a placeholder');
  });
});

describe('HS256 JWT helpers', () => {
  it('returns validated claims for a signed token', async () => {
    const token = await createHs256Token({
      secret: SECRET,
      subject: 'user-123',
      issuer: 'reachacademy-tests',
      audience: 'reachacademy',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      actorId: 'teacher-1',
      roles: ['teacher'],
      extraClaims: { tenant_id: 'tenant-1' },
    });

    const claims = await verifyHs256Token(token, {
      secret: SECRET,
      issuer: 'reachacademy-tests',
      audience: 'reachacademy',
    });

    expect(claims.subject).toBe('user-123');
    expect(claims.actorId).toBe('teacher-1');
    expect(claims.roles).toEqual(['teacher']);
    expect(claims.extra.tenant_id).toBe('tenant-1');
  });

  it.each(['actor_id', 'aud', 'exp', 'iat', 'iss', 'jti', 'nbf', 'org_id', 'roles', 'sub'])(
    'rejects extraClaims that overwrite reserved claim %s',
    async (reservedClaim) => {
      await expect(
        createHs256Token({
          secret: SECRET,
          subject: 'user-123',
          extraClaims: { [reservedClaim]: 'malicious-overwrite' },
        }),
      ).rejects.toThrow(`reserved JWT claim: ${reservedClaim}`);
    },
  );
});

describe('RS256 JWT helpers', () => {
  it('verifies a token signed by a JWKS key', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({
      actor_id: 'teacher-1',
      org_id: 'org-1',
      roles: ['teacher'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'identity-key-1' })
      .setIssuer('https://identity.reachany.test')
      .setAudience('reachacademy')
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const claims = await verifyRs256Token(token, {
      audience: 'reachacademy',
      issuer: 'https://identity.reachany.test',
      jwks: {
        keys: [
          {
            ...jwk,
            alg: 'RS256',
            kid: 'identity-key-1',
            use: 'sig',
          },
        ],
      },
    });

    expect(claims.subject).toBe('user-123');
    expect(claims.actorId).toBe('teacher-1');
    expect(claims.roles).toEqual(['teacher']);
    expect(claims.orgId).toBe('org-1');
  });

  it('rejects RS256 tokens without a kid header', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://identity.reachany.test')
      .setAudience('reachacademy')
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(
      verifyRs256Token(token, {
        audience: 'reachacademy',
        issuer: 'https://identity.reachany.test',
        jwks: {
          keys: [
            {
              ...jwk,
              alg: 'RS256',
              kid: 'identity-key-1',
              use: 'sig',
            },
          ],
        },
      }),
    ).rejects.toThrow('RS256 token header must include kid');
  });
});

describe('org_id/jti first-class claims', () => {
  it('emits orgId and an auto jti, kept out of extra', async () => {
    const token = await createHs256Token({ secret: 's', subject: 'u-1', orgId: 'org-1' });
    const claims = await verifyHs256Token(token, { secret: 's' });
    expect(claims.orgId).toBe('org-1');
    expect(typeof claims.jti).toBe('string');
    expect((claims.jti ?? '').length).toBeGreaterThan(0);
    expect(claims.extra.org_id).toBeUndefined();
    expect(claims.extra.jti).toBeUndefined();
  });

  it('generates a unique jti per token', async () => {
    const a = await verifyHs256Token(await createHs256Token({ secret: 's', subject: 'u' }), {
      secret: 's',
    });
    const b = await verifyHs256Token(await createHs256Token({ secret: 's', subject: 'u' }), {
      secret: 's',
    });
    expect(a.jti).not.toBe(b.jti);
  });

  it('omits orgId when not provided', async () => {
    const token = await createHs256Token({ secret: 's', subject: 'u' });
    const claims = await verifyHs256Token(token, { secret: 's' });
    expect(claims.orgId).toBeUndefined();
  });
});
