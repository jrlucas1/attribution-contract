import { beforeEach, describe, expect, it } from 'vitest';
import { buildLink } from '../src/link.ts';
import { createAttribution } from '../src/service.ts';
import type { Attribution } from '../src/service.ts';
import { MemoryStore } from '../src/store.ts';

const SECRET = 'segredo-de-exemplo';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-10-01T12:00:00.000Z');

const campaignUrl = buildLink({ type: 'campaign', id: 'creators-out26', channel: 'instagram' }, SECRET);
const referralUrl = buildLink({ type: 'referral', id: 'ana-7f3k' }, SECRET);
const forgedUrl = referralUrl.replace('ana-7f3k', 'bia-1x9z');

let clock: number;
let attribution: Attribution;

beforeEach(() => {
  clock = START;
  attribution = createAttribution({ store: new MemoryStore(), secret: SECRET, now: () => clock });
});

describe('primeiro abertura', () => {
  it('chamada repetida não move a data', async () => {
    await attribution.firstOpen('install-1');
    clock += DAY;
    const again = await attribution.firstOpen('install-1');
    expect(again.firstOpenAt).toBe(START);
  });

  it('toque que chega antes do aviso fixa o primeiro abertura', async () => {
    await attribution.touch({ installId: 'install-1', url: campaignUrl });
    clock += HOUR;
    const install = await attribution.firstOpen('install-1');
    expect(install.firstOpenAt).toBe(START);
  });
});

describe('clique repetido', () => {
  it('o mesmo link na mesma instalação é um toque só e mantém o primeiro horário', async () => {
    const first = await attribution.touch({ installId: 'install-1', url: campaignUrl });
    clock += HOUR;
    const second = await attribution.touch({ installId: 'install-1', url: campaignUrl });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.touch).toMatchObject({ seq: first.touch.seq, receivedAt: START, clickCount: 2 });

    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    expect(decision.touches).toHaveLength(1);
  });

  it('em A, B, A o reclique de A não toma a vitória de B', async () => {
    await attribution.touch({ installId: 'install-1', url: campaignUrl });
    clock += HOUR;
    await attribution.touch({ installId: 'install-1', url: referralUrl });
    clock += HOUR;
    await attribution.touch({ installId: 'install-1', url: campaignUrl });

    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    expect(decision.origin).toMatchObject({ kind: 'referral', id: 'ana-7f3k' });
    expect(decision.touches.map((verdict) => verdict.clickCount)).toEqual([2, 1]);
  });

  it('o mesmo link em outra instalação é outro toque', async () => {
    const one = await attribution.touch({ installId: 'install-1', url: campaignUrl });
    const other = await attribution.touch({ installId: 'install-2', url: campaignUrl });
    expect(other.created).toBe(true);
    expect(other.touch.seq).not.toBe(one.touch.seq);
  });
});

describe('dois links antes do cadastro', () => {
  it('recebidos no mesmo milissegundo, vence o que chegou por último', async () => {
    await attribution.touch({ installId: 'install-1', url: referralUrl });
    await attribution.touch({ installId: 'install-1', url: campaignUrl });

    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    expect(decision.origin).toMatchObject({ kind: 'campaign', id: 'creators-out26' });
    expect(decision.touches.map((verdict) => verdict.reason)).toEqual(['lost_tie_by_sequence', 'won']);
  });
});

describe('relógio', () => {
  it('horário do aparelho fica guardado mas não decide ordem nem janela', async () => {
    await attribution.touch({ installId: 'install-1', url: campaignUrl, deviceAt: '2030-01-01T00:00:00.000Z' });
    clock += HOUR;
    await attribution.touch({ installId: 'install-1', url: referralUrl, deviceAt: '2020-01-01T00:00:00.000Z' });

    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    expect(decision.origin).toMatchObject({ kind: 'referral' });
    expect(decision.touches).toMatchObject([
      { receivedAt: '2026-10-01T12:00:00.000Z', deviceAt: '2030-01-01T00:00:00.000Z' },
      { receivedAt: '2026-10-01T13:00:00.000Z', deviceAt: '2020-01-01T00:00:00.000Z' },
    ]);
  });
});

