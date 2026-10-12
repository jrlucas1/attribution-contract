import type { Decision, Touch } from './attribution.ts';

export interface Install {
  installId: string;
  firstOpenAt: number;
}

export type NewTouch = Omit<Touch, 'seq' | 'clickCount'>;

/** Link clicado antes da instalação, guardado até o app abrir pela primeira vez. */
export interface Click {
  clickId: string;
  url: string;
  clickedAt: number;
}

/**
 * Cada método é uma operação atômica. Num banco real, as unicidades abaixo
 * viram constraints UNIQUE e a sequência vira uma coluna de identidade.
 */
export interface Store {
  /** Único por installId. Se já existe, devolve o existente sem mexer em firstOpenAt. */
  ensureInstall(installId: string, at: number): Promise<Install>;
  /** Único por (installId, dedupeKey). Repetição só soma clickCount no toque já gravado. */
  recordTouch(touch: NewTouch): Promise<{ touch: Touch; created: boolean }>;
  /** Em ordem crescente de seq, que é a ordem de recebimento. */
  listTouches(installId: string): Promise<Touch[]>;
  /** Único por userId. Se já existe decisão, devolve a existente. */
  saveDecision(decision: Decision): Promise<{ decision: Decision; created: boolean }>;
  findDecision(userId: string): Promise<Decision | undefined>;
  /**
   * Único por installId. O primeiro usuário a chamar fica com a instalação; a
   * resposta diz se ela é de quem chamou. Repetir a chamada dá a mesma resposta.
   */
  claimInstall(installId: string, userId: string): Promise<boolean>;
  saveClick(click: Click): Promise<void>;
  /**
   * Cada clique é resgatado uma vez, por uma instalação. Só a primeira chamada
   * devolve o clique; as seguintes, de qualquer instalação, devolvem undefined.
   */
  redeemClick(clickId: string, installId: string): Promise<Click | undefined>;
}

export class MemoryStore implements Store {
  private seq = 0;
  private installs = new Map<string, Install>();
  private touches = new Map<string, Map<string, Touch>>();
  private decisions = new Map<string, Decision>();
  private claims = new Map<string, string>();
  private clicks = new Map<string, Click>();
  private redeemed = new Set<string>();

  async ensureInstall(installId: string, at: number): Promise<Install> {
    let install = this.installs.get(installId);
    if (!install) {
      install = { installId, firstOpenAt: at };
      this.installs.set(installId, install);
    }
    return { ...install };
  }

  async recordTouch(newTouch: NewTouch): Promise<{ touch: Touch; created: boolean }> {
    let ofInstall = this.touches.get(newTouch.installId);
    if (!ofInstall) {
      ofInstall = new Map();
      this.touches.set(newTouch.installId, ofInstall);
    }
    const existing = ofInstall.get(newTouch.dedupeKey);
    if (existing) {
      existing.clickCount += 1;
      return { touch: { ...existing }, created: false };
    }
    this.seq += 1;
    const touch: Touch = { ...newTouch, seq: this.seq, clickCount: 1 };
    ofInstall.set(touch.dedupeKey, touch);
    return { touch: { ...touch }, created: true };
  }

  async listTouches(installId: string): Promise<Touch[]> {
    const ofInstall = this.touches.get(installId);
    return ofInstall ? [...ofInstall.values()].map((touch) => ({ ...touch })) : [];
  }

  async saveDecision(decision: Decision): Promise<{ decision: Decision; created: boolean }> {
    const existing = this.decisions.get(decision.userId);
    if (existing) return { decision: existing, created: false };
    this.decisions.set(decision.userId, decision);
    return { decision, created: true };
  }

  async findDecision(userId: string): Promise<Decision | undefined> {
    return this.decisions.get(userId);
  }

  async claimInstall(installId: string, userId: string): Promise<boolean> {
    if (!this.claims.has(installId)) this.claims.set(installId, userId);
    return this.claims.get(installId) === userId;
  }

  async saveClick(click: Click): Promise<void> {
    this.clicks.set(click.clickId, { ...click });
  }

  async redeemClick(clickId: string, _installId: string): Promise<Click | undefined> {
    const click = this.clicks.get(clickId);
    if (!click || this.redeemed.has(clickId)) return undefined;
    this.redeemed.add(clickId);
    return { ...click };
  }
}
