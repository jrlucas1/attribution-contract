import { describe, expect, it } from 'vitest';
import { buildLink } from '../src/link.ts';
import { createAttribution } from '../src/service.ts';
import { STORES } from './stores.ts';

const SECRET = 'segredo-de-exemplo';
const START = Date.parse('2026-10-01T12:00:00.000Z');
const campaignUrl = buildLink({ type: 'campaign', id: 'creators-out26' }, SECRET);

describe.each(STORES)('cadastros concorrentes (%s)', (_name, openStore) => {
  const setup = () => createAttribution({ store: openStore(), secret: SECRET, now: () => START });

  it('dois usuários na mesma instalação ao mesmo tempo: só um fica com a origem', async () => {
    const attribution = setup();
    await attribution.touch({ installId: 'install-1', url: campaignUrl });

    const results = await Promise.all([
      attribution.signup({ userId: 'user-1', installId: 'install-1' }),
      attribution.signup({ userId: 'user-2', installId: 'install-1' }),
    ]);

    const origins = results.map((result) => result.decision.origin);
    expect(origins.filter((origin) => origin.kind === 'campaign')).toHaveLength(1);
    expect(origins.filter((origin) => origin.kind === 'organic')).toEqual([
      expect.objectContaining({ reason: 'install_already_attributed' }),
    ]);
  });

  it('dez usuários na mesma instalação ao mesmo tempo geram uma origem', async () => {
    const attribution = setup();
    await attribution.touch({ installId: 'install-1', url: campaignUrl });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        attribution.signup({ userId: `user-${index}`, installId: 'install-1' }),
      ),
    );

    const kinds = results.map((result) => result.decision.origin.kind);
    expect(kinds.filter((kind) => kind === 'campaign')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'organic')).toHaveLength(9);
  });

  it('a auditoria de cada usuário devolve a decisão que o cadastro devolveu', async () => {
    const attribution = setup();
    await attribution.touch({ installId: 'install-1', url: campaignUrl });

    const [first, second] = await Promise.all([
      attribution.signup({ userId: 'user-1', installId: 'install-1' }),
      attribution.signup({ userId: 'user-2', installId: 'install-1' }),
    ]);

    expect(await attribution.audit('user-1')).toEqual(first.decision);
    expect(await attribution.audit('user-2')).toEqual(second.decision);
  });

  it('o mesmo usuário cadastrado duas vezes ao mesmo tempo tem uma decisão só, com a origem', async () => {
    const attribution = setup();
    await attribution.touch({ installId: 'install-1', url: campaignUrl });

    const [first, second] = await Promise.all([
      attribution.signup({ userId: 'user-1', installId: 'install-1' }),
      attribution.signup({ userId: 'user-1', installId: 'install-1' }),
    ]);

    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(second.decision).toEqual(first.decision);
    expect(first.decision.origin.kind).toBe('campaign');
  });

  it('instalações diferentes ao mesmo tempo ficam cada uma com a sua origem', async () => {
    const attribution = setup();
    await attribution.touch({ installId: 'install-1', url: campaignUrl });
    await attribution.touch({ installId: 'install-2', url: campaignUrl });

    const results = await Promise.all([
      attribution.signup({ userId: 'user-1', installId: 'install-1' }),
      attribution.signup({ userId: 'user-2', installId: 'install-2' }),
    ]);

    expect(results.map((result) => result.decision.origin.kind)).toEqual(['campaign', 'campaign']);
  });
});