describe('link inválido', () => {
  it('fica gravado como rejeitado e aparece na decisão sem vencer', async () => {
    const { touch } = await attribution.touch({ installId: 'install-1', url: forgedUrl });
    expect(touch).toMatchObject({ rejection: 'invalid_signature', link: null });

    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_eligible_touch' });
    expect(decision.touches).toMatchObject([{ url: forgedUrl, reason: 'rejected_link' }]);
  });

  it('o mesmo link inválido repetido não duplica', async () => {
    await attribution.touch({ installId: 'install-1', url: forgedUrl });
    const again = await attribution.touch({ installId: 'install-1', url: forgedUrl });
    expect(again).toMatchObject({ created: false, touch: { clickCount: 2 } });
  });
});

describe('cadastro', () => {
  it('sem instalação fica orgânico com motivo', async () => {
    const { decision } = await attribution.signup({ userId: 'user-1' });
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_install' });
  });

  it('de instalação que nunca abriu link fica orgânico com motivo', async () => {
    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-nunca-vista' });
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_touches' });
  });

  it('a janela conta do primeiro abertura, não do toque', async () => {
    await attribution.firstOpen('install-1');
    clock += 6 * DAY;
    await attribution.touch({ installId: 'install-1', url: campaignUrl });
    clock += 2 * DAY;

    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'window_expired' });
    expect(decision.touches[0]?.reason).toBe('window_expired_before_signup');
  });

  it('repetido devolve a mesma decisão, mesmo com dados e toques novos', async () => {
    await attribution.touch({ installId: 'install-1', url: campaignUrl });
    const first = await attribution.signup({ userId: 'user-1', installId: 'install-1' });

    clock += HOUR;
    await attribution.touch({ installId: 'install-1', url: referralUrl });
    const second = await attribution.signup({ userId: 'user-1', installId: 'install-2' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.decision).toEqual(first.decision);
  });

  it('repetido não registra primeiro abertura para a instalação informada de novo', async () => {
    await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    clock += HOUR;
    await attribution.signup({ userId: 'user-1', installId: 'install-2' });
    clock += HOUR;

    const install = await attribution.firstOpen('install-2');
    expect(install.firstOpenAt).toBe(START + 2 * HOUR);
  });

  it('segundo usuário na mesma instalação não herda a origem do primeiro', async () => {
    await attribution.touch({ installId: 'install-1', url: campaignUrl });
    await attribution.signup({ userId: 'user-1', installId: 'install-1' });

    const { decision } = await attribution.signup({ userId: 'user-2', installId: 'install-1' });
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'install_already_attributed' });
  });
});

describe('auditoria', () => {
  it('não existe para usuário sem cadastro', async () => {
    expect(await attribution.audit('ninguem')).toBeUndefined();
  });

  it('mostra o link aberto depois do cadastro sem mudar a origem', async () => {
    await attribution.touch({ installId: 'install-1', url: campaignUrl });
    await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    // Mesmo milissegundo do cadastro: o que separa é ter chegado depois da decisão.
    await attribution.touch({ installId: 'install-1', url: referralUrl });

    const audit = await attribution.audit('user-1');
    expect(audit?.origin).toMatchObject({ kind: 'campaign' });
    expect(audit?.touches).toMatchObject([
      { type: 'campaign', outcome: 'won', reason: 'won' },
      { type: 'referral', outcome: 'lost', reason: 'after_signup' },
    ]);
  });

  it('consultar não altera a decisão gravada', async () => {
    await attribution.touch({ installId: 'install-1', url: campaignUrl });
    const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    await attribution.touch({ installId: 'install-1', url: referralUrl });
    await attribution.audit('user-1');

    const again = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    expect(again.decision).toEqual(decision);
  });
});
