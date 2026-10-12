import type { LinkFields, LinkRejection } from './link.ts';

export const RULE = 'last_touch_v1';
export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Um link aberto por uma instalação. Horários em epoch ms, relógio do servidor. */
export interface Touch {
  /** Ordem de recebimento no servidor; desempata horários iguais. */
  seq: number;
  installId: string;
  /** Com installId, identifica "o mesmo clique". */
  dedupeKey: string;
  url: string;
  link: (LinkFields & { linkId: string }) | null;
  rejection: LinkRejection | null;
  receivedAt: number;
  /** Horário informado pelo aparelho. Só auditoria, nunca decide. */
  deviceAt: string | null;
  clickCount: number;
}

export type TouchReason =
  | 'won'
  | 'superseded_by_later_touch'
  | 'lost_tie_by_sequence'
  | 'rejected_link'
  | 'after_signup'
  | 'outside_window'
  | 'window_expired_before_signup'
  | 'install_already_attributed';

export type OrganicReason =
  | 'no_install'
  | 'no_touches'
  | 'no_eligible_touch'
  | 'window_expired'
  | 'install_already_attributed';

export interface TouchVerdict {
  seq: number;
  url: string;
  linkId: string | null;
  type: LinkFields['type'] | null;
  id: string | null;
  channel: string | null;
  receivedAt: string;
  deviceAt: string | null;
  clickCount: number;
  outcome: 'won' | 'lost';
  reason: TouchReason;
  detail: string;
}

export type Origin =
  | { kind: 'campaign' | 'referral'; id: string; channel: string | null; linkId: string; touchSeq: number }
  | { kind: 'organic'; reason: OrganicReason; detail: string };

export interface Decision {
  userId: string;
  installId: string | null;
  rule: typeof RULE;
  signupAt: string;
  firstOpenAt: string | null;
  window: { durationMs: number; startsAt: string; endsAt: string } | null;
  origin: Origin;
  touches: TouchVerdict[];
}

export interface DecideInput {
  userId: string;
  installId: string | null;
  firstOpenAt: number | null;
  signupAt: number;
  windowMs: number;
  touches: Touch[];
  /** A instalação já serviu de origem para outro cadastro. */
  installAlreadyAttributed?: boolean;
}

const ORGANIC_DETAIL: Record<OrganicReason, string> = {
  no_install: 'Cadastro sem instalação associada; não há como ligar a um link.',
  no_touches: 'Nenhum link foi aberto por esta instalação antes do cadastro.',
  no_eligible_touch: 'Havia toques, mas nenhum elegível (ver o motivo de cada um).',
  window_expired: 'O cadastro aconteceu depois do fim da janela contada do primeiro abertura.',
  install_already_attributed: 'A instalação já foi usada na atribuição de outro cadastro.',
};

const iso = (ms: number) => new Date(ms).toISOString();

function detailOf(touch: Touch, reason: TouchReason, winner?: Touch): string {
  switch (reason) {
    case 'won':
      return 'Último toque elegível dentro da janela.';
    case 'superseded_by_later_touch':
      return `Havia um toque elegível mais recente (seq ${winner?.seq}).`;
    case 'lost_tie_by_sequence':
      return `Mesmo horário do vencedor; vence a maior sequência de recebimento (seq ${winner?.seq}).`;
    case 'rejected_link':
      return `Link rejeitado (${touch.rejection}); nunca concorre.`;
    case 'after_signup':
      return 'Recebido depois do cadastro; não conta.';
    case 'outside_window':
      return 'Recebido fora da janela contada do primeiro abertura.';
    case 'window_expired_before_signup':
      return 'Toque dentro da janela, mas o cadastro aconteceu depois do fim dela.';
    case 'install_already_attributed':
      return ORGANIC_DETAIL.install_already_attributed;
  }
}

export function verdictOf(touch: Touch, reason: TouchReason, winner?: Touch): TouchVerdict {
  return {
    seq: touch.seq,
    url: touch.url,
    linkId: touch.link?.linkId ?? null,
    type: touch.link?.type ?? null,
    id: touch.link?.id ?? null,
    channel: touch.link?.channel ?? null,
    receivedAt: iso(touch.receivedAt),
    deviceAt: touch.deviceAt,
    clickCount: touch.clickCount,
    outcome: reason === 'won' ? 'won' : 'lost',
    reason,
    detail: detailOf(touch, reason, winner),
  };
}

function isLater(a: Touch, b: Touch): boolean {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt > b.receivedAt;
  return a.seq > b.seq;
}

/**
 * Regra last_touch_v1. A janela é [primeiro abertura, primeiro abertura + windowMs],
 * com os dois limites inclusivos, e vale para o toque e para o cadastro. Entre os
 * toques elegíveis vence o mais recente; em horário igual, o de maior seq.
 */
export function decide(input: DecideInput): Decision {
  const { userId, installId, firstOpenAt, signupAt, windowMs, touches, installAlreadyAttributed } = input;
  const base = { userId, installId, rule: RULE, signupAt: iso(signupAt) } as const;
  const organic = (reason: OrganicReason): Origin => ({ kind: 'organic', reason, detail: ORGANIC_DETAIL[reason] });

  if (installId === null || firstOpenAt === null) {
    return { ...base, firstOpenAt: null, window: null, origin: organic('no_install'), touches: [] };
  }

  const windowEndsAt = firstOpenAt + windowMs;
  const signupInWindow = signupAt <= windowEndsAt;

  const disqualification = (touch: Touch): TouchReason | null => {
    if (touch.rejection) return 'rejected_link';
    if (installAlreadyAttributed) return 'install_already_attributed';
    if (touch.receivedAt > signupAt) return 'after_signup';
    if (touch.receivedAt < firstOpenAt || touch.receivedAt > windowEndsAt) return 'outside_window';
    if (!signupInWindow) return 'window_expired_before_signup';
    return null;
  };

  let winner: Touch | undefined;
  for (const touch of touches) {
    if (disqualification(touch) !== null) continue;
    if (!winner || isLater(touch, winner)) winner = touch;
  }

  const verdicts = touches.map((touch) => {
    const disqualified = disqualification(touch);
    if (disqualified) return verdictOf(touch, disqualified);
    if (touch === winner) return verdictOf(touch, 'won');
    const tied = touch.receivedAt === winner?.receivedAt;
    return verdictOf(touch, tied ? 'lost_tie_by_sequence' : 'superseded_by_later_touch', winner);
  });

  let origin: Origin;
  if (winner?.link) {
    const { type, id, channel, linkId } = winner.link;
    origin = { kind: type, id, channel: channel ?? null, linkId, touchSeq: winner.seq };
  } else if (installAlreadyAttributed) {
    origin = organic('install_already_attributed');
  } else if (touches.length === 0) {
    origin = organic('no_touches');
  } else {
    origin = organic(signupInWindow ? 'no_eligible_touch' : 'window_expired');
  }

  return {
    ...base,
    firstOpenAt: iso(firstOpenAt),
    window: { durationMs: windowMs, startsAt: iso(firstOpenAt), endsAt: iso(windowEndsAt) },
    origin,
    touches: verdicts,
  };
}
