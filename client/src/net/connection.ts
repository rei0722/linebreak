// WebSocket wrapper: auto-reconnect with backoff, clock-offset estimation,
// and a status value the UI can show. No DOM dependencies (used by test bots too).

import type { ClientMsg, ServerMsg } from '../../../shared/protocol';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed';

type Listener = (msg: ServerMsg) => void;

export class Connection {
  status: ConnStatus = 'connecting';
  /** serverTime ≈ Date.now() + offset */
  offset = 0;
  rtt = 0;
  private bestRtt = Infinity;
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: ConnStatus) => void>();
  private openListeners = new Set<() => void>();
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private everOpened = false;

  constructor(
    readonly url: string,
    private maxAttempts = 12,
  ) {
    this.open();
  }

  private setStatus(s: ConnStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.everOpened = true;
      this.bestRtt = Infinity;
      this.setStatus('open');
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), 2000);
      for (const l of this.openListeners) l();
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
      } catch {
        return;
      }
      if (msg.t === 'pong') this.onPong(msg);
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      if (this.closedByUser) return this.setStatus('closed');
      if (e.code === 4008) return this.setStatus('failed');
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleRetry() {
    if (++this.attempts > this.maxAttempts) return this.setStatus('failed');
    this.setStatus(this.everOpened ? 'reconnecting' : 'connecting');
    const delay = Math.min(5000, 250 * 2 ** (this.attempts - 1)) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  /** Manually retry after 'failed'. */
  retry() {
    if (this.ws) return;
    this.attempts = 0;
    this.closedByUser = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.setStatus(this.everOpened ? 'reconnecting' : 'connecting');
    this.open();
  }

  private ping() {
    this.send({ t: 'ping', c: Date.now() });
  }

  private onPong(msg: Extract<ServerMsg, { t: 'pong' }>) {
    const now = Date.now();
    const rtt = now - msg.c;
    this.rtt = rtt;
    // NTP-style: trust the sample with the lowest round trip the most
    if (rtt <= this.bestRtt * 1.2 || this.bestRtt === Infinity) {
      this.bestRtt = Math.min(this.bestRtt, rtt);
      const sample = msg.s - (msg.c + rtt / 2);
      this.offset = this.offset === 0 ? sample : this.offset * 0.7 + sample * 0.3;
    }
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }

  send(msg: ClientMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: (s: ConnStatus) => void) {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  onOpen(l: () => void) {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }

  /** Simulate a network drop (used by tests). */
  dropForTest() {
    this.ws?.close(4001, 'test drop');
  }

  close() {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close(1000, 'bye');
    this.listeners.clear();
    this.statusListeners.clear();
    this.openListeners.clear();
  }
}
