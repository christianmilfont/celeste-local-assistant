import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { AssistantEvent, AvatarState, EventType } from '../../core/types';
import { Logger } from '../../infrastructure/logging/Logger';

/** O mínimo que o servidor precisa da Celeste: ler o estado e ouvir eventos. */
export interface AvatarStateSource {
  getAvatarState(): AvatarState;
  on(eventType: EventType, callback: (event: AssistantEvent) => void): void;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** Pasta raiz do pacote "three" (servido localmente em /vendor/three/, sem CDN). */
function threeRoot(): string | undefined {
  try {
    return path.resolve(path.dirname(require.resolve('three')), '..');
  } catch {
    return undefined;
  }
}

/** Do pacote three só são expostos o build e os addons (examples/jsm). */
const THREE_ALLOWED = [`build${path.sep}`, `examples${path.sep}jsm${path.sep}`];

const HEARTBEAT_MS = 25000;

/**
 * Serve a página do avatar (pasta /avatar) e transmite os estados por Server-Sent Events.
 * Usa apenas o módulo http do Node: nenhuma dependência extra. Qualquer navegador
 * (janela local, kiosk em um Raspberry Pi, outro dispositivo da rede) pode exibir o avatar.
 */
export class AvatarServer {
  private server?: http.Server;
  private clients = new Set<http.ServerResponse>();
  private heartbeat?: NodeJS.Timeout;
  private lastChange: Record<string, unknown>;
  private threeDir = threeRoot();

  constructor(
    private source: AvatarStateSource,
    private publicDir: string = path.resolve(__dirname, '../../../avatar')
  ) {
    this.lastChange = { state: source.getAvatarState(), previous: source.getAvatarState() };
    source.on('AVATAR_STATE_CHANGED', (event) => {
      this.lastChange = event.data;
      this.broadcast('state', event.data);
    });
  }

  async start(port: number, host: string): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });

    this.heartbeat = setInterval(() => {
      this.clients.forEach((client) => client.write(': ping\n\n'));
    }, HEARTBEAT_MS);
    this.heartbeat.unref();

    const address = this.server.address() as AddressInfo;
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const url = `http://${displayHost}:${address.port}/`;
    Logger.info('Avatar server listening', { url });
    return url;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    this.clients.forEach((client) => client.end());
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  clientCount(): number {
    return this.clients.size;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }

    if (url.pathname === '/events') {
      this.openStream(req, res);
      return;
    }

    if (url.pathname === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.lastChange));
      return;
    }

    this.serveStatic(url.pathname, res);
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    this.send(res, 'state', { ...this.lastChange, initial: true });
    req.on('close', () => this.clients.delete(res));
  }

  private broadcast(event: string, data: unknown): void {
    this.clients.forEach((client) => this.send(client, event, data));
  }

  private send(client: http.ServerResponse, event: string, data: unknown): void {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const decoded = decodeURIComponent(pathname);
    let file: string | undefined;

    if (decoded.startsWith('/vendor/three/')) {
      if (this.threeDir) {
        const candidate = path.resolve(this.threeDir, decoded.slice('/vendor/three/'.length));
        const inside = candidate.startsWith(this.threeDir + path.sep);
        const allowed = inside && THREE_ALLOWED.some((dir) => candidate.startsWith(path.join(this.threeDir!, dir)));
        file = allowed ? candidate : undefined;
      }
    } else {
      // Pastas (ex.: /variants/pointcloud/) abrem o index.html.
      const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
      const candidate = path.resolve(this.publicDir, relative.replace(/^\/+/, ''));
      // Impede acesso fora da pasta do avatar (ex.: /../.env).
      file = candidate.startsWith(this.publicDir + path.sep) ? candidate : undefined;
    }

    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }
}
