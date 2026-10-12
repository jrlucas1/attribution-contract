import { describe, expect, it } from 'vitest';
import { decide } from '../src/attribution.ts';
import type { NewTouch } from '../src/store.ts';
import { STORES } from './stores.ts';

const newTouch: NewTouch = {
  installId: 'install-1',
  dedupeKey: 'link-a',
  url: 'https://conty.app/l?v=1',
  link: null,
  rejection: 'malformed',
  receivedAt: 1000,
  deviceAt: null,
};

const acceptedTouch: NewTouch = {
  ...newTouch,
  dedupeKey: 'link-ok',
  link: { type: 'campaign', id: 'creators-out26', channel: 'instagram', linkId: 'link-ok' },
  rejection: null,
  deviceAt: '2026-10-01T12:00:00.000Z',
};

const decisionFor = (userId: string, signupAt: number) =>
  decide({ userId, installId: null, firstOpenAt: null, signupAt, windowMs: 1, touches: [] });

// O mesmo contrato do MemoryStore, exigido de todo store.
describe.each(STORES)('contrato do store (%s)', (_name, openStore) => {
  it('installId é único: a segunda chamada não muda firstOpenAt', async () => {
    const store = openStore();
    expect(await store.ensureInstall('install-1', 1000)).toEqual({ installId: 'install-1', firstOpenAt: 1000 });
    expect(await store.ensureInstall('install-1', 2000)).toEqual({ installId: 'install-1', firstOpenAt: 1000 });
  });

  it('(installId, dedupeKey) é único: repetição soma clickCount e mantém seq e horário', async () => {
    const store = openStore();
    const first = await store.recordTouch(newTouch);
    const again = await store.recordTouch({ ...newTouch, receivedAt: 2000 });

    expect(first).toMatchObject({ created: true, touch: { clickCount: 1 } });
    expect(again.created).toBe(false);
    expect(again.touch).toMatchObject({ seq: first.touch.seq, receivedAt: 1000, clickCount: 2 });
    expect(await store.listTouches('install-1')).toHaveLength(1);
  });

  it('seq cresce de um em um na ordem de recebimento, e clique repetido não gasta número', async () => {
    const store = openStore();
    const a = await store.recordTouch(newTouch);
    await store.recordTouch(newTouch);
    const b = await store.recordTouch({ ...newTouch, installId: 'install-2' });
    const c = await store.recordTouch({ ...newTouch, dedupeKey: 'link-b' });
    expect([a.touch.seq, b.touch.seq, c.touch.seq]).toEqual([1, 2, 3]);
  });

  it('lista os toques da instalação em ordem de seq', async () => {
    const store = openStore();
    await store.recordTouch({ ...newTouch, dedupeKey: 'link-a' });
    await store.recordTouch({ ...newTouch, installId: 'install-2' });
    await store.recordTouch({ ...newTouch, dedupeKey: 'link-b' });
    await store.recordTouch({ ...newTouch, dedupeKey: 'link-a' });

    const listed = await store.listTouches('install-1');
    expect(listed.map((touch) => [touch.seq, touch.dedupeKey])).toEqual([
      [1, 'link-a'],
      [3, 'link-b'],
    ]);
    expect(await store.listTouches('install-sem-toque')).toEqual([]);
  });

  it('devolve o toque com todos os campos que recebeu', async () => {
    const store = openStore();
    await store.recordTouch(acceptedTouch);
    await store.recordTouch(newTouch);

    expect(await store.listTouches('install-1')).toEqual([
      { ...acceptedTouch, seq: 1, clickCount: 1 },
      { ...newTouch, seq: 2, clickCount: 1 },
    ]);
  });

  it('userId é único: a segunda decisão não substitui a primeira', async () => {
    const store = openStore();
    const first = await store.saveDecision(decisionFor('user-1', 1000));
    const second = await store.saveDecision(decisionFor('user-1', 2000));

    expect(first.created).toBe(true);
    expect(first.decision).toEqual(decisionFor('user-1', 1000));
    expect(second.created).toBe(false);
    expect(second.decision).toEqual(first.decision);
    expect(await store.findDecision('user-1')).toEqual(first.decision);
    expect(await store.findDecision('user-2')).toBeUndefined();
  });

  it('quem lê um toque não consegue alterar o que está gravado', async () => {
    const store = openStore();
    const { touch } = await store.recordTouch(newTouch);
    touch.clickCount = 99;
    expect((await store.listTouches('install-1'))[0]?.clickCount).toBe(1);
  });

  it('a instalação fica com o primeiro usuário que a reivindica', async () => {
    const store = openStore();
    expect(await store.claimInstall('install-1', 'user-1')).toBe(true);
    expect(await store.claimInstall('install-1', 'user-2')).toBe(false);
    expect(await store.claimInstall('install-1', 'user-1')).toBe(true);
    expect(await store.claimInstall('install-2', 'user-2')).toBe(true);
  });
});
