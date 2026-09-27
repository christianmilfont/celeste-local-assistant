import * as http from 'http';

// Wake-on-LAN real enviaria pacotes UDP na rede: nos testes só registramos as chamadas.
jest.mock('../../src/adapters/tv/wakeOnLan', () => {
  const actual = jest.requireActual('../../src/adapters/tv/wakeOnLan');
  return { ...actual, wakeOnLan: jest.fn(async () => undefined) };
});
import { wakeOnLan } from '../../src/adapters/tv/wakeOnLan';
import { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { SamsungTvController } from '../../src/adapters/tv/SamsungTvController';
import { magicPacket } from '../../src/adapters/tv/wakeOnLan';
import { detectBrand, parseDeviceDescription, parseSsdpResponse } from '../../src/adapters/tv/TvDiscovery';
import { TvDevice } from '../../src/core/types/tv';
import { TvError } from '../../src/core/errors';

/** TV Samsung simulada: API REST (status) + canal de controle por WebSocket. */
function fakeSamsungTv(options: { powerState?: string; acceptPairing?: boolean } = {}) {
  const received: any[] = [];
  const connections: string[] = [];
  let powerState = options.powerState ?? 'on';

  const api = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ device: { PowerState: powerState, wifiMac: '5C:C1:D7:C7:09:4B' } }));
  });
  const ws = new WebSocketServer({ port: 0 });
  ws.on('connection', (socket, request) => {
    const url = new URL(request.url || '', 'http://tv');
    connections.push(url.search);
    const token = url.searchParams.get('token');
    if (!token && options.acceptPairing === false) {
      socket.send(JSON.stringify({ event: 'ms.channel.unauthorized' }));
      return;
    }
    socket.send(JSON.stringify({ event: 'ms.channel.connect', data: { id: 'x', token: token || 'TOKEN123' } }));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      if (message.params?.event === 'ed.installedApp.get') {
        socket.send(JSON.stringify({
          event: 'ed.installedApp.get',
          data: { data: [{ appId: '111299001912', name: 'YouTube', app_type: 2 }, { appId: '3201907018807', name: 'Netflix', app_type: 2 }] },
        }));
      }
      if (message.params?.DataOfCmd === 'KEY_POWER') {
        powerState = powerState === 'on' ? 'standby' : 'on';
      }
    });
  });

  return {
    received,
    connections,
    async start() {
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()));
      await new Promise<void>((resolve) => (ws.address() ? resolve() : ws.once('listening', () => resolve())));
      return { apiPort: (api.address() as AddressInfo).port, remotePort: (ws.address() as AddressInfo).port };
    },
    async stop() {
      ws.clients.forEach((client) => client.terminate());
      await new Promise((resolve) => ws.close(resolve));
      await new Promise((resolve) => api.close(resolve));
    },
  };
}

function device(overrides: Partial<TvDevice> = {}): TvDevice {
  return { id: 'uuid-1', name: '[TV] Samsung 7 Series (43)', brand: 'samsung', ip: '127.0.0.1', ...overrides };
}

