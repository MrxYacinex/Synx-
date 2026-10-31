import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomManager, type Conn } from './rooms';
import { isValidRoomCode, normalizeRoomCode } from '../../app/src/shared/protocol';

export interface StartOptions {
  port?: number;
  host?: string;
  manager?: RoomManager;
  log?: boolean;
}

export function startServer(opts: StartOptions = {}): Promise<{ server: http.Server; manager: RoomManager; port: number; close: () => Promise<void> }> {
  const manager = opts.manager ?? new RoomManager();
  const log = opts.log ?? true;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...manager.stats() }));
      return;
    }
    const join = url.pathname.match(/^\/(?:join|j)\/([A-Za-z0-9]+)\/?$/);
    if (join) {
      const code = normalizeRoomCode(join[1]);
      if (!isValidRoomCode(code)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Unknown room');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(joinPage(code));
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Synx sync server is running. Open the Synx app to start a room.');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  wss.on('connection', (ws: WebSocket) => {
    let alive = true;
    const conn: Conn = {
      send: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    manager.connect(conn);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      manager.handleRaw(conn, data.toString());
    });
    ws.on('pong', () => (alive = true));
    ws.on('close', () => manager.disconnect(conn));
    ws.on('error', () => manager.disconnect(conn));
    (ws as WebSocket & { isAlive?: () => boolean; markDead?: () => void }).isAlive = () => alive;
    (ws as WebSocket & { markDead?: () => void }).markDead = () => (alive = false);
  });

  // Detect dead mobile connections (phones switching networks etc.).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: () => boolean; markDead?: () => void };
      if (w.isAlive && !w.isAlive()) {
        ws.terminate();
        continue;
      }
      w.markDead?.();
      ws.ping();
    }
    manager.sweep();
  }, 20_000);

  return new Promise((resolve) => {
    server.listen(opts.port ?? 8787, opts.host ?? '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 8787);
      if (log) console.log(`[synx] server listening on :${port}`);
      resolve({
        server,
        manager,
        port,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(heartbeat);
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.close(() => r());
          }),
      });
    });
  });
}

function joinPage(code: string): string {
  const deep = `synx://join/${code}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join ${code} on Synx</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0B12;color:#fff;font-family:-apple-system,system-ui,sans-serif;text-align:center}
.c{padding:32px}.code{font-size:44px;letter-spacing:8px;font-weight:800;margin:16px 0}a{display:inline-block;margin-top:16px;padding:14px 28px;border-radius:999px;background:linear-gradient(90deg,#FF4D8D,#8B5CFF);color:#fff;text-decoration:none;font-weight:700}p{color:#aaa}</style>
</head><body><div class="c"><p>You're invited to watch together on</p><h1>synx</h1><div class="code">${code}</div>
<a href="${deep}">Open in Synx</a><p>Don't have it yet? Install Synx, then enter the code above.</p></div>
<script>setTimeout(function(){location.href=${JSON.stringify(deep)}},300)</script></body></html>`;
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('main.ts');
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  startServer({ port }).then(({ close }) => {
    const stop = () => close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
