import * as dgram from 'dgram';
import * as http from 'http';
import { TvBrand, TvDevice } from '../../core/types/tv';
import { Logger } from '../../infrastructure/logging/Logger';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:dial-multiscreen-org:service:dial:1',
  'urn:samsung.com:device:RemoteControlReceiver:1',
  'urn:lge-com:service:webos-second-screen:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
];

export interface SsdpResponse {
  ip: string;
  location?: string;
  server?: string;
  st?: string;
}

export function parseSsdpResponse(message: string, ip: string): SsdpResponse {
  const header = (name: string) =>
    (message.match(new RegExp(`^${name}:\\s*(.+)$`, 'im')) || [])[1]?.trim();
  return { ip, location: header('location'), server: header('server'), st: header('st') };
}

export interface DeviceDescription {
  friendlyName?: string;
  manufacturer?: string;
  modelName?: string;
  udn?: string;
}

export function parseDeviceDescription(xml: string): DeviceDescription {
  const tag = (name: string) => (xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [])[1]?.trim();
  return {
    friendlyName: tag('friendlyName'),
    manufacturer: tag('manufacturer'),
    modelName: tag('modelName'),
    udn: tag('UDN'),
  };
}

export function detectBrand(manufacturer = '', server = '', st = ''): TvBrand {
  const text = `${manufacturer} ${server} ${st}`.toLowerCase();
  if (text.includes('samsung')) return 'samsung';
  if (text.includes('lg electronics') || text.includes('webos') || text.includes('lge')) return 'lg';
  if (text.includes('android') || text.includes('google')) return 'android';
  return 'unknown';
}

function httpGet(url: string, timeoutMs = 2500): Promise<string> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve(body));
    });
    request.on('error', () => resolve(''));
    request.on('timeout', () => {
      request.destroy();
      resolve('');
    });
  });
}

/**
 * Descobre TVs na rede local via SSDP/UPnP (o mesmo mecanismo do "espelhar tela").
 * Não envia nenhum comando às TVs: só pergunta "quem está aí" e lê a descrição UPnP.
 */
export async function discoverTvs(timeoutMs = 4000): Promise<TvDevice[]> {
  const responses = new Map<string, SsdpResponse[]>();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (message, remote) => {
    const parsed = parseSsdpResponse(message.toString(), remote.address);
    responses.set(remote.address, [...(responses.get(remote.address) || []), parsed]);
  });

  await new Promise<void>((resolve) => {
    socket.bind(0, () => {
      for (let round = 0; round < 2; round++) {
        for (const st of SEARCH_TARGETS) {
          const search = Buffer.from(
            `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
          );
          socket.send(search, SSDP_PORT, SSDP_ADDRESS);
        }
      }
      resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  socket.close();

  const devices: TvDevice[] = [];
  for (const [ip, list] of responses) {
    let description: DeviceDescription = {};
    for (const location of new Set(list.map((r) => r.location).filter(Boolean) as string[])) {
      description = { ...parseDeviceDescription(await httpGet(location)), ...description };
      if (description.manufacturer) break;
    }
    const server = list.map((r) => r.server).find(Boolean);
    const brand = detectBrand(description.manufacturer, server, list.map((r) => r.st).join(' '));
    const looksLikeTv =
      brand !== 'unknown' || /tv/i.test(description.friendlyName || '') || list.some((r) => /dial/i.test(r.st || ''));
    if (!looksLikeTv) continue;

    // A TV expõe vários serviços UPnP, cada um com seu UUID: para Samsung o id estável
    // (e o MAC para Wake-on-LAN) vêm da API REST da própria TV.
    let id = description.udn?.replace(/^uuid:/, '') || ip;
    let mac: string | undefined;
    if (brand === 'samsung') {
      try {
        const info = JSON.parse(await httpGet(`http://${ip}:8001/api/v2/`));
        id = String(info.device?.id || info.id || id).replace(/^uuid:/, '');
        mac = info.device?.wifiMac;
      } catch {
        // API indisponível: mantém o UUID do UPnP
      }
    }

    devices.push({
      id,
      name: description.friendlyName || `TV ${ip}`,
      brand,
      model: description.modelName,
      ip,
      ...(mac ? { mac } : {}),
    });
  }

  Logger.info('TV discovery finished', { found: devices.map((d) => `${d.name} (${d.ip})`) });
  return devices;
}