describe('SamsungTvController (TV simulada)', () => {
  let tv: ReturnType<typeof fakeSamsungTv>;
  afterEach(async () => tv && (await tv.stop()));

  async function controller(overrides: Partial<TvDevice> = {}, hooks = {}) {
    const ports = await tv.start();
    return new SamsungTvController(device(overrides), { ...ports, secure: false, pairingTimeoutMs: 2000, powerOnTimeoutMs: 4000, ...hooks });
  }

  it('reads the power state and reports the MAC for Wake-on-LAN', async () => {
    tv = fakeSamsungTv({ powerState: 'on' });
    const macs: string[] = [];
    const c = await controller({}, { onMac: (mac: string) => macs.push(mac) });
    expect(await c.getPowerState()).toBe('on');
    expect(macs).toEqual(['5C:C1:D7:C7:09:4B']);
  });

  it('reports standby and "off" when the TV does not answer', async () => {
    tv = fakeSamsungTv({ powerState: 'standby' });
    const c = await controller();
    expect(await c.getPowerState()).toBe('standby');
    const offline = new SamsungTvController(device({ ip: '127.0.0.1' }), { apiPort: 1, secure: false });
    expect(await offline.getPowerState()).toBe('off');
  });

  it('pairs on first use and stores the token; later connections reuse it', async () => {
    tv = fakeSamsungTv();
    const tokens: string[] = [];
    const c = await controller({}, { onToken: (t: string) => tokens.push(t) });
    await c.sendKeys(['KEY_MUTE'], 10);
    expect(tokens).toEqual(['TOKEN123']);
    expect(c.device.token).toBe('TOKEN123');
    await c.sendKeys(['KEY_MUTE'], 10);
    expect(tv.connections[0]).not.toContain('token=');
    expect(tv.connections[1]).toContain('token=TOKEN123');
    expect(tv.connections[0]).toContain(`name=${Buffer.from('Celeste').toString('base64')}`);
  });

  it('sends remote keys in the Tizen format', async () => {
    tv = fakeSamsungTv();
    const c = await controller({ token: 'T' });
    await c.sendKeys(['KEY_VOLUP', 'KEY_VOLUP'], 10);
    expect(tv.received).toEqual([
      { method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: 'false', TypeOfRemote: 'SendRemoteKey' } },
      { method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: 'false', TypeOfRemote: 'SendRemoteKey' } },
    ]);
  });

  it('powers off with KEY_POWER', async () => {
    tv = fakeSamsungTv({ powerState: 'on' });
    const c = await controller({ token: 'T' });
    await c.powerOff();
    expect(tv.received.map((m) => m.params.DataOfCmd)).toEqual(['KEY_POWER']);
  });

  it('powers on from network standby with KEY_POWER + Wake-on-LAN (unicast to the TV IP too)', async () => {
    tv = fakeSamsungTv({ powerState: 'standby' });
    const c = await controller({ token: 'T', mac: '5C:C1:D7:C7:09:4B' });
    await c.powerOn();
    expect(await c.getPowerState()).toBe('on');
    expect(wakeOnLan).toHaveBeenCalledWith('5C:C1:D7:C7:09:4B', 3, '127.0.0.1');
  });

  it('keeps resending Wake-on-LAN while waiting and reports the states on failure', async () => {
    (wakeOnLan as jest.Mock).mockClear();
    const off = new SamsungTvController(device({ mac: '5C:C1:D7:C7:09:4B' }), {
      apiPort: 1,
      secure: false,
      powerOnTimeoutMs: 9000,
    });
    await expect(off.powerOn()).rejects.toMatchObject({ code: 'WOL_NO_RESPONSE' });
    expect((wakeOnLan as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 15000);

  it('opens an app by name using the list installed on the TV', async () => {
    tv = fakeSamsungTv();
    const c = await controller({ token: 'T' });
    expect(await c.launchApp('youtube')).toBe('YouTube');
    const launch = tv.received.find((m) => m.params?.event === 'ed.apps.launch');
    expect(launch.params.data).toEqual({ appId: '111299001912', action_type: 'DEEP_LINK' });
  });

  it('fails clearly when the app does not exist or the TV refuses', async () => {
    tv = fakeSamsungTv({ acceptPairing: false });
    const c = await controller();
    await expect(c.sendKeys(['KEY_MUTE'])).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('asks Wake-on-LAN for the MAC when the TV is fully off', async () => {
    const off = new SamsungTvController(device(), { apiPort: 1, secure: false });
    await expect(off.powerOn()).rejects.toBeInstanceOf(TvError);
    await expect(off.powerOn()).rejects.toMatchObject({ code: 'NO_MAC' });
  });
});

describe('Wake-on-LAN and discovery helpers', () => {
  it('builds the magic packet (6 x 0xFF + 16 x MAC)', () => {
    const packet = magicPacket('5C:C1:D7:C7:09:4B');
    expect(packet.length).toBe(102);
    expect(packet.subarray(0, 6)).toEqual(Buffer.alloc(6, 0xff));
    expect(packet.subarray(6, 12)).toEqual(Buffer.from('5cc1d7c7094b', 'hex'));
    expect(packet.subarray(96, 102)).toEqual(Buffer.from('5cc1d7c7094b', 'hex'));
    expect(() => magicPacket('xx')).toThrow();
  });

  it('parses SSDP answers and UPnP descriptions', () => {
    const ssdp = parseSsdpResponse(
      'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.15.74:7678/nservice/\r\nSERVER: Samsung-Linux/4.1\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n',
      '192.168.15.74'
    );
    expect(ssdp).toEqual({
      ip: '192.168.15.74',
      location: 'http://192.168.15.74:7678/nservice/',
      server: 'Samsung-Linux/4.1',
      st: 'urn:dial-multiscreen-org:service:dial:1',
    });
    const description = parseDeviceDescription(
      '<root><device><friendlyName>[TV] Samsung 7 Series (43)</friendlyName><manufacturer>Samsung Electronics</manufacturer><modelName>UN43TU7000GXZD</modelName><UDN>uuid:c04b</UDN></device></root>'
    );
    expect(description).toEqual({
      friendlyName: '[TV] Samsung 7 Series (43)',
      manufacturer: 'Samsung Electronics',
      modelName: 'UN43TU7000GXZD',
      udn: 'uuid:c04b',
    });
    expect(detectBrand('Samsung Electronics')).toBe('samsung');
    expect(detectBrand('LG Electronics')).toBe('lg');
    expect(detectBrand('', '', 'urn:lge-com:service:webos-second-screen:1')).toBe('lg');
    expect(detectBrand('Acme')).toBe('unknown');
  });
});
