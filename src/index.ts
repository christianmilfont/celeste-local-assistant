import * as fs from 'fs';
import * as path from 'path';
import { Celeste } from './core/Celeste';
import { BaileysWhatsAppAdapter } from './adapters/whatsapp/BaileysWhatsAppAdapter';
import { OllamaProvider } from './adapters/ai/OllamaProvider';
import { WhisperProvider } from './adapters/stt/WhisperProvider';
import { PiperTTSProvider } from './adapters/tts/PiperTTSProvider';
import { createAudioRecorder } from './adapters/audio';
import { TerminalInterface } from './interfaces/cli/TerminalInterface';
import { AvatarServer } from './interfaces/avatar/AvatarServer';
import { openAvatarWindow } from './interfaces/avatar/avatarWindow';
import { Config } from './infrastructure/config/Config';
import { Logger } from './infrastructure/logging/Logger';

async function main() {
  let celeste: Celeste | undefined;
  try {
    console.log('Iniciando a Celeste...');

    const messagingAdapter = new BaileysWhatsAppAdapter();
    const aiProvider = new OllamaProvider();
    const sttProvider = new WhisperProvider();
    const ttsProvider = new PiperTTSProvider();
    const audioRecorder = createAudioRecorder();

    celeste = new Celeste(
      messagingAdapter,
      aiProvider,
      sttProvider,
      ttsProvider,
      audioRecorder
    );

    // Garante que gravador/Whisper/TTS/janela do avatar não fiquem órfãos se o processo terminar.
    const instance = celeste;
    let avatarWindow: ReturnType<typeof openAvatarWindow>;
    process.on('exit', () => {
      instance.dispose();
      avatarWindow?.kill();
    });

    const avatarUrl = await startAvatar(celeste);
    if (avatarUrl) {
      avatarWindow = openAvatarWindow(avatarUrl, {
        mode: Config.avatarWindow,
        fullscreen: Config.avatarFullscreen,
      });
    }

    await celeste.start();

    await waitForWhatsApp(() => messagingAdapter.isConnected());

    new TerminalInterface(celeste, avatarUrl).start();
  } catch (error) {
    Logger.error('Failed to start Celeste', error);
    celeste?.dispose();
    process.exit(1);
  }
}

/** Inicia o servidor do avatar 2D. Uma falha aqui não impede a Celeste de funcionar. */
async function startAvatar(celeste: Celeste): Promise<string | undefined> {
  if (!Config.avatarEnabled) {
    return undefined;
  }
  try {
    return await new AvatarServer(celeste).start(Config.avatarPort, Config.avatarHost);
  } catch (error) {
    Logger.warn('Avatar server could not start', { error: String(error) });
    return undefined;
  }
}

/** Aguarda a conexão (ou a leitura do QR Code na primeira execução) antes de exibir o painel. */
async function waitForWhatsApp(isConnected: () => boolean): Promise<void> {
  const hasSession = isWhatsAppPaired();
  const timeoutMs = hasSession ? 15000 : Config.whatsappAuthTimeout;
  if (!hasSession) {
    console.log('Aguardando conexão com o WhatsApp (escaneie o QR Code se ele aparecer)...');
  }

  const deadline = Date.now() + timeoutMs;
  while (!isConnected() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A sessão só está pareada depois que o QR Code foi escaneado (creds.me preenchido). */
function isWhatsAppPaired(): boolean {
  try {
    const creds = JSON.parse(
      fs.readFileSync(path.join(Config.whatsappSessionPath, 'creds.json'), 'utf-8')
    );
    return Boolean(creds?.me?.id);
  } catch {
    return false;
  }
}

main();
