/** Marcas com protocolo de controle pela rede local (sem hardware IoT). */
export type TvBrand = 'samsung' | 'lg' | 'android' | 'unknown';

/** TV conhecida pela Celeste (persistida na tabela settings). */
export interface TvDevice {
  /** Identificador estável (UDN/UUID do UPnP): sobrevive a troca de IP. */
  id: string;
  /** Nome exibido pela TV (ex.: "[TV] Samsung 7 Series (43)"). */
  name: string;
  /** Apelido usado nos comandos de voz (ex.: "sala"). */
  alias?: string;
  brand: TvBrand;
  model?: string;
  ip: string;
  /** MAC da interface de rede, para Wake-on-LAN. */
  mac?: string;
  /** Token de autorização concedido pela TV no pareamento. */
  token?: string;
}

export type TvPowerState = 'on' | 'standby' | 'off';

export type TvAction =
  | 'POWER_ON'
  | 'POWER_OFF'
  | 'VOLUME_UP'
  | 'VOLUME_DOWN'
  | 'MUTE'
  | 'PAUSE'
  | 'PLAY'
  | 'HOME'
  | 'OPEN_APP'
  | 'STATUS'
  | 'PAIR'
  | 'DISCOVER';

export interface TvCommand {
  action: TvAction;
  /** Nome/apelido da TV citado no comando ("sala"). Ausente = TV padrão. */
  target?: string;
  /** Passos de volume. */
  amount?: number;
  /** Nome do aplicativo ("YouTube"). */
  app?: string;
}

/**
 * Controle de uma TV pela rede local. Cada marca tem seu adaptador
 * (Samsung Tizen implementado; LG webOS / Android TV podem ser adicionados).
 */
export interface TvController {
  readonly device: TvDevice;
  getPowerState(): Promise<TvPowerState>;
  powerOn(): Promise<void>;
  powerOff(): Promise<void>;
  sendKeys(keys: string[], intervalMs?: number): Promise<void>;
  /** Abre um aplicativo pelo nome; retorna o nome encontrado na TV. */
  launchApp(name: string): Promise<string>;
  /** Faz o pareamento (a TV pede autorização na tela). Retorna o token. */
  pair(): Promise<string | undefined>;
}
