import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../../infrastructure/config/Config';
import { Logger } from '../../infrastructure/logging/Logger';

const WINDOWS_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const UNIX_BROWSERS = ['chromium-browser', 'chromium', 'google-chrome', 'microsoft-edge'];

export interface AvatarWindowOptions {
  mode: 'app' | 'browser' | 'none';
  fullscreen: boolean;
  width?: number;
  height?: number;
}

/**
 * Abre o avatar numa janela própria, sem barras de navegador (Chromium/Edge --app),
 * ou em tela cheia (--kiosk), pronto para um display dedicado.
 * Retorna o processo para ser encerrado junto com a Celeste.
 */
export function openAvatarWindow(url: string, options: AvatarWindowOptions): ChildProcess | undefined {
  if (options.mode === 'none') {
    return undefined;
  }

  const browser = options.mode === 'app' ? findChromium() : undefined;
  if (!browser) {
    openDefaultBrowser(url);
    return undefined;
  }

  // Perfil separado: janela independente, que pode ser fechada junto com a Celeste.
  const profileDir = path.resolve(Config.audioTempDir, '..', 'avatar-profile');
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${options.width ?? 420},${options.height ?? 560}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,msEdgeSidebarV2,msUndersideButton',
    // Em notebooks com duas GPUs, usa a dedicada (ex.: GTX 1050 Ti) para o holograma WebGL.
    '--force_high_performance_gpu',
    ...(options.fullscreen ? ['--kiosk'] : []),
  ];

  try {
    const child = spawn(browser, args, { stdio: 'ignore', detached: false });
    child.on('error', (error) => Logger.warn('Could not open avatar window', { error: error.message }));
    Logger.info('Avatar window opened', { browser: path.basename(browser) });
    return child;
  } catch (error) {
    Logger.warn('Could not open avatar window', { error: String(error) });
    openDefaultBrowser(url);
    return undefined;
  }
}

function findChromium(): string | undefined {
  if (process.platform === 'win32') {
    return WINDOWS_BROWSERS.find((candidate) => fs.existsSync(candidate));
  }
  if (process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return fs.existsSync(chrome) ? chrome : undefined;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const name of UNIX_BROWSERS) {
    const found = dirs.map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
    if (found) {
      return found;
    }
  }
  return undefined;
}

function openDefaultBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command, args as string[], { stdio: 'ignore', detached: true }).unref();
}
