import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLink } from '../src/link.ts';
import { buildServer } from '../src/server.ts';
import { createAttribution } from '../src/service.ts';
import { MemoryStore } from '../src/store.ts';

const SECRET = 'segredo-de-exemplo';
const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-10-01T12:00:00.000Z');

const campaignUrl = buildLink({ type: 'campaign', id: 'creators-out26', channel: 'instagram' }, SECRET);
const referralUrl = buildLink({ type: 'referral', id: 'ana-7f3k' }, SECRET);

let clock: number;
let app: FastifyInstance;

beforeEach(() => {
  clock = START;
  app = buildServer(createAttribution({ store: new MemoryStore(), secret: SECRET, now: () => clock }));
});

afterEach(() => app.close());

const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, payload });

describe('POST /installs/:installId/first-open', () => {
  it('devolve o primeiro abertura e o fim da janela, e repetir não muda nada', async () => {
    const first = await post('/installs/install-1/first-open');
    clock += HOUR;
    const again = await post('/installs/install-1/first-open');

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      installId: 'install-1',
      firstOpenAt: '2026-10-01T12:00:00.000Z',
      windowEndsAt: '2026-10-08T12:00:00.000Z',
    });
    expect(again.json()).toEqual(first.json());
  });
});

describe('POST /installs/:installId/touches', () => {
  it('201 no toque novo e 200 no clique repetido, com o mesmo seq', async () => {
    const first = await post('/installs/install-1/touches', { url: campaignUrl });
    const again = await post('/installs/install-1/touches', { url: campaignUrl });

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ seq: first.json().seq, status: 'accepted', clickCount: 2 });
  });

  it('422 no link adulterado, dizendo o motivo', async () => {
    const response = await post('/installs/install-1/touches', {
      url: referralUrl.replace('ana-7f3k', 'bia-1x9z'),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ status: 'rejected', rejection: 'invalid_signature', linkId: null });
  });

  it.each([
    ['sem url', {}],
    ['url vazia', { url: '' }],
    ['deviceAt que não é data', { url: campaignUrl, deviceAt: 'ontem' }],
  ])('400 no corpo inválido: %s', async (_caso, payload) => {
    const response = await post('/installs/install-1/touches', payload);
    expect(response.statusCode).toBe(400);
  });
});

describe('relógio', () => {
  it('receivedAt enviado pelo app é descartado; vale o horário do servidor', async () => {
    const response = await post('/installs/install-1/touches', {
      url: campaignUrl,
      receivedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().receivedAt).toBe('2026-10-01T12:00:00.000Z');
  });
});

describe('POST /signups e GET /signups/:userId/attribution', () => {
  it('fluxo completo: dois links, cadastro, link depois do cadastro e auditoria', async () => {
    await post('/installs/install-1/first-open');
    clock += HOUR;
    await post('/installs/install-1/touches', { url: campaignUrl, deviceAt: '2026-10-01T10:00:00-03:00' });
    clock += HOUR;
    await post('/installs/install-1/touches', { url: referralUrl });
    clock += HOUR;

    const signup = await post('/signups', { userId: 'user-1', installId: 'install-1' });
    expect(signup.statusCode).toBe(201);
    expect(signup.json()).toMatchObject({
      userId: 'user-1',
      rule: 'last_touch_v1',
      signupAt: '2026-10-01T15:00:00.000Z',
      firstOpenAt: '2026-10-01T12:00:00.000Z',
      window: { endsAt: '2026-10-08T12:00:00.000Z' },
      origin: { kind: 'referral', id: 'ana-7f3k' },
    });

    clock += HOUR;
    await post('/installs/install-1/touches', { url: campaignUrl.replace('instagram', 'tiktok') });
    const repeated = await post('/signups', { userId: 'user-1', installId: 'install-1' });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(signup.json());

    const audit = await app.inject({ method: 'GET', url: '/signups/user-1/attribution' });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().origin).toEqual(signup.json().origin);
    expect(audit.json().touches).toMatchObject([
      {
        type: 'campaign',
        receivedAt: '2026-10-01T13:00:00.000Z',
        deviceAt: '2026-10-01T10:00:00-03:00',
        reason: 'superseded_by_later_touch',
      },
      { type: 'referral', receivedAt: '2026-10-01T14:00:00.000Z', reason: 'won' },
      { type: null, receivedAt: '2026-10-01T16:00:00.000Z', reason: 'rejected_link' },
    ]);
  });

  it('cadastro sem installId responde orgânico com motivo', async () => {
    const response = await post('/signups', { userId: 'user-1' });
    expect(response.statusCode).toBe(201);
    expect(response.json().origin).toMatchObject({ kind: 'organic', reason: 'no_install' });
  });

  it('400 no cadastro sem userId', async () => {
    const response = await post('/signups', { installId: 'install-1' });
    expect(response.statusCode).toBe(400);
  });

  it('404 na auditoria de quem não se cadastrou', async () => {
    const response = await app.inject({ method: 'GET', url: '/signups/ninguem/attribution' });
    expect(response.statusCode).toBe(404);
  });
});
