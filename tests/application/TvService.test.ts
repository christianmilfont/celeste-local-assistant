import { TvService, TvRegistry, TvControllerFactory } from '../../src/application/TvService';
import { IntentClassifier } from '../../src/application/IntentClassifier';
import { TvController, TvDevice, TvPowerState } from '../../src/core/types/tv';
import { TvError } from '../../src/core/errors';

class MemoryRegistry implements TvRegistry {
  saved: TvDevice[] = [];
  constructor(private initial: TvDevice[] = []) {}
  load() {
    return JSON.parse(JSON.stringify(this.initial));
  }
  save(devices: TvDevice[]) {
    this.saved = JSON.parse(JSON.stringify(devices));
  }
}

class FakeController implements TvController {
  keys: string[] = [];
  apps: string[] = [];
  state: TvPowerState = 'on';
  fail?: TvError;
  constructor(public device: TvDevice) {}
  async getPowerState() {
    if (this.fail?.code === 'UNREACHABLE') throw this.fail;
    return this.state;
  }
  async powerOn() {
    if (this.fail) throw this.fail;
    this.state = 'on';
  }
  async powerOff() {
    this.keys.push('KEY_POWER');
    this.state = 'standby';
  }
  async sendKeys(keys: string[]) {
    if (this.fail) throw this.fail;
    this.keys.push(...keys);
  }
  async launchApp(name: string) {
    this.apps.push(name);
    return name === 'youtube' ? 'YouTube' : name;
  }
  async pair() {
    return 'TOKEN';
  }
}

const SAMSUNG: TvDevice = { id: 'uuid-1', name: '[TV] Samsung 7 Series (43)', brand: 'samsung', ip: '192.168.15.74', token: 'T' };

function setup(devices: TvDevice[] = [SAMSUNG], found: TvDevice[] = []) {
  const registry = new MemoryRegistry(devices);
  const controllers: FakeController[] = [];
  const factory: TvControllerFactory = (device) => {
    if (device.brand !== 'samsung') return undefined;
    const controller = new FakeController(device);
    controllers.push(controller);
    return controller;
  };
  const discover = jest.fn(async () => found);
  const notify = jest.fn(async () => undefined);
  const service = new TvService(registry, factory, { discover, notify });
  const last = () => controllers[controllers.length - 1];
  return { service, registry, discover, notify, last, controllers };
}

