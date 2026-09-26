import { Celeste } from './core/Celeste';
import { BaileysWhatsAppAdapter } from './adapters/whatsapp/BaileysWhatsAppAdapter';
import { OllamaProvider } from './adapters/ai/OllamaProvider';
import { WhisperProvider } from './adapters/stt/WhisperProvider';
import { PiperTTSProvider } from './adapters/tts/PiperTTSProvider';
import { Logger } from './infrastructure/logging/Logger';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function main() {
  try {
    Logger.info('╔════════════════════════════════════╗');
    Logger.info('║      CELESTE LOCAL ASSISTANT       ║');
    Logger.info('╚════════════════════════════════════╝');

    const messagingAdapter = new BaileysWhatsAppAdapter();
    const aiProvider = new OllamaProvider();
    const sttProvider = new WhisperProvider();
    const ttsProvider = new PiperTTSProvider();

    const celeste = new Celeste(
      messagingAdapter,
      aiProvider,
      sttProvider,
      ttsProvider
    );

    await celeste.start();

    displayStatus(celeste);
    displayHelp();

    setupCLI(celeste);
  } catch (error) {
    Logger.error('Failed to start Celeste', error);
    process.exit(1);
  }
}

function displayStatus(celeste: Celeste): void {
  const status = celeste.getStatus();
  console.log('\nStatus:');
  console.log(`  WhatsApp: ${status.whatsapp ? 'CONNECTED' : 'DISCONNECTED'}`);
  console.log(`  AI:       ${status.ai ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`  STT:      ${status.stt ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`  TTS:      ${status.tts ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`  State:    ${status.state}`);
  console.log('\n');
}

function displayHelp(): void {
  console.log('Commands:');
  console.log('  /status   - Show current status');
  console.log('  /voice    - Start voice input');
  console.log('  /help     - Show this help');
  console.log('  /stop     - Stop Celeste');
  console.log('\nListening...\n');
}

function setupCLI(celeste: Celeste): void {
  rl.on('line', async (input) => {
    const command = input.trim();

    if (command === '/status') {
      displayStatus(celeste);
    } else if (command === '/voice') {
      try {
        await celeste.startVoiceInput();
        Logger.info('Voice input completed');
      } catch (error) {
        Logger.error('Voice input failed', error);
      }
    } else if (command === '/help') {
      displayHelp();
    } else if (command === '/stop') {
      await celeste.stop();
      Logger.info('Celeste stopped. Goodbye!');
      rl.close();
      process.exit(0);
    } else if (command.startsWith('/')) {
      console.log('Unknown command. Type /help for available commands.');
    } else {
      try {
        await celeste.processVoiceTranscription(command);
      } catch (error) {
        Logger.error('Error processing input', error);
      }
    }

    displayPrompt();
  });

  rl.on('close', async () => {
    await celeste.stop();
    process.exit(0);
  });

  displayPrompt();
}

function displayPrompt(): void {
  process.stdout.write('> ');
}

process.on('SIGINT', async () => {
  Logger.info('Received SIGINT, shutting down...');
  rl.close();
  process.exit(0);
});

main();
