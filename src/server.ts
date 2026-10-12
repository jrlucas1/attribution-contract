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
} as const;

const signupBody = {
  type: 'object',
  required: ['userId'],
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1, maxLength: 128 },
    installId: { type: 'string', minLength: 1, maxLength: MAX_INSTALL_ID_LENGTH },
  },
} as const;

export function buildServer(attribution: Attribution): FastifyInstance {
  const app = Fastify();

  app.post<{ Params: { installId: string } }>('/installs/:installId/first-open', async (request) => {
    const install = await attribution.firstOpen(request.params.installId);
    return {
      installId: install.installId,
      firstOpenAt: new Date(install.firstOpenAt).toISOString(),
      windowEndsAt: new Date(install.firstOpenAt + attribution.windowMs).toISOString(),
    };
  });

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
