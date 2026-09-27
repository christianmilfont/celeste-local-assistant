import { TvCommand, TvController, TvDevice } from '../core/types/tv';
import { TvError } from '../core/errors';
import { Logger } from '../infrastructure/logging/Logger';
import { normalizeCommand } from './nlu/text';

/** Onde as TVs conhecidas (e seus tokens) ficam guardadas. */
export interface TvRegistry {
  load(): TvDevice[];
  save(devices: TvDevice[]): void;
}

export interface TvControllerHooks {
  onToken: (token: string) => void;
  onMac: (mac: string) => void;
}

/** Cria o controlador da marca; undefined = marca ainda não suportada. */
export type TvControllerFactory = (device: TvDevice, hooks: TvControllerHooks) => TvController | undefined;

export interface TvServiceOptions {
  discover: () => Promise<TvDevice[]>;
  /** Fala algo no meio de uma ação longa (ex.: "aceite o pedido na TV"). */
  notify?: (text: string) => Promise<void>;
  /** Apelidos configurados: IP ou id → apelido ("sala"). */
  aliases?: Record<string, string>;
}

const BRAND_NAMES: Record<string, string> = { samsung: 'Samsung', lg: 'LG', android: 'Android TV' };
const NEEDS_POWER = ['VOLUME_UP', 'VOLUME_DOWN', 'MUTE', 'PAUSE', 'PLAY', 'HOME', 'OPEN_APP'];

/**
 * Controle das Smart TVs pela rede local. Recebe comandos já interpretados (TvCommand)
 * e devolve a resposta falada. Não conhece protocolos: isso fica nos controladores de cada marca.
 */
export class TvService {
  private devices: TvDevice[];

  constructor(
    private registry: TvRegistry,
    private createController: TvControllerFactory,
    private options: TvServiceOptions
  ) {
    this.devices = registry.load();
    this.applyAliases();
  }

  list(): TvDevice[] {
    return [...this.devices];
  }

  /** Na inicialização: se ainda não conhece nenhuma TV, procura na rede (em segundo plano). */
  async init(): Promise<void> {
    if (this.devices.length === 0) {
      await this.discover().catch((error) => Logger.warn('TV discovery failed', { error: String(error) }));
    }
  }

  /** Procura TVs na rede e atualiza o registro (IP novo para TVs já conhecidas). */
  async discover(): Promise<TvDevice[]> {
    const found = await this.options.discover();
    for (const tv of found) {
      // Mesmo id, ou (fallback) mesma marca no mesmo IP: é a mesma TV.
      const known =
        this.devices.find((d) => d.id === tv.id) ||
        this.devices.find((d) => d.ip === tv.ip && d.brand === tv.brand);
      if (known) {
        known.id = tv.id;
        known.ip = tv.ip;
        known.name = tv.name;
        known.model = tv.model ?? known.model;
        known.mac = tv.mac ?? known.mac;
      } else {
        this.devices.push(tv);
      }
    }
    this.applyAliases();
    this.persist();
    return found;
  }

  async execute(command: TvCommand): Promise<string> {
    if (command.action === 'DISCOVER') {
      return this.describeDiscovery(await this.discover());
    }

    if (this.devices.length === 0) {
      await this.discover();
      if (this.devices.length === 0) {
        return 'Não encontrei nenhuma TV na rede. Verifique se ela está ligada e conectada à mesma rede, e diga "procurar TVs".';
      }
    }

    const device = this.resolve(command.target);
    if (!device) {
      return `Não conheço uma TV chamada ${command.target}. As TVs que conheço são: ${this.devices.map((d) => this.spokenName(d)).join(', ')}.`;
    }

    try {
      return await this.run(device, command);
    } catch (error) {
      // O IP pode ter mudado (DHCP): redescobre pelo id e tenta mais uma vez.
      if (error instanceof TvError && error.code === 'UNREACHABLE' && command.action !== 'POWER_ON') {
        const oldIp = device.ip;
        await this.discover().catch(() => undefined);
        if (device.ip !== oldIp) {
          try {
            return await this.run(device, command);
          } catch (retryError) {
            return this.errorReply(device, retryError, command);
          }
        }
      }
      return this.errorReply(device, error, command);
    }
  }

  // ---- ações -------------------------------------------------------------------