describe('TvService', () => {
  it('turns the TV off only when it is on', async () => {
    const { service, last } = setup();
    expect(await service.execute({ action: 'POWER_OFF' })).toBe('Desliguei a TV.');
    expect(last().keys).toEqual(['KEY_POWER']);
  });

  it('says it is already off', async () => {
    const { service, controllers } = setup();
    const reply = service.execute({ action: 'STATUS' });
    await reply;
    controllers[0].state = 'standby';
    // novo controlador por comando: simula a TV já em standby
    const s2 = setup();
    const original = s2.service['createController'];
    s2.service['createController'] = (d, h) => {
      const c = original(d, h) as FakeController;
      c.state = 'standby';
      return c;
    };
    expect(await s2.service.execute({ action: 'POWER_OFF' })).toBe('A TV já está desligada.');
  });

  it('changes the volume by the requested steps (default 3, max 25)', async () => {
    const { service, last } = setup();
    expect(await service.execute({ action: 'VOLUME_UP', amount: 5 })).toBe('Aumentei o volume da TV em 5.');
    expect(last().keys).toEqual(new Array(5).fill('KEY_VOLUP'));
    expect(await service.execute({ action: 'VOLUME_DOWN' })).toBe('Diminuí o volume da TV em 3.');
    await service.execute({ action: 'VOLUME_UP', amount: 99 });
    expect(last().keys).toHaveLength(25);
  });

  it('opens apps, mutes and pauses', async () => {
    const { service, last } = setup();
    expect(await service.execute({ action: 'OPEN_APP', app: 'youtube' })).toBe('Abrindo YouTube na TV.');
    expect(await service.execute({ action: 'MUTE' })).toBe('Pronto, alternei o mudo da TV.');
    expect(last().keys).toEqual(['KEY_MUTE']);
    expect(await service.execute({ action: 'PAUSE' })).toBe('Pausei a TV.');
  });

  it('asks to turn on the TV before volume/app commands', async () => {
    const { service } = setup();
    const original = service['createController'];
    service['createController'] = (d, h) => {
      const c = original(d, h) as FakeController;
      c.state = 'off';
      return c;
    };
    expect(await service.execute({ action: 'VOLUME_UP' })).toContain('está desligada');
  });

  it('explains Wake-on-LAN problems', async () => {
    const { service } = setup();
    const original = service['createController'];
    service['createController'] = (d, h) => {
      const c = original(d, h) as FakeController;
      c.state = 'off';
      c.fail = new TvError('WOL_NO_RESPONSE');
      return c;
    };
    expect(await service.execute({ action: 'POWER_ON' })).toContain('Ligar com dispositivo móvel');
  });

  it('asks the user to accept the authorization on the TV the first time', async () => {
    const { service, notify } = setup([{ ...SAMSUNG, token: undefined }]);
    await service.execute({ action: 'MUTE' });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Aceite o pedido de autorização'));
  });

  it('turns pairing timeouts into a clear instruction', async () => {
    const { service } = setup();
    const original = service['createController'];
    service['createController'] = (d, h) => {
      const c = original(d, h) as FakeController;
      c.fail = new TvError('PAIRING_TIMEOUT');
      return c;
    };
    expect(await service.execute({ action: 'MUTE' })).toContain('Aceite com o controle remoto');
  });

  it('rediscovers the TV when its IP changed (DHCP) and retries', async () => {
    const moved = { ...SAMSUNG, ip: '192.168.15.80', token: undefined };
    const { service, discover, registry } = setup([SAMSUNG], [moved]);
    let first = true;
    const original = service['createController'];
    service['createController'] = (d, h) => {
      const c = original(d, h) as FakeController;
      if (first) {
        first = false;
        c.fail = new TvError('UNREACHABLE');
      }
      return c;
    };
    expect(await service.execute({ action: 'MUTE' })).toBe('Pronto, alternei o mudo da TV.');
    expect(discover).toHaveBeenCalled();
    expect(registry.saved[0].ip).toBe('192.168.15.80');
    expect(registry.saved[0].token).toBe('T');
  });

  it('does not duplicate a TV rediscovered with another UPnP id on the same IP', async () => {
    const sameTvOtherUdn = { ...SAMSUNG, id: 'uuid-2', token: undefined, mac: 'AA:BB:CC:DD:EE:FF' };
    const { service, registry } = setup([SAMSUNG], [sameTvOtherUdn]);
    await service.discover();
    expect(service.list()).toHaveLength(1);
    expect(registry.saved[0]).toMatchObject({ id: 'uuid-2', token: 'T', mac: 'AA:BB:CC:DD:EE:FF' });
  });

  it('discovers TVs when none is known and on request', async () => {
    const { service, discover } = setup([], [SAMSUNG]);
    expect(await service.execute({ action: 'DISCOVER' })).toBe('Encontrei uma TV: Samsung 7 Series (43).');
    expect(discover).toHaveBeenCalledTimes(1);
    expect(service.list()).toHaveLength(1);
  });

  it('reports when there is no TV on the network', async () => {
    const { service } = setup([], []);
    expect(await service.execute({ action: 'POWER_OFF' })).toContain('Não encontrei nenhuma TV');
  });

  it('targets TVs by alias/brand and refuses unsupported brands', async () => {
    const lg: TvDevice = { id: 'lg-1', name: 'LG webOS TV', brand: 'lg', ip: '192.168.15.90', alias: 'do quarto' };
    const { service } = setup([SAMSUNG, lg]);
    expect(await service.execute({ action: 'POWER_OFF', target: 'quarto' })).toBe('Ainda não sei controlar TVs LG.');
    expect(await service.execute({ action: 'MUTE', target: 'samsung' })).toBe('Pronto, alternei o mudo da TV Samsung.');
    expect(await service.execute({ action: 'MUTE', target: 'cozinha' })).toContain('Não conheço uma TV chamada cozinha');
  });
});

describe('TV intents', () => {
  const classifier = new IntentClassifier();
  const cases: Array<[string, object]> = [
    ['Celeste, desliga a TV', { action: 'POWER_OFF' }],
    ['desligue a televisão da sala', { action: 'POWER_OFF', target: 'sala' }],
    ['liga a TV', { action: 'POWER_ON' }],
    ['aumenta o volume', { action: 'VOLUME_UP' }],
    ['aumenta o volume da TV em 5', { action: 'VOLUME_UP', amount: 5 }],
    ['abaixa o som em três', { action: 'VOLUME_DOWN', amount: 3 }],
    ['tira o som da TV', { action: 'MUTE' }],
    ['abre o YouTube', { action: 'OPEN_APP', app: 'youtube' }],
    ['coloca a Netflix na TV', { action: 'OPEN_APP', app: 'netflix' }],
    ['pausa o filme', { action: 'PAUSE' }],
    ['continua o vídeo', { action: 'PLAY' }],
    ['a TV está ligada?', { action: 'STATUS' }],
    ['procurar TVs', { action: 'DISCOVER' }],
    ['conectar na TV', { action: 'PAIR' }],
  ];

  it.each(cases)('"%s"', (text, tv) => {
    expect(classifier.classifyDeterministic(text)).toMatchObject({ intent: 'TV_CONTROL', tv });
  });

  it.each(['desligar', 'Celeste, status', 'fala mais alto', 'responde que já vou ligar a TV'])(
    '"%s" is not a TV command',
    (text) => {
      expect(classifier.classifyDeterministic(text)?.intent).not.toBe('TV_CONTROL');
    }
  );
});
