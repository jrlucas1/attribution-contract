import { DEFAULT_WINDOW_MS, decide, verdictOf } from './attribution.ts';
import type { Decision, Touch } from './attribution.ts';
import { parseLink } from './link.ts';
import type { Install, Store } from './store.ts';

export interface AttributionOptions {
  store: Store;
  secret: string;
  windowMs?: number;
  /** Relógio do servidor em epoch ms. Injetável para teste. */
  now?: () => number;
}

export interface Attribution {
  windowMs: number;
  firstOpen(installId: string): Promise<Install>;
  touch(input: { installId: string; url: string; deviceAt?: string }): Promise<{ touch: Touch; created: boolean }>;
  signup(input: { userId: string; installId?: string }): Promise<{ decision: Decision; created: boolean }>;
  audit(userId: string): Promise<Decision | undefined>;
}

export function createAttribution(options: AttributionOptions): Attribution {
  const { store, secret } = options;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options.now ?? Date.now;

  return {
    windowMs,

    firstOpen(installId) {
      return store.ensureInstall(installId, now());
    },

    async touch({ installId, url, deviceAt }) {
      const receivedAt = now();
      // Toque que chega antes do aviso de primeiro abertura fixa o primeiro abertura.
      await store.ensureInstall(installId, receivedAt);
      const parsed = parseLink(url, secret);
      return store.recordTouch({
        installId,
        dedupeKey: parsed.ok ? parsed.linkId : `invalid:${url}`,
        url,
        link: parsed.ok ? { ...parsed.fields, linkId: parsed.linkId } : null,
        rejection: parsed.ok ? null : parsed.rejection,
        receivedAt,
        deviceAt: deviceAt ?? null,
      });
    },

    async signup({ userId, installId }) {
      const existing = await store.findDecision(userId);
      if (existing) return { decision: existing, created: false };

      const signupAt = now();
      if (!installId) {
        const organicDecision = decide({
          userId,
          installId: null,
          firstOpenAt: null,
          signupAt,
          windowMs,
          touches: [],
        });
        return store.saveDecision(organicDecision);
      }

      const install = await store.ensureInstall(installId, signupAt);
      // Dois cadastros simultâneos da mesma instalação disputam aqui: só um fica com ela.
      const installIsMine = await store.claimInstall(installId, userId);
      const decision = decide({
        userId,
        installId,
        firstOpenAt: install.firstOpenAt,
        signupAt,
        windowMs,
        touches: await store.listTouches(installId),
        installAlreadyAttributed: !installIsMine,
      });
      return store.saveDecision(decision);
    },

    /** A decisão gravada no cadastro, mais os toques que chegaram depois dela. */
    async audit(userId) {
      const decision = await store.findDecision(userId);
      if (!decision || decision.installId === null) return decision;

      const judged = new Set(decision.touches.map((verdict) => verdict.seq));
      const allTouches = await store.listTouches(decision.installId);
      const arrivedAfterDecision = allTouches.filter((touch) => !judged.has(touch.seq));
      const laterVerdicts = arrivedAfterDecision.map((touch) =>
        verdictOf(touch, touch.rejection ? 'rejected_link' : 'after_signup'),
      );
      return { ...decision, touches: [...decision.touches, ...laterVerdicts] };
    },
  };
}
