import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventBus, ServerEvent } from '../../services/eventBus.js';
import type { TestService } from '../../services/testService.js';
import type { AuthService } from '../middleware/auth.js';

const HEARTBEAT_MS = 30_000;

export interface RealtimeServer {
  close(): Promise<void>;
  get clientCount(): number;
}

/**
 * Pushes test snapshots and activity-log lines to the dashboard.
 *
 * The upgrade is authenticated with the same session cookie as the REST API, so
 * an unauthenticated socket can never observe test activity.
 */
export function attachRealtime(deps: {
  server: HttpServer;
  bus: EventBus;
  auth: AuthService;
  testService: TestService;
  path?: string;
}): RealtimeServer {
  const wss = new WebSocketServer({ noServer: true });
  const path = deps.path ?? '/ws';
  const sockets = new Set<WebSocket>();

  deps.server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      // Nothing else upgrades on this server: never leave the socket dangling.
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const principal = deps.auth.principalFrom(req);
    if (!principal) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws);
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);

    ws.on('close', () => {
      clearInterval(heartbeat);
      sockets.delete(ws);
    });
    ws.on('error', () => {
      clearInterval(heartbeat);
      sockets.delete(ws);
    });

    ws.send(
      JSON.stringify({ type: 'hello', payload: { activeTests: deps.testService.activeCount } }),
    );
  });

  const unsubscribe = deps.bus.subscribe((event: ServerEvent) => {
    const frame = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  });

  return {
    get clientCount() {
      return sockets.size;
    },
    async close() {
      unsubscribe();
      for (const ws of sockets) ws.close(1001, 'Server shutting down');
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
