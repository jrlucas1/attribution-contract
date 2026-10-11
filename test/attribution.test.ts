import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_MS, decide } from '../src/attribution.ts';
import type { DecideInput, Touch } from '../src/attribution.ts';
import { linkIdOf } from '../src/link.ts';
import type { LinkFields } from '../src/link.ts';

const HOUR = 60 * 60 * 1000;
const FIRST_OPEN = Date.parse('2026-10-01T12:00:00.000Z');
const WINDOW_END = FIRST_OPEN + DEFAULT_WINDOW_MS;

const campaign: LinkFields = { type: 'campaign', id: 'creators-out26', channel: 'instagram' };
const referral: LinkFields = { type: 'referral', id: 'ana-7f3k' };

function touch(seq: number, fields: LinkFields, receivedAt: number): Touch {
  const linkId = linkIdOf(fields);
  return {
    seq,
    installId: 'install-1',
    dedupeKey: linkId,
    url: `https://conty.app/l?seq=${seq}`,
    link: { ...fields, linkId },
    rejection: null,
    receivedAt,
    deviceAt: null,
    clickCount: 1,
  };
}

function rejected(seq: number, receivedAt: number): Touch {
  return { ...touch(seq, referral, receivedAt), link: null, rejection: 'invalid_signature' };
}

function input(overrides: Partial<DecideInput>): DecideInput {
  return {
    userId: 'user-1',
    installId: 'install-1',
    firstOpenAt: FIRST_OPEN,
    signupAt: FIRST_OPEN + 3 * HOUR,
    windowMs: DEFAULT_WINDOW_MS,
    touches: [],
    ...overrides,
  };
}

const reasons = (decision: ReturnType<typeof decide>) => decision.touches.map((verdict) => verdict.reason);

describe('quem vence', () => {
  it('um toque elegível vence e vira a origem', () => {
    const decision = decide(input({ touches: [touch(1, campaign, FIRST_OPEN)] }));
    expect(decision.origin).toEqual({
      kind: 'campaign',
      id: 'creators-out26',
      channel: 'instagram',
      linkId: linkIdOf(campaign),
      touchSeq: 1,
    });
    expect(decision.touches[0]).toMatchObject({ outcome: 'won', reason: 'won' });
  });

  it('com dois links, vence o último e o outro registra por que perdeu', () => {
    const decision = decide(
      input({ touches: [touch(1, campaign, FIRST_OPEN), touch(2, referral, FIRST_OPEN + HOUR)] }),
    );
    expect(decision.origin).toMatchObject({ kind: 'referral', id: 'ana-7f3k', touchSeq: 2 });
    expect(reasons(decision)).toEqual(['superseded_by_later_touch', 'won']);
    expect(decision.touches[0]?.detail).toContain('seq 2');
  });

  it('o horário manda, não a ordem em que os toques foram listados', () => {
    const decision = decide(
      input({ touches: [touch(2, referral, FIRST_OPEN + HOUR), touch(1, campaign, FIRST_OPEN)] }),
    );
    expect(decision.origin).toMatchObject({ kind: 'referral', touchSeq: 2 });
  });

  it('em empate de horário vence a maior sequência de recebimento', () => {
    const sameInstant = FIRST_OPEN + HOUR;
    const decision = decide(
      input({ touches: [touch(7, referral, sameInstant), touch(8, campaign, sameInstant)] }),
    );
    expect(decision.origin).toMatchObject({ kind: 'campaign', touchSeq: 8 });
    expect(reasons(decision)).toEqual(['lost_tie_by_sequence', 'won']);
  });

  it('o empate dá o mesmo resultado com os toques em outra ordem', () => {
    const sameInstant = FIRST_OPEN + HOUR;
    const decision = decide(
      input({ touches: [touch(8, campaign, sameInstant), touch(7, referral, sameInstant)] }),
    );
    expect(decision.origin).toMatchObject({ kind: 'campaign', touchSeq: 8 });
    expect(reasons(decision)).toEqual(['won', 'lost_tie_by_sequence']);
  });

  it('sequência maior não vence horário mais recente', () => {
    const decision = decide(
      input({ touches: [touch(9, campaign, FIRST_OPEN), touch(3, referral, FIRST_OPEN + HOUR)] }),
    );
    expect(decision.origin).toMatchObject({ kind: 'referral', touchSeq: 3 });
  });
});

