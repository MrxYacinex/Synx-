import type { AgentStatus, FromAgent, ToAgent } from './bridge';
import type { SyncClient } from './client';

/**
 * Glue between a SyncClient and one page agent running inside a WebView.
 * `inject` must run a JS snippet inside the page (WebView.injectJavaScript).
 */
export class AgentSession {
  status: AgentStatus | null = null;
  private offsetTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: () => void;
  private lastOffset = NaN;

  constructor(
    private readonly client: SyncClient,
    private readonly inject: (js: string) => void,
    private readonly hooks: { status?: (s: AgentStatus) => void; log?: (msg: string) => void } = {},
  ) {
    this.unsubscribe = client.on({
      state: (state) => this.send({ type: 'room', state, offset: client.clock.offset }),
    });
    // Keep the agent's clock offset fresh as pings refine it.
    this.offsetTimer = setInterval(() => {
      const o = client.clock.offset;
      if (Math.abs(o - this.lastOffset) > 2 || Number.isNaN(this.lastOffset)) {
        this.lastOffset = o;
        this.send({ type: 'offset', offset: o });
      }
    }, 1000);
  }

  /** Feed a raw message from WebView onMessage. */
  handleMessage(data: string): void {
    let msg: FromAgent;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        if (this.client.status === 'connected') {
          this.send({ type: 'room', state: this.client.state, offset: this.client.clock.offset });
        }
        break;
      case 'publish':
        this.client.publish(msg.update);
        break;
      case 'status':
        this.status = msg.status;
        this.hooks.status?.(msg.status);
        break;
      case 'log':
        this.hooks.log?.(msg.msg);
        break;
    }
  }

  send(msg: ToAgent): void {
    // Safe to call any time: if the agent isn't there yet the snippet is a no-op,
    // and the agent asks for the room state again with 'ready' once it loads.
    const js = `(function(){try{window.__synx&&window.__synx.receive(${JSON.stringify(JSON.stringify(msg))});}catch(e){}})();true;`;
    this.inject(js);
  }

  togglePlay(): void {
    this.send({ type: 'command', action: 'toggle-play' });
  }
  setRate(rate: number): void {
    this.send({ type: 'command', action: 'set-rate', rate });
  }
  rejoin(): void {
    this.send({ type: 'command', action: 'rejoin' });
  }
  setSound(on: boolean): void {
    this.send({ type: 'sound', on });
  }

  dispose(): void {
    this.unsubscribe();
    if (this.offsetTimer) clearInterval(this.offsetTimer);
  }
}
