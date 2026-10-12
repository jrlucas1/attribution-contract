import { DatabaseSync } from 'node:sqlite';
import type { Decision, Touch } from './attribution.ts';
import type { Click, Install, NewTouch, Store } from './store.ts';

// As unicidades do contrato do Store são chaves do banco. O que nunca muda
// depois de gravado (primeiro abertura, decisão e dono da instalação) tem
// gatilhos que abortam UPDATE e DELETE, então a regra vale também para quem
// escreve no arquivo sem passar por este código.
//
// O gatilho de INSERT existe por causa do INSERT OR REPLACE: ele troca a linha
// sem disparar o gatilho de DELETE.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS installs (
    install_id    TEXT PRIMARY KEY,
    first_open_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS touches (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id  TEXT NOT NULL,
    dedupe_key  TEXT NOT NULL,
    url         TEXT NOT NULL,
    link        TEXT,
    rejection   TEXT,
    received_at INTEGER NOT NULL,
    device_at   TEXT,
    click_count INTEGER NOT NULL DEFAULT 1,
    pre_install INTEGER NOT NULL DEFAULT 0,
    UNIQUE (install_id, dedupe_key)
  );

  CREATE TABLE IF NOT EXISTS decisions (
    user_id    TEXT PRIMARY KEY,
    install_id TEXT,
    body       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS install_claims (
    install_id TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL
  );

  -- install_id fica vazio até o clique ser resgatado.
  CREATE TABLE IF NOT EXISTS clicks (
    click_id   TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    clicked_at INTEGER NOT NULL,
    install_id TEXT
  );

  CREATE TRIGGER IF NOT EXISTS installs_no_update BEFORE UPDATE ON installs
  BEGIN SELECT RAISE(ABORT, 'o primeiro abertura é imutável'); END;

  CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions
  BEGIN SELECT RAISE(ABORT, 'a decisão é imutável'); END;
  CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions
  BEGIN SELECT RAISE(ABORT, 'a decisão é imutável'); END;
  CREATE TRIGGER IF NOT EXISTS decisions_no_replace BEFORE INSERT ON decisions
  WHEN EXISTS (SELECT 1 FROM decisions WHERE user_id = NEW.user_id)
  BEGIN SELECT RAISE(ABORT, 'a decisão é imutável'); END;

  CREATE TRIGGER IF NOT EXISTS install_claims_no_update BEFORE UPDATE ON install_claims
  BEGIN SELECT RAISE(ABORT, 'o dono da instalação é imutável'); END;
  CREATE TRIGGER IF NOT EXISTS install_claims_no_delete BEFORE DELETE ON install_claims
  BEGIN SELECT RAISE(ABORT, 'o dono da instalação é imutável'); END;
  CREATE TRIGGER IF NOT EXISTS install_claims_no_replace BEFORE INSERT ON install_claims
  WHEN EXISTS (SELECT 1 FROM install_claims WHERE install_id = NEW.install_id)
  BEGIN SELECT RAISE(ABORT, 'o dono da instalação é imutável'); END;
`;

interface TouchRow {
  seq: number;
  install_id: string;
  dedupe_key: string;
  url: string;
  link: string | null;
  rejection: Touch['rejection'];
  received_at: number;
  device_at: string | null;
  click_count: number;
  pre_install: number;
}

function toTouch(row: TouchRow): Touch {
  return {
    seq: row.seq,
    installId: row.install_id,
    dedupeKey: row.dedupe_key,
    url: row.url,
    link: row.link === null ? null : (JSON.parse(row.link) as Touch['link']),
    rejection: row.rejection,
    receivedAt: row.received_at,
    deviceAt: row.device_at,
    clickCount: row.click_count,
    ...(row.pre_install ? { preInstall: true } : {}),
  };
}

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // Lê e grava numa transação só. O IMMEDIATE pega a trava de escrita já no
  // começo, então outro processo no mesmo arquivo espera em vez de ler junto.
  private atomic<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async ensureInstall(installId: string, at: number): Promise<Install> {
    return this.atomic(() => {
      this.db
        .prepare('INSERT INTO installs (install_id, first_open_at) VALUES (?, ?) ON CONFLICT (install_id) DO NOTHING')
        .run(installId, at);
      const row = this.db.prepare('SELECT first_open_at FROM installs WHERE install_id = ?').get(installId);
      return { installId, firstOpenAt: row?.first_open_at as number };
    });
  }

  async recordTouch(touch: NewTouch): Promise<{ touch: Touch; created: boolean }> {
    return this.atomic(() => {
      // Primeiro tenta somar no toque que já existe: um upsert gastaria um
      // número da sequência a cada clique repetido.
      const repeated = this.db
        .prepare(
          `UPDATE touches SET click_count = click_count + 1
           WHERE install_id = ? AND dedupe_key = ?
           RETURNING *`,
        )
        .get(touch.installId, touch.dedupeKey);
      if (repeated) return { touch: toTouch(repeated as unknown as TouchRow), created: false };

      const inserted = this.db
        .prepare(
          `INSERT INTO touches (install_id, dedupe_key, url, link, rejection, received_at, device_at, pre_install)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          touch.installId,
          touch.dedupeKey,
          touch.url,
          touch.link === null ? null : JSON.stringify(touch.link),
          touch.rejection,
          touch.receivedAt,
          touch.deviceAt,
          touch.preInstall ? 1 : 0,
        );
      return { touch: toTouch(inserted as unknown as TouchRow), created: true };
    });
  }

  async listTouches(installId: string): Promise<Touch[]> {
    const rows = this.db.prepare('SELECT * FROM touches WHERE install_id = ? ORDER BY seq').all(installId);
    return rows.map((row) => toTouch(row as unknown as TouchRow));
  }

  async saveDecision(decision: Decision): Promise<{ decision: Decision; created: boolean }> {
    return this.atomic(() => {
      const existing = this.readDecision(decision.userId);
      if (existing) return { decision: existing, created: false };
      this.db
        .prepare('INSERT INTO decisions (user_id, install_id, body) VALUES (?, ?, ?)')
        .run(decision.userId, decision.installId, JSON.stringify(decision));
      return { decision, created: true };
    });
  }

  async findDecision(userId: string): Promise<Decision | undefined> {
    return this.readDecision(userId);
  }

  async claimInstall(installId: string, userId: string): Promise<boolean> {
    return this.atomic(() => {
      const select = this.db.prepare('SELECT user_id FROM install_claims WHERE install_id = ?');
      const owner = select.get(installId);
      if (owner) return owner.user_id === userId;
      this.db.prepare('INSERT INTO install_claims (install_id, user_id) VALUES (?, ?)').run(installId, userId);
      return true;
    });
  }

  async saveClick(click: Click): Promise<void> {
    this.db
      .prepare('INSERT INTO clicks (click_id, url, clicked_at) VALUES (?, ?, ?)')
      .run(click.clickId, click.url, click.clickedAt);
  }

  async redeemClick(clickId: string, installId: string): Promise<Click | undefined> {
    // Um UPDATE só: quem acha o clique ainda sem instalação fica com ele.
    const row = this.db
      .prepare(
        `UPDATE clicks SET install_id = ?
         WHERE click_id = ? AND install_id IS NULL
         RETURNING url, clicked_at`,
      )
      .get(installId, clickId);
    if (!row) return undefined;
    return { clickId, url: row.url as string, clickedAt: row.clicked_at as number };
  }

  private readDecision(userId: string): Decision | undefined {
    const row = this.db.prepare('SELECT body FROM decisions WHERE user_id = ?').get(userId);
    return row ? (JSON.parse(row.body as string) as Decision) : undefined;
  }
}