describe('janela contada do primeiro abertura', () => {
  it('deixa a janela usada explícita na decisão', () => {
    const decision = decide(input({}));
    expect(decision.window).toEqual({
      durationMs: DEFAULT_WINDOW_MS,
      startsAt: '2026-10-01T12:00:00.000Z',
      endsAt: '2026-10-08T12:00:00.000Z',
    });
  });

  it('cadastro exatamente no fim da janela ainda recebe a origem', () => {
    const decision = decide(input({ signupAt: WINDOW_END, touches: [touch(1, campaign, WINDOW_END)] }));
    expect(decision.origin).toMatchObject({ kind: 'campaign' });
  });

  it('cadastro 1 ms depois do fim sai orgânico por janela expirada', () => {
    const decision = decide(input({ signupAt: WINDOW_END + 1, touches: [touch(1, campaign, FIRST_OPEN)] }));
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'window_expired' });
    expect(reasons(decision)).toEqual(['window_expired_before_signup']);
  });

  it('toque recebido depois do fim da janela não vence', () => {
    const decision = decide(
      input({ signupAt: WINDOW_END + HOUR, touches: [touch(1, campaign, WINDOW_END + 1)] }),
    );
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'window_expired' });
    expect(reasons(decision)).toEqual(['outside_window']);
  });

  it('toque anterior ao primeiro abertura não vence', () => {
    const decision = decide(input({ touches: [touch(1, campaign, FIRST_OPEN - 1)] }));
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_eligible_touch' });
    expect(reasons(decision)).toEqual(['outside_window']);
  });

  it('a janela é parâmetro: com 1 hora, cadastro em 3 horas já expirou', () => {
    const decision = decide(input({ windowMs: HOUR, touches: [touch(1, campaign, FIRST_OPEN)] }));
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'window_expired' });
    expect(decision.window?.endsAt).toBe('2026-10-01T13:00:00.000Z');
  });
});

describe('toques que nunca vencem', () => {
  it('toque posterior ao cadastro perde para o anterior', () => {
    const signupAt = FIRST_OPEN + 3 * HOUR;
    const decision = decide(
      input({ signupAt, touches: [touch(1, campaign, FIRST_OPEN), touch(2, referral, signupAt + 1)] }),
    );
    expect(decision.origin).toMatchObject({ kind: 'campaign', touchSeq: 1 });
    expect(reasons(decision)).toEqual(['won', 'after_signup']);
  });

  it('toque no mesmo instante do cadastro conta', () => {
    const signupAt = FIRST_OPEN + 3 * HOUR;
    const decision = decide(input({ signupAt, touches: [touch(1, campaign, signupAt)] }));
    expect(decision.origin).toMatchObject({ kind: 'campaign' });
  });

  it('link rejeitado não vence nem sendo o mais recente', () => {
    const decision = decide(
      input({ touches: [touch(1, campaign, FIRST_OPEN), rejected(2, FIRST_OPEN + HOUR)] }),
    );
    expect(decision.origin).toMatchObject({ kind: 'campaign', touchSeq: 1 });
    expect(reasons(decision)).toEqual(['won', 'rejected_link']);
    expect(decision.touches[1]?.detail).toContain('invalid_signature');
  });

  it('instalação já usada em outro cadastro não gera segunda origem', () => {
    const decision = decide(
      input({ installAlreadyAttributed: true, touches: [touch(1, campaign, FIRST_OPEN)] }),
    );
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'install_already_attributed' });
    expect(reasons(decision)).toEqual(['install_already_attributed']);
  });
});

describe('orgânico sempre com motivo', () => {
  it('sem instalação', () => {
    const decision = decide(input({ installId: null, firstOpenAt: null }));
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_install' });
    expect(decision.window).toBeNull();
  });

  it('sem nenhum toque', () => {
    const decision = decide(input({}));
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_touches' });
    expect(decision.origin).toHaveProperty('detail');
  });

  it('só com toques rejeitados', () => {
    const decision = decide(input({ touches: [rejected(1, FIRST_OPEN)] }));
    expect(decision.origin).toMatchObject({ kind: 'organic', reason: 'no_eligible_touch' });
  });
});
