# @reachany/auth

Server-oriented JWT helpers for ReachAcademy TypeScript services.

These helpers intentionally use `jose` and should run in trusted server contexts.
Do not expose HS256 shared secrets or private signing keys to browsers or other
untrusted clients. Browser-facing code should only receive short-lived tokens.

Exports:

- `JwtClaims`
- `createHs256Token`
- `verifyHs256Token`
- `verifyRs256Token`
- `RESERVED_JWT_CLAIMS`
