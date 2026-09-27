import * as http from 'http';
import WebSocket from 'ws';
import { TvController, TvDevice, TvPowerState } from '../../core/types/tv';
import { TvError } from '../../core/errors';
import { Logger } from '../../infrastructure/logging/Logger';
import { wakeOnLan } from './wakeOnLan';

export interface SamsungTvOptions {
  /** Nome que aparece no pedido de autorização da TV. */
  appName?: string;
  remotePort?: number;
  secure?: boolean;
  apiPort?: number;
  /** Chamado quando a TV concede (ou renova) o token. */
  onToken?: (token: string) => void;
  /** Chamado com o MAC informado pela API da TV (para Wake-on-LAN). */
  onMac?: (mac: string) => void;
  pairingTimeoutMs?: number;
  powerOnTimeoutMs?: number;
}

/** IDs conhecidos de apps Tizen, usados se a lista de apps instalados não vier. */
const KNOWN_APPS: Record<string, string> = {
  youtube: '111299001912',
  netflix: '3201907018807',
  'prime video': '3201910019365',
  'disney+': '3201901017640',
  spotify: '3201606009684',
  globoplay: '3201908019041',
};

interface InstalledApp {
  appId: string;
  name: string;
  app_type?: number;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+]/g, '');
}

/**
 * Samsung Smart TV (Tizen, 2016+) pela rede local:
 *  - status: GET http://IP:8001/api/v2/  (PowerState "on"/"standby")
 *  - comandos: WebSocket wss://IP:8002/api/v2/channels/samsung.remote.control (teclas do controle)
 *  - ligar: tecla POWER se estiver em standby de rede, senão Wake-on-LAN no MAC da TV
 * Na primeira conexão a TV pede autorização na tela e devolve um token, reutilizado depois.
 */
export class SamsungTvController implements TvController {
  private options: Required<Omit<SamsungTvOptions, 'onToken' | 'onMac'>> & Pick<SamsungTvOptions, 'onToken' | 'onMac'>;

  constructor(
    public readonly device: TvDevice,
    options: SamsungTvOptions = {}
  ) {
    this.options = {
      appName: 'Celeste',
      remotePort: 8002,
      secure: true,
      apiPort: 8001,
      pairingTimeoutMs: 30000,
      powerOnTimeoutMs: 30000,
      ...options,
    };
  }

  async getPowerState(): Promise<TvPowerState> {
    const info = await this.fetchInfo();
    if (!info) {
      return 'off';
    }
    const mac = info.device?.wifiMac;
    if (mac && mac !== this.device.mac) {
      this.options.onMac?.(mac);
    }
    const power = String(info.device?.PowerState || 'on').toLowerCase();
    return power === 'standby' ? 'standby' : 'on';
  }

  async powerOff(): Promise<void> {
    await this.sendKeys(['KEY_POWER']);
  }

