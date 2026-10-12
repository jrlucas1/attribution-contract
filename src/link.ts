import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const LINK_VERSION = '1';
export const LINK_BASE_URL = 'https://conty.app/l';

export type LinkType = 'campaign' | 'referral';

export interface LinkFields {
  type: LinkType;
  /** Campanha: slug da campanha. Indicação: código de quem indicou. */
  id: string;
  /** Canal onde o link foi divulgado. */
  channel?: string;
}

export type LinkRejection = 'malformed' | 'unsupported_version' | 'unknown_type' | 'invalid_signature';

export type ParsedLink =
  | { ok: true; fields: LinkFields; linkId: string }
  | { ok: false; rejection: LinkRejection };

/** Campos em ordem fixa: é o que a assinatura cobre e o que identifica o link. */
function canonical(fields: LinkFields): string {
  const params = new URLSearchParams({ v: LINK_VERSION, t: fields.type, id: fields.id });
  if (fields.channel) params.set('ch', fields.channel);
  return params.toString();
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function sameSignature(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function linkIdOf(fields: LinkFields): string {
  return createHash('sha256').update(canonical(fields)).digest('hex').slice(0, 16);
}

export function buildLink(fields: LinkFields, secret: string): string {
  const payload = canonical(fields);
  return `${LINK_BASE_URL}?${payload}&sig=${sign(payload, secret)}`;
}

/**
 * Só a query importa: o mesmo link pode chegar como https://conty.app/l?... ou
 * como deep link conty://l?.... Parâmetros fora do contrato são ignorados.
 */
export function parseLink(url: string, secret: string): ParsedLink {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return { ok: false, rejection: 'malformed' };
  }

  const version = params.get('v');
  const type = params.get('t');
  const id = params.get('id');
  const signature = params.get('sig');
  const channel = params.get('ch');
  if (!version || !type || !id || !signature) return { ok: false, rejection: 'malformed' };
  if (version !== LINK_VERSION) return { ok: false, rejection: 'unsupported_version' };
  if (type !== 'campaign' && type !== 'referral') return { ok: false, rejection: 'unknown_type' };

  const fields: LinkFields = channel ? { type, id, channel } : { type, id };
  if (!sameSignature(signature, sign(canonical(fields), secret))) {
    return { ok: false, rejection: 'invalid_signature' };
  }
  return { ok: true, fields, linkId: linkIdOf(fields) };
}
