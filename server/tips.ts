// ¥50 tips through Stripe Checkout, and the supporter name tag they unlock.
//
// Flow: POST /api/tip/checkout → Stripe-hosted payment page → back to /?tip=<session id>
// → POST /api/tip/claim checks the session with Stripe and returns a signed supporter token
// → the browser keeps the token and sends it on create/join → the server verifies the
// signature (no Stripe call) and shows the tag. There are no accounts, so the tag lives in
// the browser that paid.

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TIP_AMOUNT_JPY = 50;
const SESSION_RE = /^(cs_(test|live)_[A-Za-z0-9]{10,200}|mock_[a-f0-9]{24})$/;
const TOKEN_MAX = 300;

export interface TipConfig {
  /** Stripe secret key (sk_live_… / sk_test_… / rk_…). */
  stripeKey?: string;
  /** HMAC secret for supporter tokens. Defaults to one derived from the Stripe key. */
  secret?: string;
  /** Local testing only: fake checkout that never talks to Stripe. */
  mock?: boolean;
  /** Overrides the Stripe API call (tests). */
  fetchImpl?: typeof fetch;
}

export class Tips {
  private readonly secret: Buffer;
  private readonly fetch: typeof fetch;

  constructor(private readonly cfg: TipConfig) {
    const base = cfg.secret || (cfg.stripeKey ? `stripe:${cfg.stripeKey}` : cfg.mock ? 'mock-only' : '');
    this.secret = createHash('sha256').update(`linebreak-supporter:${base}`).digest();
    this.fetch = cfg.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return Boolean(this.cfg.stripeKey || this.cfg.mock);
  }

  sign(sessionId: string): string {
    const mac = createHmac('sha256', this.secret).update(sessionId).digest('base64url');
    return `${sessionId}.${mac}`;
  }

  /** True when `token` was issued by this server. */
  verify(token: string | undefined): boolean {
    if (!this.enabled || !token || token.length > TOKEN_MAX) return false;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return false;
    const sid = token.slice(0, dot);
    if (!SESSION_RE.test(sid)) return false;
    if (sid.startsWith('mock_') && !this.cfg.mock) return false;
    const want = Buffer.from(this.sign(sid));
    const got = Buffer.from(token);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** Creates a Checkout Session and returns the URL of Stripe's payment page. */
  async checkout(origin: string): Promise<string> {
    if (this.cfg.mock && !this.cfg.stripeKey) {
      return `${origin}/?tip=mock_${randomBytes(12).toString('hex')}`;
    }
    const body = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'jpy',
      'line_items[0][price_data][unit_amount]': String(TIP_AMOUNT_JPY),
      'line_items[0][price_data][product_data][name]': 'LINEBREAK 応援（お正月ネームタグ付き）',
      'line_items[0][price_data][product_data][description]':
        'ゲームの応援です。お礼として、対戦ロビーで赤いネームタグが付きます（この端末のブラウザ）。',
      'metadata[app]': 'linebreak',
      'metadata[kind]': 'tip',
      submit_type: 'donate',
      success_url: `${origin}/?tip={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?tip=cancel`,
    });
    const r = await this.stripe('POST', '/v1/checkout/sessions', body);
    if (typeof r.url !== 'string') throw new Error('stripe: no checkout url');
    return r.url;
  }

  /** Checks a finished Checkout Session and returns a supporter token, or null if unpaid. */
  async claim(sessionId: string): Promise<string | null> {
    if (!this.enabled || !SESSION_RE.test(sessionId)) return null;
    if (sessionId.startsWith('mock_')) return this.cfg.mock ? this.sign(sessionId) : null;
    if (!this.cfg.stripeKey) return null;
    const s = await this.stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
    const paid =
      s.payment_status === 'paid' &&
      s.currency === 'jpy' &&
      typeof s.amount_total === 'number' &&
      s.amount_total >= TIP_AMOUNT_JPY &&
      s.metadata?.app === 'linebreak';
    return paid ? this.sign(sessionId) : null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async stripe(method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<any> {
    const res = await this.fetch(`https://api.stripe.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.stripeKey}`,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe ${res.status}: ${json?.error?.message ?? 'error'}`);
    return json;
  }
}

/** Counts people with the site open: each browser pings every ~20 s with a random id. */
export class Presence {
  private readonly seen = new Map<string, number>();
  static readonly TTL_MS = 45_000;
  static readonly MAX = 50_000;

  constructor(private now: () => number = Date.now) {}

  ping(id: string | null) {
    if (!id || !/^[a-z0-9]{16,40}$/.test(id)) return;
    if (!this.seen.has(id) && this.seen.size >= Presence.MAX) return;
    this.seen.set(id, this.now());
  }

  count(): number {
    const cutoff = this.now() - Presence.TTL_MS;
    for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
    return this.seen.size;
  }
}
