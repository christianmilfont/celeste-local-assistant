import * as dgram from 'dgram';
import * as os from 'os';

/** Pacote mágico: 6 bytes 0xFF + 16 repetições do MAC. */
export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) {
    throw new Error(`MAC inválido: ${mac}`);
  }
  const macBytes = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) {
    macBytes.copy(packet, 6 + i * 6);
  }
  return packet;
}

/** Endereços de broadcast das redes IPv4 locais (ex.: 192.168.15.255) + global. */
export function broadcastAddresses(): string[] {
  const addresses = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal || !info.netmask) continue;
      const ip = info.address.split('.').map(Number);
      const mask = info.netmask.split('.').map(Number);
      addresses.add(ip.map((part, i) => (part & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...addresses];
}

/**
 * Envia o pacote mágico algumas vezes, para as portas 9 e 7, em todos os broadcasts e também
 * direto para o IP do aparelho (unicast). Roteadores Wi-Fi muitas vezes não repassam broadcast
 * para clientes em economia de energia, mas entregam o unicast (o PC já conhece o MAC via ARP).
 */
export async function wakeOnLan(mac: string, repeat = 3, unicastIp?: string): Promise<void> {
  const packet = magicPacket(mac);
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(() => {
      socket.setBroadcast(true);
      resolve();
    });
  });
  try {
    for (let r = 0; r < repeat; r++) {
      for (const address of [...broadcastAddresses(), ...(unicastIp ? [unicastIp] : [])]) {
        for (const port of [9, 7]) {
          await new Promise<void>((resolve) => socket.send(packet, port, address, () => resolve()));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    socket.close();
  }
}
