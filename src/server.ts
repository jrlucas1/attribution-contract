import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Attribution } from './service.ts';

// O roteador do Fastify já recusa parâmetro de rota com mais de 100 caracteres.
const MAX_INSTALL_ID_LENGTH = 100;

const touchBody = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2048 },
    deviceAt: { type: 'string', format: 'date-time' },
  },
};

const clickBody = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2048 },
  },
};

const MAX_CLICK_ID_LENGTH = 100;

// Corpo ausente: sem clickId. Corpo presente: só { clickId } com texto de 1 a 100 caracteres.
function readClickId(body: unknown): string | undefined | 'invalid' {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object') return 'invalid';
  const { clickId, ...rest } = body as { clickId?: unknown };
  if (Object.keys(rest).length > 0) return 'invalid';
  if (clickId === undefined) return undefined;
  if (typeof clickId !== 'string' || clickId.length === 0 || clickId.length > MAX_CLICK_ID_LENGTH) return 'invalid';
  return clickId;
}

const signupBody = {
  type: 'object',
  required: ['userId'],
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1, maxLength: 128 },
    installId: { type: 'string', minLength: 1, maxLength: MAX_INSTALL_ID_LENGTH },
  },
};

export function buildServer(attribution: Attribution): FastifyInstance {
  const app = Fastify();

  // Clique feito antes da instalação. O clickId chega ao app pela loja e volta no first-open.
  app.post<{ Body: { url: string } }>('/clicks', { schema: { body: clickBody } }, async (request, reply) => {
    const click = await attribution.click(request.body);
    return reply.code(201).send({
      clickId: click.clickId,
      clickedAt: new Date(click.clickedAt).toISOString(),
      redeemableUntil: new Date(click.clickedAt + attribution.preInstallWindowMs).toISOString(),
    });
  });

  // O corpo é opcional: sem ele a chamada só registra o primeiro abertura.
  app.post<{ Params: { installId: string }; Body?: unknown }>(
    '/installs/:installId/first-open',
    async (request, reply) => {
      const clickId = readClickId(request.body);
      if (clickId === 'invalid') return reply.code(400).send({ error: 'invalid_click_id' });

      const install = await attribution.firstOpen(request.params.installId, clickId);
      return {
        installId: install.installId,
        firstOpenAt: new Date(install.firstOpenAt).toISOString(),
        windowEndsAt: new Date(install.firstOpenAt + attribution.windowMs).toISOString(),
        ...(install.preInstallClick ? { preInstallClick: install.preInstallClick } : {}),
      };
    },
  );

  // 201 toque novo, 200 clique repetido, 422 link rejeitado (gravado mesmo assim).
  app.post<{ Params: { installId: string }; Body: { url: string; deviceAt?: string } }>(
    '/installs/:installId/touches',
    { schema: { body: touchBody } },
    async (request, reply) => {
      const { touch, created } = await attribution.touch({ installId: request.params.installId, ...request.body });
      const status = touch.rejection ? 422 : created ? 201 : 200;
      return reply.code(status).send({
        seq: touch.seq,
        status: touch.rejection ? 'rejected' : 'accepted',
        rejection: touch.rejection,
        linkId: touch.link?.linkId ?? null,
        receivedAt: new Date(touch.receivedAt).toISOString(),
        clickCount: touch.clickCount,
      });
    },
  );

  // 201 na primeira vez, 200 com a mesma decisão nas repetições.
  app.post<{ Body: { userId: string; installId?: string } }>(
    '/signups',
    { schema: { body: signupBody } },
    async (request, reply) => {
      const { decision, created } = await attribution.signup(request.body);
      return reply.code(created ? 201 : 200).send(decision);
    },
  );

  app.get<{ Params: { userId: string } }>('/signups/:userId/attribution', async (request, reply) => {
    const decision = await attribution.audit(request.params.userId);
    if (!decision) return reply.code(404).send({ error: 'signup_not_found' });
    return decision;
  });

  return app;
}
