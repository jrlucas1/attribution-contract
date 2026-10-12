import { describe, expect, it } from 'vitest';
import { decide } from '../src/attribution.ts';
import { MemoryStore } from '../src/store.ts';
import type { NewTouch } from '../src/store.ts';

const newTouch: NewTouch = {
  installId: 'install-1',
  dedupeKey: 'link-a',
  url: 'https://conty.app/l?v=1',
  link: null,
  rejection: 'malformed',
  receivedAt: 1000,
  deviceAt: null,
};

const decisionFor = (userId: string, signupAt: number) =>
  decide({ userId, installId: null, firstOpenAt: null, signupAt, windowMs: 1, touches: [] });

describe('MemoryStore', () => {
  it('installId é único: a segunda chamada não muda firstOpenAt', async () => {
    const store = new MemoryStore();
    await store.ensureInstall('install-1', 1000);
    expect(await store.ensureInstall('install-1', 2000)).toEqual({ installId: 'install-1', firstOpenAt: 1000 });
  });

  it('(installId, dedupeKey) é único: repetição soma clickCount e mantém seq e horário', async () => {
    const store = new MemoryStore();
    const first = await store.recordTouch(newTouch);
    const again = await store.recordTouch({ ...newTouch, receivedAt: 2000 });

    expect(again.created).toBe(false);
    expect(again.touch).toMatchObject({ seq: first.touch.seq, receivedAt: 1000, clickCount: 2 });
    expect(await store.listTouches('install-1')).toHaveLength(1);
  });

  it('seq cresce na ordem de recebimento, entre instalações', async () => {
    const store = new MemoryStore();
    const a = await store.recordTouch(newTouch);
    const b = await store.recordTouch({ ...newTouch, installId: 'install-2' });
    const c = await store.recordTouch({ ...newTouch, dedupeKey: 'link-b' });
    expect([a.touch.seq, b.touch.seq, c.touch.seq]).toEqual([1, 2, 3]);
  });

  it('lista os toques em ordem de seq, e clique repetido não muda a posição', async () => {
    const store = new MemoryStore();
    await store.recordTouch({ ...newTouch, dedupeKey: 'link-a' });
    await store.recordTouch({ ...newTouch, installId: 'install-2' });
    await store.recordTouch({ ...newTouch, dedupeKey: 'link-b' });
    await store.recordTouch({ ...newTouch, dedupeKey: 'link-a' });

    const listed = await store.listTouches('install-1');
    expect(listed.map((touch) => [touch.seq, touch.dedupeKey])).toEqual([
      [1, 'link-a'],
      [3, 'link-b'],
    ]);
  });

  it('userId é único: a segunda decisão não substitui a primeira', async () => {
    const store = new MemoryStore();
    const first = await store.saveDecision(decisionFor('user-1', 1000));
    const second = await store.saveDecision(decisionFor('user-1', 2000));

    expect(second.created).toBe(false);
    expect(second.decision).toEqual(first.decision);
    expect(await store.findDecision('user-1')).toEqual(first.decision);
  });

  it('quem lê um toque não consegue alterar o que está gravado', async () => {
    const store = new MemoryStore();
    const { touch } = await store.recordTouch(newTouch);
    touch.clickCount = 99;
    expect((await store.listTouches('install-1'))[0]?.clickCount).toBe(1);
  });
});
