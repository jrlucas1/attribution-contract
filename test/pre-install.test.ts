import { describe, expect, it } from 'vitest';
import { DEFAULT_PRE_INSTALL_WINDOW_MS, decide } from '../src/attribution.ts';
import type { Touch } from '../src/attribution.ts';
import { buildLink } from '../src/link.ts';
import { buildServer } from '../src/server.ts';
import { createAttribution } from '../src/service.ts';
import { STORES } from './stores.ts';

const SECRET = 'segredo-de-exemplo';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-10-01T12:00:00.000Z');

const campaignUrl = buildLink({ type: 'campaign', id: 'creators-out26', channel: 'instagram' }, SECRET);
const referralUrl = buildLink({ type: 'referral', id: 'ana-7f3k' }, SECRET);
const forgedUrl = referralUrl.replace('ana-7f3k', 'bia-1x9z');

describe('regra: clique antes do primeiro abertura', () => {
  const FIRST_OPEN = START;
  const WINDOW = 7 * DAY;
  const PRE_INSTALL = 24 * HOUR;

  const touchAt = (seq: number, receivedAt: number, preInstall?: boolean): Touch => ({
    seq,
    installId: 'install-1',
    dedupeKey: `link-${seq}`,
    url: campaignUrl,
    link: { type: 'campaign', id: `campanha-${seq}`, linkId: `link-${seq}` },
    rejection: null,
    receivedAt,
    deviceAt: null,
    clickCount: 1,
    ...(preInstall ? { preInstall } : {}),
  });

  const decideWith = (touches: Touch[], signupAt = FIRST_OPEN + HOUR) =>
    decide({
      userId: 'user-1',
      installId: 'install-1',
      firstOpenAt: FIRST_OPEN,
      signupAt,
      windowMs: WINDOW,
      preInstallWindowMs: PRE_INSTALL,
      touches,
    });

  it('a janela de pré-instalação padrão é de 24 horas', () => {
    expect(DEFAULT_PRE_INSTALL_WINDOW_MS).toBe(24 * HOUR);
  });

  it('a decisão grava a janela de pré-instalação, que termina no primeiro abertura', () => {
    const decision = decideWith([]);

    expect(decision.preInstallWindow).toEqual({
      durationMs: PRE_INSTALL,
      startsAt: '2026-09-30T12:00:00.000Z',
      endsAt: '2026-10-01T12:00:00.000Z',
    });
    // A janela principal continua contando do primeiro abertura.
    expect(decision.window).toMatchObject({ startsAt: '2026-10-01T12:00:00.000Z', endsAt: '2026-10-08T12:00:00.000Z' });
  });

  it('cadastro sem instalação não tem janela de pré-instalação', () => {
    const decision = decide({ userId: 'user-1', installId: null, firstOpenAt: null, signupAt: START, windowMs: WINDOW, touches: [] });

    expect(decision.preInstallWindow).toBeNull();
  });

  it('clique dentro da janela de pré-instalação vence', () => {
    const decision = decideWith([touchAt(1, FIRST_OPEN - HOUR, true)]);

    expect(decision.origin).toMatchObject({ kind: 'campaign', id: 'campanha-1', touchSeq: 1 });
    expect(decision.touches[0]).toMatchObject({ outcome: 'won', reason: 'won', preInstall: true });
  });

  it('limites: clique no início exato da janela vale; um milissegundo antes, não', () => {
    const atStart = decideWith([touchAt(1, FIRST_OPEN - PRE_INSTALL, true)]);
    const tooOld = decideWith([touchAt(1, FIRST_OPEN - PRE_INSTALL - 1, true)]);

    expect(atStart.origin).toMatchObject({ kind: 'campaign' });
    expect(tooOld.origin).toMatchObject({ kind: 'organic', reason: 'no_eligible_touch' });
    expect(tooOld.touches[0]).toMatchObject({ outcome: 'lost', reason: 'pre_install_click_too_old', preInstall: true });
    expect(tooOld.touches[0]?.detail).toContain('janela de pré-instalação');
  });

  it('clique um milissegundo antes do primeiro abertura vale', () => {
    const decision = decideWith([touchAt(1, FIRST_OPEN - 1, true)]);

    expect(decision.origin).toMatchObject({ kind: 'campaign' });
  });

  it('toque comum com horário anterior ao primeiro abertura continua fora da janela', () => {
    const decision = decideWith([touchAt(1, FIRST_OPEN - HOUR)]);

    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_eligible_touch' });
    expect(decision.touches[0]).toMatchObject({ reason: 'outside_window', preInstall: false });
  });

  it('toque dentro do app, mais recente, vence o clique de antes da instalação', () => {
    const decision = decideWith([touchAt(1, FIRST_OPEN + 1), touchAt(2, FIRST_OPEN - HOUR, true)]);

    expect(decision.origin).toMatchObject({ id: 'campanha-1' });
    expect(decision.touches.map((verdict) => verdict.reason)).toEqual(['won', 'superseded_by_later_touch']);
  });

  it('entre dois cliques de antes da instalação vence o mais recente', () => {
    const decision = decideWith([touchAt(1, FIRST_OPEN - HOUR, true), touchAt(2, FIRST_OPEN - 2 * HOUR, true)]);

    expect(decision.origin).toMatchObject({ id: 'campanha-1' });
  });

  it('clique de antes da instalação também perde quando o cadastro passa da janela principal', () => {
    const decision = decideWith([touchAt(1, FIRST_OPEN - HOUR, true)], FIRST_OPEN + WINDOW + 1);

    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'window_expired' });
    expect(decision.touches[0]?.reason).toBe('window_expired_before_signup');
  });

  it('sem preInstallWindowMs usa o padrão', () => {
    const decision = decide({
      userId: 'user-1',
      installId: 'install-1',
      firstOpenAt: FIRST_OPEN,
      signupAt: FIRST_OPEN,
      windowMs: WINDOW,
      touches: [touchAt(1, FIRST_OPEN - DEFAULT_PRE_INSTALL_WINDOW_MS, true)],
    });

    expect(decision.preInstallWindow?.durationMs).toBe(DEFAULT_PRE_INSTALL_WINDOW_MS);
    expect(decision.origin).toMatchObject({ kind: 'campaign' });
  });
});

