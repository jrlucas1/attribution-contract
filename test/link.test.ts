import { describe, expect, it } from 'vitest';
import { buildLink, linkIdOf, parseLink } from '../src/link.ts';
import type { LinkFields } from '../src/link.ts';

const SECRET = 'segredo-de-exemplo';
const campaign: LinkFields = { type: 'campaign', id: 'creators-out26', channel: 'instagram' };
const referral: LinkFields = { type: 'referral', id: 'ana-7f3k' };

describe('buildLink', () => {
  // Os mesmos links estão no README. Se o formato mudar, o contrato mudou.
  it('gera o link de campanha do README', () => {
    expect(buildLink(campaign, SECRET)).toBe(
      'https://conty.app/l?v=1&t=campaign&id=creators-out26&ch=instagram&sig=YutJD5PdFjBMf_EwhJr3coNOr8a2OjN5YS3K2ggIHrE',
    );
  });

  it('gera o link de indicação do README', () => {
    expect(buildLink(referral, SECRET)).toBe(
      'https://conty.app/l?v=1&t=referral&id=ana-7f3k&sig=S2zTcWtQd-SZE5JI1GylRuI-raYoxIUBynTPRTs_KOw',
    );
  });
});

describe('parseLink', () => {
  it('lê de volta o que buildLink gerou', () => {
    expect(parseLink(buildLink(campaign, SECRET), SECRET)).toEqual({
      ok: true,
      fields: campaign,
      linkId: linkIdOf(campaign),
    });
    expect(parseLink(buildLink(referral, SECRET), SECRET)).toEqual({
      ok: true,
      fields: referral,
      linkId: linkIdOf(referral),
    });
  });

  it('aceita o mesmo link como deep link e ignora parâmetros fora do contrato', () => {
    const query = new URL(buildLink(referral, SECRET)).search;
    const parsed = parseLink(`conty://l${query}&utm_source=whatsapp`, SECRET);
    expect(parsed).toMatchObject({ ok: true, linkId: linkIdOf(referral) });
  });

  it('rejeita código de indicação trocado sem reassinar', () => {
    const forged = buildLink(referral, SECRET).replace('ana-7f3k', 'bia-1x9z');
    expect(parseLink(forged, SECRET)).toEqual({ ok: false, rejection: 'invalid_signature' });
  });

  it('rejeita canal acrescentado depois da assinatura', () => {
    const forged = `${buildLink(referral, SECRET)}&ch=tiktok`;
    expect(parseLink(forged, SECRET)).toEqual({ ok: false, rejection: 'invalid_signature' });
  });

  it('rejeita link assinado com outra chave', () => {
    expect(parseLink(buildLink(campaign, 'outra-chave'), SECRET)).toEqual({
      ok: false,
      rejection: 'invalid_signature',
    });
  });

  it.each([
    ['texto que não é URL', 'isso não é um link'],
    ['sem assinatura', 'https://conty.app/l?v=1&t=referral&id=ana-7f3k'],
    ['sem id', 'https://conty.app/l?v=1&t=referral&sig=abc'],
    ['id vazio', 'https://conty.app/l?v=1&t=referral&id=&sig=abc'],
  ])('marca como malformado: %s', (_caso, url) => {
    expect(parseLink(url, SECRET)).toEqual({ ok: false, rejection: 'malformed' });
  });

  it('rejeita versão que não conhece', () => {
    const url = buildLink(campaign, SECRET).replace('v=1', 'v=2');
    expect(parseLink(url, SECRET)).toEqual({ ok: false, rejection: 'unsupported_version' });
  });

  it('rejeita tipo que não conhece', () => {
    const url = buildLink(campaign, SECRET).replace('t=campaign', 't=parceria');
    expect(parseLink(url, SECRET)).toEqual({ ok: false, rejection: 'unknown_type' });
  });
});

describe('linkIdOf', () => {
  it('é estável para os mesmos campos e muda com qualquer campo', () => {
    expect(linkIdOf({ ...campaign })).toBe(linkIdOf(campaign));
    expect(linkIdOf({ ...campaign, channel: 'tiktok' })).not.toBe(linkIdOf(campaign));
    expect(linkIdOf({ type: 'referral', id: campaign.id })).not.toBe(linkIdOf({ type: 'campaign', id: campaign.id }));
  });
});
