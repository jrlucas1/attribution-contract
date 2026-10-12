import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLink } from '../src/link.ts';
import { createAttribution } from '../src/service.ts';
import { SqliteStore } from '../src/sqlite-store.ts';

const SECRET = 'segredo-de-exemplo';
const START = Date.parse('2026-10-01T12:00:00.000Z');
const campaignUrl = buildLink({ type: 'campaign', id: 'creators-out26' }, SECRET);
const referralUrl = buildLink({ type: 'referral', id: 'ana-7f3k' }, SECRET);

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'attribution-'));
  path = join(dir, 'attribution.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open() {
  const store = new SqliteStore(path);
  return { store, attribution: createAttribution({ store, secret: SECRET, now: () => START }) };
}

// Grava um cadastro com origem de campanha e fecha o banco.
async function seedDecision() {
  const { store, attribution } = open();
  await attribution.touch({ installId: 'install-1', url: campaignUrl });
  const { decision } = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
  store.close();
  return decision;
}

describe('SqliteStore em arquivo', () => {
  it('instalação, toques e decisão continuam lá depois de reabrir', async () => {
    const decision = await seedDecision();

    const { store, attribution } = open();
    expect(await attribution.audit('user-1')).toEqual(decision);
    expect(await store.ensureInstall('install-1', START + 5000)).toEqual({ installId: 'install-1', firstOpenAt: START });
    expect(await store.listTouches('install-1')).toHaveLength(1);
    store.close();
  });

  it('depois de reabrir, cadastro repetido devolve a mesma decisão e a instalação continua tomada', async () => {
    const decision = await seedDecision();

    const { store, attribution } = open();
    const again = await attribution.signup({ userId: 'user-1', installId: 'install-1' });
    const other = await attribution.signup({ userId: 'user-2', installId: 'install-1' });
    store.close();

    expect(again).toEqual({ decision, created: false });
    expect(other.decision.origin).toMatchObject({ kind: 'organic', reason: 'install_already_attributed' });
  });

  it('depois de reabrir, a sequência dos toques continua de onde parou', async () => {
    await seedDecision();

    const { store, attribution } = open();
    const { touch } = await attribution.touch({ installId: 'install-2', url: referralUrl });
    store.close();

    expect(touch.seq).toBe(2);
  });
});

describe('decisão imutável no banco', () => {
  // Outra conexão, sem passar pelo SqliteStore: quem segura a regra é o banco.
  function raw<T>(run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path);
    try {
      return run(db);
    } finally {
      db.close();
    }
  }

  it('recusa UPDATE em qualquer coluna da decisão', async () => {
    const decision = await seedDecision();

    for (const sql of [
      `UPDATE decisions SET body = '{"origin":{"kind":"referral"}}' WHERE user_id = 'user-1'`,
      `UPDATE decisions SET install_id = 'install-9' WHERE user_id = 'user-1'`,
      `UPDATE decisions SET user_id = 'user-9' WHERE user_id = 'user-1'`,
    ]) {
      expect(() => raw((db) => db.exec(sql))).toThrow(/imutável/);
    }
    const { store, attribution } = open();
    expect(await attribution.audit('user-1')).toEqual(decision);
    store.close();
  });

  it('recusa DELETE da decisão', async () => {
    await seedDecision();

    expect(() => raw((db) => db.exec(`DELETE FROM decisions WHERE user_id = 'user-1'`))).toThrow(/imutável/);
    expect(raw((db) => db.prepare('SELECT COUNT(*) AS n FROM decisions').get())).toMatchObject({ n: 1 });
  });

  it('recusa trocar a decisão com INSERT OR REPLACE', async () => {
    const decision = await seedDecision();

    expect(() =>
      raw((db) => db.exec(`INSERT OR REPLACE INTO decisions (user_id, install_id, body) VALUES ('user-1', NULL, '{}')`)),
    ).toThrow(/imutável/);
    const { store, attribution } = open();
    expect(await attribution.audit('user-1')).toEqual(decision);
    store.close();
  });

  it('recusa segunda decisão para o mesmo usuário', async () => {
    await seedDecision();

    expect(() =>
      raw((db) => db.exec(`INSERT INTO decisions (user_id, install_id, body) VALUES ('user-1', NULL, '{}')`)),
    ).toThrow(/imutável/);
  });

  it('recusa trocar ou apagar o dono da instalação', async () => {
    await seedDecision();

    expect(() => raw((db) => db.exec(`UPDATE install_claims SET user_id = 'user-2'`))).toThrow(/imutável/);
    expect(() => raw((db) => db.exec(`DELETE FROM install_claims`))).toThrow(/imutável/);
    expect(() =>
      raw((db) => db.exec(`INSERT INTO install_claims (install_id, user_id) VALUES ('install-1', 'user-2')`)),
    ).toThrow(/imutável/);
  });

  it('recusa mudar o primeiro abertura da instalação', async () => {
    await seedDecision();

    expect(() => raw((db) => db.exec(`UPDATE installs SET first_open_at = 0`))).toThrow(/imutável/);
  });
});
