import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { resetProviderToken } from '../src/apns';
import { issueCredential, verifyCredential } from '../src/credential';

const TOKEN = 'ab'.repeat(32);
const OTHER_TOKEN = 'cd'.repeat(32);
const SECRET = 'test-credential-secret-0123456789abcdef';

let publicKey: CryptoKey;
let pem: string;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  publicKey = pair.publicKey;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n');
  pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
});

function limiter(allow = true) {
  return { limit: vi.fn(async () => ({ success: allow })) };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    APNS_KEY_P8: pem, APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'TEAM123456', APNS_TOPIC: 'com.nebulis.app',
    CREDENTIAL_SECRET: SECRET,
    REGISTER_IP_LIMIT: limiter(), PUSH_IP_LIMIT: limiter(), PUSH_TOKEN_LIMIT: limiter(),
    ...overrides,
  };
}

interface ApnsCall { url: string; headers: Record<string, string>; body: { aps: { alert: { title: string; subtitle?: string; body: string } } } & Record<string, unknown> }
let apnsCalls: ApnsCall[];
let apnsReply: () => Response;
let logged: string[];

beforeEach(() => {
  resetProviderToken();
  apnsCalls = [];
  apnsReply = () => new Response(null, { status: 200 });
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { logged.push(String(line)); });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    apnsCalls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return apnsReply();
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const post = (path: string, body: unknown, init: RequestInit = {}) =>
  new Request(`https://push.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
    body: typeof body === 'string' ? body : JSON.stringify(body), ...init,
  });
const call = (request: Request, env = makeEnv()) => worker.fetch(request, env as never);

const message = { title: 'Clear night ahead', body: '5 h clear, best 22:00 to 03:00' };
async function registered(env = makeEnv(), token = TOKEN, apnsEnv = 'production') {
  const res = await call(post('/v1/register', { token, env: apnsEnv }), env);
  return ((await res.json()) as { credential: string }).credential;
}

describe('credential', () => {
  it('verifies the one it issued and nothing else', async () => {
    const c = await issueCredential(SECRET, 'production', TOKEN);
    expect(await verifyCredential(SECRET, 'production', TOKEN, c)).toBe(true);
    expect(await verifyCredential(SECRET, 'production', TOKEN.toUpperCase(), c)).toBe(true);
    expect(await verifyCredential(SECRET, 'sandbox', TOKEN, c)).toBe(false);
    expect(await verifyCredential(SECRET, 'production', OTHER_TOKEN, c)).toBe(false);
    expect(await verifyCredential('another-secret-0123456789abcdef0123', 'production', TOKEN, c)).toBe(false);
    for (const bad of ['', 'v1.', 'v2.' + c.slice(3), c + 'x', c + '.extra', 'v1.!!!', c.slice(0, -2)]) {
      expect(await verifyCredential(SECRET, 'production', TOKEN, bad)).toBe(false);
    }
  });
});

describe('register', () => {
  it('sends Apple a real notification, then issues a credential that works', async () => {
    const res = await call(post('/v1/register', { token: TOKEN, env: 'production', title: 'Nebulis alerts', body: 'Alerts are on.' }));
    expect(res.status).toBe(200);
    const { credential } = (await res.json()) as { credential: string };
    expect(await verifyCredential(SECRET, 'production', TOKEN, credential)).toBe(true);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0]!.url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
    expect(apnsCalls[0]!.headers['apns-topic']).toBe('com.nebulis.app');
    expect(apnsCalls[0]!.headers['apns-push-type']).toBe('alert');
    expect(apnsCalls[0]!.headers['apns-priority']).toBe('10');
    expect(apnsCalls[0]!.body.aps.alert).toEqual({ title: 'Nebulis alerts', body: 'Alerts are on.' });
  });

  it('checks the token silently when no text is given, so the app can renew its credential without a buzz', async () => {
    const res = await call(post('/v1/register', { token: TOKEN, env: 'production' }));
    expect(res.status).toBe(200);
    expect(apnsCalls[0]!.headers['apns-push-type']).toBe('background');
    expect(apnsCalls[0]!.headers['apns-priority']).toBe('5');
    expect(apnsCalls[0]!.body).toEqual({ aps: { 'content-available': 1 } });
    // Half a notification is a mistake, not a silent check.
    expect((await call(post('/v1/register', { token: TOKEN, env: 'production', title: 'Only a title' }))).status).toBe(400);
  });

  it('refuses a token Apple says is not real, and issues nothing', async () => {
    apnsReply = () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 });
    const res = await call(post('/v1/register', { token: TOKEN, env: 'production' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('uses the sandbox host only when asked', async () => {
    await call(post('/v1/register', { token: TOKEN, env: 'sandbox' }));
    expect(apnsCalls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
  });

  it('is throttled per address before it reaches Apple', async () => {
    const res = await call(post('/v1/register', { token: TOKEN, env: 'production' }), makeEnv({ REGISTER_IP_LIMIT: limiter(false) }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(apnsCalls).toHaveLength(0);
  });

  it('rejects malformed input without contacting Apple', async () => {
    for (const body of [{}, { token: 'short', env: 'production' }, { token: TOKEN }, { token: TOKEN, env: 'staging' }, { token: 'zz'.repeat(32), env: 'production' }]) {
      expect((await call(post('/v1/register', body))).status).toBe(400);
    }
    expect(apnsCalls).toHaveLength(0);
  });
});

describe('push', () => {
  it('delivers with the right headers and payload', async () => {
    const credential = await registered();
    apnsCalls = [];
    const res = await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message, link: 'nebulis://planner', threadId: 'clear-night', collapseId: 'night.clear', ttlSeconds: 7200 }));
    expect(res.status).toBe(200);
    const [sent] = apnsCalls;
    expect(Math.abs(Number(sent!.headers['apns-expiration']) - (Math.floor(Date.now() / 1000) + 7200))).toBeLessThanOrEqual(2);
    expect(sent!.headers['apns-collapse-id']).toBe('night.clear');
    expect(sent!.headers['apns-topic']).toBe('com.nebulis.app');
    expect(sent!.body).toEqual({ aps: { alert: message, sound: 'default', 'thread-id': 'clear-night' }, link: 'nebulis://planner' });
  });

  it('refuses a missing, wrong, other-token or other-environment credential, and never contacts Apple', async () => {
    const credential = await registered();
    apnsCalls = [];
    const attempts = [
      { token: TOKEN, env: 'production', credential: 'v1.AAAA', ...message },
      { token: OTHER_TOKEN, env: 'production', credential, ...message },
      { token: TOKEN, env: 'sandbox', credential, ...message },
    ];
    for (const a of attempts) expect((await call(post('/v1/push', a))).status).toBe(403);
    expect((await call(post('/v1/push', { token: TOKEN, env: 'production', ...message }))).status).toBe(400);
    expect(apnsCalls).toHaveLength(0);
  });

  it('tells the caller to forget a token Apple says is gone', async () => {
    const credential = await registered();
    apnsReply = () => new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 });
    const res = await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message }));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'unregistered' });
  });

  it('reports Apple being busy as retryable, and our own key trouble as a plain relay error', async () => {
    const credential = await registered();
    apnsReply = () => new Response(JSON.stringify({ reason: 'TooManyRequests' }), { status: 429 });
    const busy = await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message }));
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('30');

    apnsReply = () => new Response(JSON.stringify({ reason: 'TopicDisallowed' }), { status: 400 });
    const broken = await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message }));
    expect(broken.status).toBe(502);
    expect(await broken.json()).toEqual({ error: 'relay_error' });
  });

  it('is throttled per address and per token', async () => {
    const credential = await registered();
    const body = { token: TOKEN, env: 'production', credential, ...message };
    expect((await call(post('/v1/push', body), makeEnv({ PUSH_IP_LIMIT: limiter(false) }))).status).toBe(429);
    expect((await call(post('/v1/push', body), makeEnv({ PUSH_TOKEN_LIMIT: limiter(false) }))).status).toBe(429);
  });

  it('keeps the throttle key for a token to a hash, never the token', async () => {
    const credential = await registered();
    const tokenLimit = limiter();
    await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message }), makeEnv({ PUSH_TOKEN_LIMIT: tokenLimit }));
    const key = (tokenLimit.limit.mock.calls[0] as unknown as [{ key: string }])[0].key;
    expect(key).toMatch(/^tok:[0-9a-f]{64}$/);
    expect(key).not.toContain(TOKEN);
  });

  it('only lets a link open Nebulis, and rejects bad ids and lifetimes', async () => {
    const credential = await registered();
    const base = { token: TOKEN, env: 'production', credential, ...message };
    for (const bad of [{ link: 'https://evil.example' }, { link: 'javascript:alert(1)' }, { link: 'nebulis://ok\nfoo' }, { threadId: 'a b' }, { collapseId: 'x'.repeat(65) }, { ttlSeconds: 10 }, { ttlSeconds: 90000 }, { ttlSeconds: 'soon' }]) {
      expect((await call(post('/v1/push', { ...base, ...bad }))).status).toBe(400);
    }
    expect(apnsCalls.filter(c => c.url.includes('/3/device/')).length).toBe(1); // only the registration
  });

  it('strips control characters and rejects over-long or empty text', async () => {
    const credential = await registered();
    apnsCalls = [];
    await call(post('/v1/push', { token: TOKEN, env: 'production', credential, title: 'Hi\u0007\u0000 there', body: 'line one\nline two' }));
    expect(apnsCalls[0]!.body.aps.alert).toEqual({ title: 'Hi there', body: 'line one\nline two' });
    for (const bad of [{ title: 'x'.repeat(101) }, { body: 'y'.repeat(301) }, { title: '   ' }, { body: 5 }]) {
      expect((await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message, ...bad }))).status).toBe(400);
    }
  });

  it('passes a subtitle through to the phone, and an older server that sends none changes nothing', async () => {
    const credential = await registered();
    apnsCalls = [];
    expect((await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message, subtitle: 'Clear all night, 19:32 to 05:34' }))).status).toBe(200);
    expect(apnsCalls[0]!.body.aps.alert).toEqual({ title: message.title, subtitle: 'Clear all night, 19:32 to 05:34', body: message.body });
    apnsCalls = [];
    await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message }));
    expect(apnsCalls[0]!.body.aps.alert).toEqual({ title: message.title, body: message.body });
    expect('subtitle' in apnsCalls[0]!.body.aps.alert).toBe(false);
  });

  it('refuses a subtitle that is too long or not text, and treats a blank one as none', async () => {
    const credential = await registered();
    apnsCalls = [];
    for (const bad of [{ subtitle: 'x'.repeat(101) }, { subtitle: 5 }]) {
      expect((await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message, ...bad }))).status).toBe(400);
    }
    expect((await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message, subtitle: '   ' }))).status).toBe(200);
    expect('subtitle' in apnsCalls[0]!.body.aps.alert).toBe(false);
  });
});

describe('the request itself', () => {
  it('refuses the wrong method, an unknown path, the wrong type, bad JSON and a big body', async () => {
    expect((await call(new Request('https://push.example/v1/push'))).status).toBe(405);
    expect((await call(new Request('https://push.example/v1/register', { method: 'DELETE' }))).status).toBe(405);
    expect((await call(new Request('https://push.example/nope'))).status).toBe(404);
    expect((await call(post('/v1/push', 'x', { headers: { 'content-type': 'text/plain' } }))).status).toBe(415);
    expect((await call(post('/v1/push', '{not json'))).status).toBe(400);
    expect((await call(post('/v1/push', '[1,2]'))).status).toBe(400);
    const big = await call(post('/v1/push', JSON.stringify({ pad: 'x'.repeat(5000) })));
    expect(big.status).toBe(413);
    expect(apnsCalls).toHaveLength(0);
  });

  it('stops reading a body that lies about its size', async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":"' + 'x'.repeat(6000))); c.close(); } });
    const res = await call(new Request('https://push.example/v1/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(413);
  });

  it('refuses plain http without reading the body, redirecting only a GET, and allows http on this machine', async () => {
    const plain = (path: string, init: RequestInit = {}) => new Request(`http://push.example${path}`, init);
    const redirected = await call(plain('/health'));
    expect(redirected.status).toBe(308);
    expect(redirected.headers.get('location')).toBe('https://push.example/health');

    const refused = await call(plain('/v1/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, env: 'production', credential: 'v1.x', ...message }) }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'https_required' });
    expect(apnsCalls).toHaveLength(0);

    expect((await call(new Request('http://localhost:8787/health'))).status).toBe(200);
  });

  it('tells browsers to stay on https', async () => {
    const res = await call(new Request('https://push.example/health'));
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('answers health and sets no CORS headers', async () => {
    const res = await call(new Request('https://push.example/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Apple provider token', () => {
  it('is a valid ES256 JWT for our key and team, reused, and minted fresh when Apple calls it stale', async () => {
    await registered();
    await registered(makeEnv(), OTHER_TOKEN);
    const auths = apnsCalls.map(c => c.headers.authorization);
    expect(auths[0]).toBe(auths[1]);

    const jwt = auths[0]!.replace('bearer ', '');
    const [h, c, s] = jwt.split('.') as [string, string, string];
    const decode = (x: string) => JSON.parse(atob(x.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decode(h)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(decode(c).iss).toBe('TEAM123456');
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), ch => ch.charCodeAt(0));
    expect(sig.byteLength).toBe(64);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(`${h}.${c}`))).toBe(true);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5000);
      let first = true;
      apnsReply = () => { if (first) { first = false; return new Response(JSON.stringify({ reason: 'ExpiredProviderToken' }), { status: 403 }); } return new Response(null, { status: 200 }); };
      apnsCalls = [];
      const credential = await issueCredential(SECRET, 'production', TOKEN);
      const res = await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message }));
      expect(res.status).toBe(200);
      expect(apnsCalls).toHaveLength(2);
      expect(apnsCalls[1]!.headers.authorization).not.toBe(apnsCalls[0]!.headers.authorization);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is minted again after 40 minutes', async () => {
    const realNow = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(realNow);
      await registered();
      vi.setSystemTime(realNow + 41 * 60 * 1000);
      await registered(makeEnv(), OTHER_TOKEN);
      expect(apnsCalls[0]!.headers.authorization).not.toBe(apnsCalls[1]!.headers.authorization);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a key that will not load as a relay error, not as a bad token', async () => {
    const res = await call(post('/v1/register', { token: TOKEN, env: 'production' }), makeEnv({ APNS_KEY_P8: 'not a key' }));
    expect(res.status).toBe(502);
    expect(apnsCalls).toHaveLength(0);
  });
});

describe('what never leaks', () => {
  it('keeps tokens, credentials, message text and the key out of every log line and response', async () => {
    const credential = await registered();
    const responses: string[] = [];
    for (const reply of [() => new Response(null, { status: 200 }), () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }), () => new Response(JSON.stringify({ reason: 'TopicDisallowed' }), { status: 400 })]) {
      apnsReply = reply;
      const res = await call(post('/v1/push', { token: TOKEN, env: 'production', credential, ...message }));
      responses.push(await res.text());
    }
    responses.push(await (await call(post('/v1/push', { token: TOKEN, env: 'production', credential: 'v1.bad', ...message }))).text());
    const everything = [...logged, ...responses].join('\n');
    for (const secret of [TOKEN, credential, message.title, message.body, SECRET, 'PRIVATE KEY', 'KEY1234567', 'TEAM123456']) {
      expect(everything).not.toContain(secret);
    }
    expect(logged.length).toBeGreaterThan(0);
  });
});
