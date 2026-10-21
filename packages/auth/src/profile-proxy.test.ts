import { describe, expect, it, vi } from 'vitest';
import { PROFILE_REQUEST_MAX_BYTES, proxySelfProfile } from './profile-proxy.js';

const profile = {
  username: 'learner',
  displayName: '姓名',
  avatarRevision: null,
  lockVersion: '3',
};
const options = {
  accessToken: 'private-token',
  authBaseUrl: 'http://auth.local',
  publicOrigin: 'http://role.local',
};
function put(form: FormData, headers: Record<string, string> = {}) {
  return new Request('http://role.local/auth/profile', {
    method: 'PUT',
    body: form,
    headers: { Origin: 'http://role.local', ...headers },
  });
}
function form() {
  const data = new FormData();
  data.set('expectedLockVersion', '3');
  data.set('avatarAction', 'keep');
  return data;
}
describe('self-profile proxy boundary', () => {
  it('accepts the configured public origin when the internal URL and Host differ', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: profile }));
    const request = new Request('http://localhost:15609/auth/profile', {
      method: 'PUT',
      body: form(),
      headers: {
        Origin: 'https://teacher.example.test',
        Host: 'internal-service:5202',
        'Sec-Fetch-Site': 'same-origin',
        'X-Forwarded-Host': 'untrusted.example.test',
      },
    });
    const result = await proxySelfProfile(request, {
      ...options,
      publicOrigin: 'https://teacher.example.test',
      fetcher,
    });
    expect(result.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['https://evil.test', 'http://role.local', 'https://teacher.example.test.evil.test'])(
    'rejects an unconfigured origin even with matching forged routing headers: %s',
    async (origin) => {
      const fetcher = vi.fn();
      const request = new Request(origin + '/auth/profile', {
        method: 'PUT',
        body: form(),
        headers: {
          Origin: origin,
          Host: new URL(origin).host,
          'X-Forwarded-Host': new URL(origin).host,
          'X-Forwarded-Proto': new URL(origin).protocol.slice(0, -1),
          Forwarded: 'host=' + new URL(origin).host,
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      const result = await proxySelfProfile(request, {
        ...options,
        publicOrigin: 'https://teacher.example.test',
        fetcher,
      });
      expect(result.status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    '',
    'not a URL',
    'null',
    'ftp://role.local',
    'http://user:pass@role.local',
    'http://role.local/path',
    'http://role.local?query=1',
    'http://role.local#fragment',
  ])(
    'fails closed for missing or invalid public origin configuration: %s',
    async (publicOrigin) => {
      const fetcher = vi.fn();
      expect(
        (await proxySelfProfile(put(form()), { ...options, publicOrigin, fetcher })).status,
      ).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(['cross-site', 'same-site', 'none'])(
    'rejects contradictory Fetch Metadata even with an allowed Origin: %s',
    async (site) => {
      const fetcher = vi.fn();
      expect(
        (await proxySelfProfile(put(form(), { 'Sec-Fetch-Site': site }), { ...options, fetcher }))
          .status,
      ).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    'null',
    'http://role.local/path',
    'http://role.local, https://evil.test',
    'http://role.local@evil.test',
  ])('rejects opaque or malformed Origin headers: %s', async (origin) => {
    const fetcher = vi.fn();
    expect(
      (await proxySelfProfile(put(form(), { Origin: origin }), { ...options, fetcher })).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns only public profile fields and keeps authorization server-side', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { ...profile, avatarUri: 'private/key', accessToken: 'secret' } }),
    );
    const result = await proxySelfProfile(new Request('http://role.local/auth/profile'), {
      ...options,
      fetcher,
    });
    expect(await result.json()).toEqual({ data: profile });
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer private-token' },
      cache: 'no-store',
      redirect: 'error',
    });
  });
  it('preserves the version string and returns sanitized conflict data', async () => {
    const newest = { ...profile, lockVersion: '9007199254740993' };
    const result = await proxySelfProfile(put(form()), {
      ...options,
      fetcher: async () =>
        Response.json(
          { message: 'profile_conflict', data: { ...newest, avatarUri: 'secret' } },
          { status: 409 },
        ),
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: 'profile_conflict', data: newest });
  });
  it.each(['username', 'accountId', 'avatarUri', 'organizationId'])(
    'rejects unknown writable %s',
    async (key) => {
      const data = form();
      data.set(key, 'injected');
      const fetcher = vi.fn();
      expect((await proxySelfProfile(put(data), { ...options, fetcher })).status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('rejects duplicate fields before forwarding', async () => {
    const data = form();
    data.append('avatarAction', 'default');
    expect((await proxySelfProfile(put(data), options)).status).toBe(400);
  });
  it('rejects cross-origin requests and missing Origin', async () => {
    expect(
      (await proxySelfProfile(put(form(), { Origin: 'https://evil.local' }), options)).status,
    ).toBe(403);
    const request = put(form());
    request.headers.delete('origin');
    expect((await proxySelfProfile(request, options)).status).toBe(403);
  });
  it('bounds streamed uploads without trusting Content-Length', async () => {
    const request = new Request('http://role.local/auth/profile', {
      method: 'PUT',
      headers: {
        Origin: 'http://role.local',
        'Content-Type': 'multipart/form-data; boundary=bound',
      },
      body: new Uint8Array(PROFILE_REQUEST_MAX_BYTES + 1),
    });
    const fetcher = vi.fn();
    expect((await proxySelfProfile(request, { ...options, fetcher })).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds metadata and rejects non-square crops', async () => {
    const data = form();
    data.set('displayName', 'a'.repeat(513));
    expect((await proxySelfProfile(put(data), options)).status).toBe(400);
    const image = form();
    image.set('avatarAction', 'replace');
    image.set('image', new Blob(['png'], { type: 'image/png' }), 'source.png');
    image.set('crop', JSON.stringify({ x: 0, y: 0, width: 300, height: 301 }));
    expect((await proxySelfProfile(put(image), options)).status).toBe(400);
  });
  it('forwards original file bytes with bounded square crop only on PUT', async () => {
    const data = form();
    data.set('avatarAction', 'replace');
    data.set('image', new Blob(['original'], { type: 'image/png' }), 'secret-name.png');
    data.set('crop', JSON.stringify({ x: 25, y: 0, width: 256, height: 256 }));
    let captured: FormData | undefined;
    const result = await proxySelfProfile(put(data), {
      ...options,
      fetcher: async (_url, init) => {
        captured = init?.body as FormData;
        return Response.json({ data: profile });
      },
    });
    expect(result.status).toBe(200);
    expect(captured?.get('displayName')).toBeNull();
    const image = captured?.get('image') as File;
    expect(await image.text()).toBe('original');
    expect(image.name).toBe('avatar');
  });
  it('serves private media without requiring an Origin and never forwards upstream metadata', async () => {
    const result = await proxySelfProfile(new Request('http://role.local/auth/profile/avatar'), {
      ...options,
      avatar: true,
      fetcher: async () =>
        new Response('webp', {
          headers: { 'Content-Type': 'image/webp', 'X-Object-Key': 'secret' },
        }),
    });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('webp');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('x-object-key')).toBeNull();
  });
  it('bounds upstream bodies and marks interrupted saves uncertain', async () => {
    const fetcher = async () => new Response(new Uint8Array(17 * 1024));
    expect(await (await proxySelfProfile(put(form()), { ...options, fetcher })).json()).toEqual({
      error: 'profile_save_uncertain',
    });
  });
  it('does not leak technical errors and propagates session expiry', async () => {
    expect(
      await (
        await proxySelfProfile(put(form()), {
          ...options,
          fetcher: async () => Response.json({ message: 'SQL password=secret' }, { status: 500 }),
        })
      ).json(),
    ).toEqual({ error: 'profile_unavailable' });
    expect(
      (
        await proxySelfProfile(new Request('http://role.local/auth/profile'), {
          ...options,
          fetcher: async () => new Response('', { status: 401 }),
        })
      ).status,
    ).toBe(401);
  });
});