  /**
   * Ligar pela rede:
   *  - modo de espera (API ainda responde): tecla POWER + Wake-on-LAN;
   *  - desligada (API fora do ar): Wake-on-LAN.
   * O pacote mágico é reenviado a cada poucos segundos enquanto aguardamos: TVs no Wi-Fi em
   * economia de energia acordam a placa de rede em intervalos e podem perder uma rajada única.
   */
  async powerOn(): Promise<void> {
    const initial = await this.getPowerState();
    Logger.info('TV power on requested', { tv: this.device.name, state: initial, mac: this.device.mac });
    if (initial === 'on') {
      return;
    }
    if (initial === 'off' && !this.device.mac) {
      throw new TvError('NO_MAC', 'MAC da TV desconhecido para Wake-on-LAN');
    }

    const wake = async () => {
      if (!this.device.mac) return;
      await wakeOnLan(this.device.mac, 3, this.device.ip).catch((error) =>
        Logger.warn('Wake-on-LAN failed', { error: String(error) })
      );
    };

    if (initial === 'standby') {
      await this.sendKeys(['KEY_POWER']).catch((error) =>
        Logger.debug('KEY_POWER in standby failed', { error: String(error) })
      );
    }
    await wake();

    const deadline = Date.now() + this.options.powerOnTimeoutMs;
    let lastWake = Date.now();
    let lastState: TvPowerState = initial;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      lastState = await this.getPowerState();
      if (lastState === 'on') {
        Logger.info('TV turned on', { tv: this.device.name, from: initial });
        return;
      }
      if (Date.now() - lastWake >= 4000) {
        await wake();
        lastWake = Date.now();
      }
    }
    Logger.warn('TV did not turn on', { tv: this.device.name, from: initial, lastState });
    throw new TvError('WOL_NO_RESPONSE', `A TV não respondeu ao sinal para ligar (estado inicial: ${initial}, final: ${lastState})`);
  }

  async sendKeys(keys: string[], intervalMs = 180): Promise<void> {
    const socket = await this.connect();
    try {
      for (const key of keys) {
        socket.send(
          JSON.stringify({
            method: 'ms.remote.control',
            params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
          })
        );
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      socket.close();
    }
  }

  async launchApp(name: string): Promise<string> {
    const socket = await this.connect();
    try {
      const installed = await this.installedApps(socket);
      const wanted = normalize(name);
      const app =
        installed.find((a) => normalize(a.name) === wanted) ||
        installed.find((a) => normalize(a.name).includes(wanted) || wanted.includes(normalize(a.name))) ||
        (KNOWN_APPS[name.toLowerCase()] ? { appId: KNOWN_APPS[name.toLowerCase()], name, app_type: 2 } : undefined);
      if (!app) {
        throw new TvError('APP_NOT_FOUND', `App "${name}" não encontrado na TV`);
      }
      socket.send(
        JSON.stringify({
          method: 'ms.channel.emit',
          params: {
            event: 'ed.apps.launch',
            to: 'host',
            data: { appId: app.appId, action_type: app.app_type === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH' },
          },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      return app.name;
    } finally {
      socket.close();
    }
  }

  async pair(): Promise<string | undefined> {
    const socket = await this.connect(true);
    socket.close();
    return this.device.token;
  }

  // ---- internos -------------------------------------------------------------

  private fetchInfo(): Promise<any | undefined> {
    return new Promise((resolve) => {
      const request = http.get(
        `http://${this.device.ip}:${this.options.apiPort}/api/v2/`,
        { timeout: 2000 },
        (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(undefined);
            }
          });
        }
      );
      request.on('error', () => resolve(undefined));
      request.on('timeout', () => {
        request.destroy();
        resolve(undefined);
      });
    });
  }

  /** Abre o canal de controle; sem token, a TV mostra o pedido de autorização e aguardamos. */
  private connect(forcePairing = false): Promise<WebSocket> {
    const name = Buffer.from(this.options.appName).toString('base64');
    const token = !forcePairing && this.device.token ? `&token=${this.device.token}` : '';
    const scheme = this.options.secure ? 'wss' : 'ws';
    const url = `${scheme}://${this.device.ip}:${this.options.remotePort}/api/v2/channels/samsung.remote.control?name=${name}${token}`;
    const waitingAuthorization = !token;

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
      const timer = setTimeout(
        () => {
          socket.terminate();
          reject(
            waitingAuthorization
              ? new TvError('PAIRING_TIMEOUT', 'Autorização não foi aceita na TV a tempo')
              : new TvError('UNREACHABLE', 'A TV não respondeu')
          );
        },
        waitingAuthorization ? this.options.pairingTimeoutMs : 8000
      );

      socket.on('message', (raw) => {
        let message: any;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.event === 'ms.channel.connect') {
          clearTimeout(timer);
          const newToken = message.data?.token;
          if (newToken && newToken !== this.device.token) {
            this.device.token = String(newToken);
            this.options.onToken?.(this.device.token);
          }
          resolve(socket);
        } else if (message.event === 'ms.channel.unauthorized') {
          clearTimeout(timer);
          socket.close();
          reject(new TvError('UNAUTHORIZED', 'A TV recusou a conexão'));
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        Logger.debug('Samsung TV socket error', { error: error.message });
        reject(new TvError('UNREACHABLE', error.message));
      });
    });
  }

  private installedApps(socket: WebSocket): Promise<InstalledApp[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.off('message', onMessage);
        resolve([]);
      }, 3000);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.event === 'ed.installedApp.get') {
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(Array.isArray(message.data?.data) ? message.data.data : []);
          }
        } catch {
          // ignora mensagens que não são JSON
        }
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } }));
    });
  }
}
