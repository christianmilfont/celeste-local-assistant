import * as readline from 'readline';
import { Celeste } from '../../core/Celeste';
import { VoicePipelineState } from '../../core/types';
import { Logger } from '../../infrastructure/logging/Logger';

const LINE = '────────────────────────────────────────';

/**
 * Interface de terminal: comandos digitados + push-to-talk (ENTER para falar).
 * Toda entrada, digitada ou falada, é processada pela Celeste da mesma forma.
 */
export class TerminalInterface {
  private rl!: readline.Interface;
  private typedCommandRunning = false;
  private shuttingDown = false;
  private lastSigint = 0;
  private whatsappWatcher?: NodeJS.Timeout;
  private lastWhatsappState = false;

  constructor(private celeste: Celeste) {}

  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    this.subscribe();
    this.renderHeader();
    this.showIdleHint();

    this.rl.on('line', (line) => void this.handleLine(line));
    this.rl.on('SIGINT', () => void this.handleInterrupt());
    this.rl.on('close', () => void this.shutdown());

    this.lastWhatsappState = this.celeste.getStatus().whatsapp;
    this.whatsappWatcher = setInterval(() => this.watchWhatsapp(), 2000);
    this.whatsappWatcher.unref();
  }

  private subscribe(): void {
    this.celeste.onVoiceStateChange((state, previous) => this.renderVoiceState(state, previous));

    this.celeste.onVoiceTurn((result) => {
      if (result.result?.shouldStop) {
        void this.shutdown();
      }
    });

    this.celeste.on('VOICE_TRANSCRIBED', (event) => {
      this.print(`\n📝 Você disse:\n"${event.data?.transcription}"`);
    });

    this.celeste.on('ASSISTANT_SPEECH', (event) => {
      this.print(`\n🔊 Celeste:\n"${event.data?.text}"\n`);
    });

    this.celeste.on('MESSAGE_RECEIVED', (event) => {
      const from = event.data?.senderName || 'contato desconhecido';
      this.print(`\n📩 Nova mensagem de ${from}`);
    });

    this.celeste.on('ERROR', (event) => {
      if (event.data?.code === 'TTS_UNAVAILABLE') {
        this.print(`⚠️  ${event.data.message}`);
      }
    });
  }

  private async handleLine(line: string): Promise<void> {
    const input = line.trim();

    if (input === '/stop') {
      await this.shutdown();
      return;
    }

    // Push-to-talk: o segundo ENTER finaliza a gravação.
    if (this.celeste.getVoiceState() === 'RECORDING') {
      await this.celeste.finishVoiceInput();
      return;
    }

    if (this.typedCommandRunning || this.isVoiceBusy()) {
      this.print('⏳ Aguarde, ainda estou processando o comando anterior. (Ctrl+C cancela)');
      return;
    }

    if (input === '' || input === '/voice') {
      await this.startVoice();
    } else if (input === '/status') {
      this.print('🔎 Verificando serviços...');
      await this.celeste.checkServices();
      this.renderStatus();
      this.showIdleHint();
    } else if (input === '/help') {
      this.renderHelp();
    } else if (input.startsWith('/')) {
      this.print('Comando desconhecido. Digite /help para ver os comandos.');
    } else {
      await this.runTypedCommand(input);
    }
  }

  private async startVoice(): Promise<void> {
    if (!this.celeste.isVoiceEnabled()) {
      this.print('⚠️  Entrada de voz indisponível (nenhum gravador de áudio configurado).');
      return;
    }
    await this.celeste.startVoiceInput();
  }

  private async runTypedCommand(input: string): Promise<void> {
    this.typedCommandRunning = true;
    this.print('🧠 Processando...');
    try {
      const result = await this.celeste.respond(input, 'cli');
      if (result.shouldStop) {
        await this.shutdown();
        return;
      }
    } catch (error) {
      Logger.error('Error processing typed command', error);
      this.print('⚠️  Ocorreu um erro ao processar o comando.');
    } finally {
      this.typedCommandRunning = false;
    }
    this.showIdleHint();
  }

  /** Ctrl+C: cancela gravação/processamento/fala; em repouso, pressione duas vezes para sair. */
  private async handleInterrupt(): Promise<void> {
    if (this.isVoiceBusy()) {
      await this.celeste.cancelVoiceInput();
      this.print('\n⏹️  Cancelado.');
      this.showIdleHint();
      return;
    }

    this.celeste.stopSpeaking();

    const now = Date.now();
    if (now - this.lastSigint < 3000) {
      await this.shutdown();
      return;
    }
    this.lastSigint = now;
    this.print('\n(Pressione Ctrl+C novamente para sair, ou digite /stop)');
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    if (this.whatsappWatcher) {
      clearInterval(this.whatsappWatcher);
    }

    process.stdout.write('\nEncerrando a Celeste...\n');
    try {
      await Promise.race([
        this.celeste.stop(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (error) {
      Logger.error('Error during shutdown', error);
    }
    process.stdout.write('Celeste encerrada. Até logo!\n');
    this.rl.close();
    process.exit(0);
  }

  private renderVoiceState(state: VoicePipelineState, previous: VoicePipelineState): void {
    switch (state) {
      case 'RECORDING':
        this.print('\n🎙️  Ouvindo... (ENTER para parar, Ctrl+C para cancelar)');
        break;
      case 'PROCESSING_AUDIO':
        this.print('🧠 Processando...');
        break;
      case 'IDLE':
        if (previous !== 'WAITING_FOR_VOICE' && !this.shuttingDown) {
          this.showIdleHint();
        }
        break;
      default:
        break;
    }
  }

  private isVoiceBusy(): boolean {
    const state = this.celeste.getVoiceState();
    return state !== 'IDLE' && state !== 'WAITING_FOR_VOICE' && state !== 'DISABLED';
  }

  private watchWhatsapp(): void {
    const connected = this.celeste.getStatus().whatsapp;
    if (connected !== this.lastWhatsappState) {
      this.lastWhatsappState = connected;
      this.print(connected ? '\n✅ WhatsApp conectado.' : '\n⚠️  WhatsApp desconectado.');
    }
  }

  private renderHeader(): void {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║       CELESTE LOCAL ASSISTANT        ║');
    console.log('╚══════════════════════════════════════╝');
    this.renderStatus();
  }

  private renderStatus(): void {
    const status = this.celeste.getStatus();
    const lines = [
      '',
      `WhatsApp: ${status.whatsapp ? 'CONNECTED' : 'DISCONNECTED'}`,
      `AI:       ${status.ai ? 'ONLINE' : 'OFFLINE'}`,
      `STT:      ${status.stt ? 'ONLINE' : 'OFFLINE'}`,
      `TTS:      ${status.tts ? 'ONLINE' : 'OFFLINE'}`,
      `MIC:      ${status.mic ? 'ONLINE' : 'OFFLINE'}`,
      `State:    ${status.state} / voz: ${status.voice}`,
      '',
      LINE,
    ];
    this.print(lines.join('\n'));
  }

  private renderHelp(): void {
    this.print(
      [
        '',
        'Voz:',
        '  ENTER        - começa a gravar; ENTER de novo para enviar',
        '  Ctrl+C       - cancela a gravação/processamento/fala',
        '',
        'Exemplos (falados ou digitados):',
        '  "Celeste, status"            "O que você consegue fazer?"',
        '  "Quais mensagens eu recebi?" "Leia a última mensagem"',
        '  "Responde para o João dizendo que já vou verificar"',
        '  "Pode enviar" / "Cancela"    "Repete"    "Desligar"',
        '',
        'Comandos do terminal:',
        '  /status   - Verifica e mostra o status dos serviços',
        '  /voice    - Começa a gravar (mesmo que ENTER)',
        '  /help     - Mostra esta ajuda',
        '  /stop     - Encerra a Celeste',
        '',
      ].join('\n')
    );
  }

  private showIdleHint(): void {
    if (this.shuttingDown) {
      return;
    }
    this.celeste.waitForVoice();
    const hint = this.celeste.isVoiceEnabled()
      ? '🎙️  Pressione ENTER para falar (ou digite um comando; /help para ajuda)'
      : '⌨️  Digite um comando (/help para ajuda)';
    this.print(`\n${hint}`);
  }

  /** Escreve sem bagunçar a linha do prompt. */
  private print(text: string): void {
    if (!this.rl) {
      console.log(text);
      return;
    }
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${text}\n`);
    if (!this.shuttingDown) {
      this.rl.prompt(true);
    }
  }
}