describe.each(STORES)('clique, loja, instalar (%s)', (_name, openStore) => {
  function setup() {
    let clock = START;
    const store = openStore();
    const attribution = createAttribution({ store, secret: SECRET, now: () => clock });
    return {
      store,
      attribution,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('o clique resgatado no primeiro abertura dá a origem do cadastro, com o horário do clique', async () => {
    const { attribution, advance } = setup();
    const click = await attribution.click({ url: campaignUrl });
    advance(2 * HOUR);

    const install = await attribution.firstOpen('install-1', click.clickId);
    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });

    expect(click.clickedAt).toBe(START);
    expect(install).toMatchObject({ firstOpenAt: START + 2 * HOUR, preInstallClick: 'redeemed' });
    expect(decision.origin).toMatchObject({ kind: 'campaign', id: 'creators-out26', channel: 'instagram' });
    expect(decision.touches).toMatchObject([
      { receivedAt: '2026-10-01T12:00:00.000Z', preInstall: true, outcome: 'won' },
    ]);
    expect(decision.firstOpenAt).toBe('2026-10-01T14:00:00.000Z');
  });

  it('clique mais velho que a janela de pré-instalação fica gravado mas não dá origem', async () => {
    const { attribution, advance } = setup();
    const click = await attribution.click({ url: campaignUrl });
    advance(DAY + 1);

    await attribution.firstOpen('install-1', click.clickId);
    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });

    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_eligible_touch' });
    expect(decision.touches).toMatchObject([{ reason: 'pre_install_click_too_old' }]);
  });

  it('a janela de pré-instalação é configurável', async () => {
    let clock = START;
    const attribution = createAttribution({
      store: openStore(),
      secret: SECRET,
      now: () => clock,
      preInstallWindowMs: HOUR,
    });
    const click = await attribution.click({ url: campaignUrl });
    clock += HOUR + 1;

    await attribution.firstOpen('install-1', click.clickId);
    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });

    expect(decision.preInstallWindow?.durationMs).toBe(HOUR);
    expect(decision.origin).toMatchObject({ kind: 'organic' });
  });

  it('link aberto dentro do app depois vence o clique de antes da instalação', async () => {
    const { attribution, advance } = setup();
    const click = await attribution.click({ url: campaignUrl });
    advance(HOUR);
    await attribution.firstOpen('install-1', click.clickId);
    advance(HOUR);
    await attribution.touch({ installId: 'install-1', url: referralUrl });

    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });

    expect(decision.origin).toMatchObject({ kind: 'referral', id: 'ana-7f3k' });
    expect(decision.touches.map((verdict) => verdict.reason)).toEqual(['superseded_by_later_touch', 'won']);
  });

  it('clickId desconhecido não cria toque e o primeiro abertura vale do mesmo jeito', async () => {
    const { store, attribution } = setup();

    const install = await attribution.firstOpen('install-1', 'nao-existe');

    expect(install).toMatchObject({ firstOpenAt: START, preInstallClick: 'not_redeemed' });
    expect(await store.listTouches('install-1')).toEqual([]);
  });

  it('primeiro abertura sem clickId não resgata nada', async () => {
    const { store, attribution } = setup();
    await attribution.click({ url: campaignUrl });

    const install = await attribution.firstOpen('install-1');

    expect(install.preInstallClick).toBeNull();
    expect(await store.listTouches('install-1')).toEqual([]);
  });

  it('um clique só pode ser resgatado por uma instalação', async () => {
    const { store, attribution, advance } = setup();
    const click = await attribution.click({ url: campaignUrl });
    advance(HOUR);

    const first = await attribution.firstOpen('install-1', click.clickId);
    const second = await attribution.firstOpen('install-2', click.clickId);

    expect(first.preInstallClick).toBe('redeemed');
    expect(second.preInstallClick).toBe('not_redeemed');
    expect(await store.listTouches('install-2')).toEqual([]);
  });

  it('duas instalações resgatando o mesmo clique ao mesmo tempo: só uma leva', async () => {
    const { attribution, advance } = setup();
    const click = await attribution.click({ url: campaignUrl });
    advance(HOUR);

    const results = await Promise.all([
      attribution.firstOpen('install-1', click.clickId),
      attribution.firstOpen('install-2', click.clickId),
    ]);

    expect(results.map((install) => install.preInstallClick).sort()).toEqual(['not_redeemed', 'redeemed']);
  });

  it('primeiro abertura repetido com o mesmo clickId não conta o clique de novo nem move a data', async () => {
    const { store, attribution, advance } = setup();
    const click = await attribution.click({ url: campaignUrl });
    advance(HOUR);
    await attribution.firstOpen('install-1', click.clickId);
    advance(HOUR);

    const again = await attribution.firstOpen('install-1', click.clickId);

    expect(again.firstOpenAt).toBe(START + HOUR);
    expect(await store.listTouches('install-1')).toMatchObject([{ clickCount: 1, receivedAt: START }]);
  });

  it('link adulterado clicado antes da instalação fica gravado como rejeitado', async () => {
    const { attribution, advance } = setup();
    const click = await attribution.click({ url: forgedUrl });
    advance(HOUR);
    await attribution.firstOpen('install-1', click.clickId);

    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });

    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_eligible_touch' });
    expect(decision.touches).toMatchObject([{ reason: 'rejected_link', url: forgedUrl }]);
  });

  it('clique feito depois do primeiro abertura entra como toque comum', async () => {
    const { attribution, advance } = setup();
    await attribution.firstOpen('install-1');
    advance(HOUR);
    const click = await attribution.click({ url: campaignUrl });
    advance(HOUR);

    await attribution.firstOpen('install-1', click.clickId);
    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });

    expect(decision.origin).toMatchObject({ kind: 'campaign' });
    expect(decision.touches).toMatchObject([{ preInstall: false, receivedAt: '2026-10-01T13:00:00.000Z' }]);
  });

  it('cada clique no mesmo link tem um clickId diferente', async () => {
    const { attribution } = setup();

    const one = await attribution.click({ url: campaignUrl });
    const other = await attribution.click({ url: campaignUrl });

    expect(one.clickId).not.toBe(other.clickId);
  });
});

