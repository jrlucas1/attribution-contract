import { randomUUID } from 'node:crypto';
import { DEFAULT_PRE_INSTALL_WINDOW_MS, DEFAULT_WINDOW_MS, decide, verdictOf } from './attribution.ts';
import type { Decision, Touch } from './attribution.ts';
import { parseLink } from './link.ts';
import type { Click, Install, NewTouch, Store } from './store.ts';

export interface AttributionOptions {
  store: Store;
  secret: string;
  windowMs?: number;
  preInstallWindowMs?: number;
  /** Relógio do servidor em epoch ms. Injetável para teste. */
  now?: () => number;
}

export interface Attribution {
  windowMs: number;
  preInstallWindowMs: number;
  /** Guarda o link clicado antes da instalação. O clickId volta no primeiro abertura. */
  click(input: { url: string }): Promise<Click>;
  /** preInstallClick é null quando a chamada veio sem clickId. */
  firstOpen(installId: string, clickId?: string): Promise<Install & { preInstallClick: 'redeemed' | 'not_redeemed' | null }>;
  touch(input: { installId: string; url: string; deviceAt?: string }): Promise<{ touch: Touch; created: boolean }>;
  signup(input: { userId: string; installId?: string }): Promise<{ decision: Decision; created: boolean }>;
  audit(userId: string): Promise<Decision | undefined>;
}

export function createAttribution(options: AttributionOptions): Attribution {
  const { store, secret } = options;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const preInstallWindowMs = options.preInstallWindowMs ?? DEFAULT_PRE_INSTALL_WINDOW_MS;
  const now = options.now ?? Date.now;

  const newTouch = (installId: string, url: string, receivedAt: number): NewTouch => {
    const parsed = parseLink(url, secret);
    return {
      installId,
      dedupeKey: parsed.ok ? parsed.linkId : `invalid:${url}`,
      url,
      link: parsed.ok ? { ...parsed.fields, linkId: parsed.linkId } : null,
      rejection: parsed.ok ? null : parsed.rejection,
      receivedAt,
      deviceAt: null,
    };
  };

  return {
    windowMs,
    preInstallWindowMs,

    async click({ url }) {
      const click = { clickId: randomUUID(), url, clickedAt: now() };
      await store.saveClick(click);
      return click;
    },

    async firstOpen(installId, clickId) {
      const install = await store.ensureInstall(installId, now());
      if (clickId === undefined) return { ...install, preInstallClick: null };

      const click = await store.redeemClick(clickId, installId);
      if (!click) return { ...install, preInstallClick: 'not_redeemed' };

      // O toque entra com o horário do clique. Se a instalação já existia antes
      // do clique, ele é um toque comum.
      await store.recordTouch({
        ...newTouch(installId, click.url, click.clickedAt),
        preInstall: click.clickedAt < install.firstOpenAt,
      });
      return { ...install, preInstallClick: 'redeemed' };
    },

    async touch({ installId, url, deviceAt }) {
      const receivedAt = now();
      // Toque que chega antes do aviso de primeiro abertura fixa o primeiro abertura.
      await store.ensureInstall(installId, receivedAt);
      return store.recordTouch({ ...newTouch(installId, url, receivedAt), deviceAt: deviceAt ?? null });
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
          preInstallWindowMs,
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
        preInstallWindowMs,
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
