import { SqliteStore } from '../src/sqlite-store.ts';
import { MemoryStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';

/** Os stores que precisam passar nos mesmos testes. O SQLite roda em memória aqui. */
export const STORES: [name: string, open: () => Store][] = [
  ['MemoryStore', () => new MemoryStore()],
  ['SqliteStore', () => new SqliteStore()],
];
