import { MemoryStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';

/** Os stores que precisam passar nos mesmos testes. */
export const STORES: [name: string, open: () => Store][] = [['MemoryStore', () => new MemoryStore()]];