describe('API do clique de antes da instalação', () => {
  function start() {
    let clock = START;
    const [, openStore] = STORES[0]!;
    const app = buildServer(createAttribution({ store: openStore(), secret: SECRET, now: () => clock }));
    const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
    return { post, advance: (ms: number) => (clock += ms) };
  }

  it('POST /clicks devolve o clickId e até quando o primeiro abertura precisa acontecer', async () => {
    const { post } = start();

    const response = await post('/clicks', { url: campaignUrl });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      clickId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      clickedAt: '2026-10-01T12:00:00.000Z',
      redeemableUntil: '2026-10-02T12:00:00.000Z',
    });
  });

  it('first-open com clickId resgata o clique e o cadastro sai com a origem', async () => {
    const { post, advance } = start();
    const { clickId } = (await post('/clicks', { url: campaignUrl })).json();
    advance(HOUR);

    const firstOpen = await post('/installs/install-1/first-open', { clickId });
    const signup = await post('/signups', { userId: 'user-1', installId: 'install-1' });

    expect(firstOpen.statusCode).toBe(200);
    expect(firstOpen.json()).toEqual({
      installId: 'install-1',
      firstOpenAt: '2026-10-01T13:00:00.000Z',
      windowEndsAt: '2026-10-08T13:00:00.000Z',
      preInstallClick: 'redeemed',
    });
    expect(signup.json()).toMatchObject({
      origin: { kind: 'campaign', id: 'creators-out26' },
      preInstallWindow: { durationMs: 24 * HOUR, endsAt: '2026-10-01T13:00:00.000Z' },
    });
  });

  it('first-open com clickId desconhecido responde 200 e diz que não resgatou', async () => {
    const { post } = start();

    const response = await post('/installs/install-1/first-open', { clickId: 'nao-existe' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ preInstallClick: 'not_redeemed' });
  });

  it.each([
    ['clickId que não é texto', { clickId: 42 }],
    ['clickId vazio', { clickId: '' }],
    ['clickId longo demais', { clickId: 'x'.repeat(101) }],
    ['campo desconhecido', { clickId: 'abc', outro: 1 }],
  ])('first-open recusa %s com 400 e não registra a instalação', async (_name, payload) => {
    const { post, advance } = start();

    const response = await post('/installs/install-1/first-open', payload);
    advance(HOUR);
    const later = await post('/installs/install-1/first-open');

    expect(response.statusCode).toBe(400);
    expect(later.json().firstOpenAt).toBe('2026-10-01T13:00:00.000Z');
  });

  it.each([
    ['sem url', {}],
    ['url vazia', { url: '' }],
    ['url longa demais', { url: `https://conty.app/l?${'x'.repeat(2048)}` }],
    ['url que não é texto', { url: 42 }],
  ])('POST /clicks recusa %s com 400', async (_name, payload) => {
    const { post } = start();

    expect((await post('/clicks', payload)).statusCode).toBe(400);
  });
});
