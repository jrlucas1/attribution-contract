import { buildServer } from './server.ts';
import { createAttribution } from './service.ts';
import { SqliteStore } from './sqlite-store.ts';

const secret = process.env.ATTRIBUTION_LINK_SECRET;
if (!secret) {
  console.error('Defina ATTRIBUTION_LINK_SECRET (chave HMAC dos links).');
  process.exit(1);
}

const windowDays = Number(process.env.ATTRIBUTION_WINDOW_DAYS ?? 7);
if (!Number.isFinite(windowDays) || windowDays <= 0) {
  console.error('ATTRIBUTION_WINDOW_DAYS precisa ser um número positivo.');
  process.exit(1);
}

const attribution = createAttribution({
  store: new SqliteStore(process.env.ATTRIBUTION_DB_PATH ?? 'attribution.db'),
  secret,
  windowMs: windowDays * 24 * 60 * 60 * 1000,
});

const address = await buildServer(attribution).listen({ port: Number(process.env.PORT ?? 3000) });
console.log(`Atribuição em ${address}, janela de ${windowDays} dia(s).`);