  private async run(device: TvDevice, command: TvCommand): Promise<string> {
    const controller = this.createController(device, {
      onToken: (token) => {
        device.token = token;
        this.persist();
      },
      onMac: (mac) => {
        device.mac = mac;
        this.persist();
      },
    });
    const name = this.spokenName(device);
    if (!controller) {
      return `Ainda não sei controlar TVs ${BRAND_NAMES[device.brand] ?? 'dessa marca'}.`;
    }

    const state = await controller.getPowerState();

    if (command.action === 'STATUS') {
      return state === 'on'
        ? `A ${name} está ligada.`
        : state === 'standby'
          ? `A ${name} está em modo de espera.`
          : `A ${name} está desligada ou fora da rede.`;
    }
    if (command.action === 'POWER_ON') {
      if (state === 'on') return `A ${name} já está ligada.`;
      await controller.powerOn();
      return `Liguei a ${name}.`;
    }
    if (state !== 'on') {
      if (command.action === 'POWER_OFF') return `A ${name} já está desligada.`;
      if (NEEDS_POWER.includes(command.action)) return `A ${name} está desligada. Diga "liga a TV" primeiro.`;
    }

    if (!device.token && this.options.notify) {
      await this.options.notify(`Vou me conectar à ${name}. Aceite o pedido de autorização que vai aparecer na tela da TV.`);
    }

    switch (command.action) {
      case 'PAIR':
        return (await controller.pair()) ? `Pronto, estou conectada à ${name}.` : `Conectei à ${name}.`;
      case 'POWER_OFF':
        await controller.powerOff();
        return `Desliguei a ${name}.`;
      case 'VOLUME_UP':
      case 'VOLUME_DOWN': {
        const steps = Math.min(Math.max(Math.round(command.amount ?? 3), 1), 25);
        await controller.sendKeys(new Array(steps).fill(command.action === 'VOLUME_UP' ? 'KEY_VOLUP' : 'KEY_VOLDOWN'));
        return `${command.action === 'VOLUME_UP' ? 'Aumentei' : 'Diminuí'} o volume da ${name} em ${steps}.`;
      }
      case 'MUTE':
        await controller.sendKeys(['KEY_MUTE']);
        return `Pronto, alternei o mudo da ${name}.`;
      case 'PAUSE':
        await controller.sendKeys(['KEY_PAUSE']);
        return `Pausei a ${name}.`;
      case 'PLAY':
        await controller.sendKeys(['KEY_PLAY']);
        return 'Pronto, continuando.';
      case 'HOME':
        await controller.sendKeys(['KEY_HOME']);
        return `Voltei para a tela inicial da ${name}.`;
      case 'OPEN_APP': {
        if (!command.app) return 'Qual aplicativo você quer abrir na TV?';
        const opened = await controller.launchApp(command.app);
        return `Abrindo ${opened} na ${name}.`;
      }
      default:
        return 'Não entendi o que fazer com a TV.';
    }
  }

  private errorReply(device: TvDevice, error: unknown, command: TvCommand): string {
    const name = this.spokenName(device);
    Logger.warn('TV command failed', { tv: device.name, action: command.action, error: String(error) });
    if (!(error instanceof TvError)) {
      return `Não consegui controlar a ${name}.`;
    }
    switch (error.code) {
      case 'PAIRING_TIMEOUT':
        return `A ${name} pediu autorização na tela. Aceite com o controle remoto e repita o comando.`;
      case 'UNAUTHORIZED':
        return `A ${name} recusou a conexão. Diga "conectar na TV" e aceite o pedido na tela.`;
      case 'APP_NOT_FOUND':
        return `Não encontrei o aplicativo ${command.app} na ${name}.`;
      case 'NO_MAC':
        return `Ainda não sei o endereço de rede da ${name} para ligá-la. Com a TV ligada, diga "status da TV" uma vez para eu registrar.`;
      case 'WOL_NO_RESPONSE':
        return `Enviei o sinal para ligar a ${name}, mas ela não respondeu. Verifique se a opção "Ligar com dispositivo móvel" está ativada, em Configurações, Geral, Rede, Configurações especialistas.`;
      default:
        return `Não consegui falar com a ${name}. Ela está ligada e na mesma rede?`;
    }
  }

  private describeDiscovery(found: TvDevice[]): string {
    if (found.length === 0) {
      return 'Não encontrei nenhuma TV na rede. As TVs precisam estar ligadas (ou em modo de espera de rede) e na mesma rede.';
    }
    const names = found.map((tv) => `${tv.name.replace(/^\[TV\]\s*/, '')}`);
    return found.length === 1
      ? `Encontrei uma TV: ${names[0]}.`
      : `Encontrei ${found.length} TVs: ${names.join(', ')}.`;
  }

  // ---- escolha da TV -----------------------------------------------------------

  /** Sem alvo: a primeira TV. Com alvo ("sala", "samsung"): compara com apelido, nome e marca. */
  resolve(target?: string): TvDevice | undefined {
    if (!target) {
      return this.devices[0];
    }
    const wanted = normalizeCommand(target);
    return this.devices.find((device) =>
      [device.alias, device.name, BRAND_NAMES[device.brand], device.model]
        .filter(Boolean)
        .some((label) => normalizeCommand(String(label)).includes(wanted))
    );
  }

  private spokenName(device: TvDevice): string {
    if (device.alias) return `TV ${device.alias}`;
    if (this.devices.length > 1) return `TV ${BRAND_NAMES[device.brand] ?? device.name}`;
    return 'TV';
  }

  private applyAliases(): void {
    const aliases = this.options.aliases ?? {};
    for (const device of this.devices) {
      const alias = aliases[device.ip] ?? aliases[device.id];
      if (alias) device.alias = alias;
    }
  }

  private persist(): void {
    try {
      this.registry.save(this.devices);
    } catch (error) {
      Logger.warn('Could not save TV registry', { error: String(error) });
    }
  }
}
