import { TvControllerFactory } from '../../application/TvService';
import { SamsungTvController } from './SamsungTvController';

/** Controlador por marca. LG webOS / Android TV podem ser adicionados aqui. */
export const createTvController: TvControllerFactory = (device, hooks) => {
  switch (device.brand) {
    case 'samsung':
      return new SamsungTvController(device, hooks);
    default:
      return undefined;
  }
};

export { SamsungTvController } from './SamsungTvController';
export { discoverTvs } from './TvDiscovery';
export { wakeOnLan } from './wakeOnLan';
