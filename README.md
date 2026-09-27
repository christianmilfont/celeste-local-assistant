# Celeste Local Assistant

Uma assistente pessoal local que monitora seu WhatsApp, avisa por voz quando você recebe mensagens e permite responder falando com ela.

## Visão Geral

Celeste é uma assistente de voz local projetada para:
- Monitorar mensagens do WhatsApp em tempo real
- Anunciar mensagens recebidas por voz
- Permitir respostas por comando de voz
- Processar tudo localmente com ferramentas gratuitas
- Pedir confirmação antes de enviar qualquer mensagem

## Arquitetura

O projeto segue uma arquitetura modular com separação clara de responsabilidades:

```
celeste-local-assistant/
├── src/
│   ├── core/                      # Núcleo da aplicação
│   │   ├── Celeste.ts            # Orquestrador principal
│   │   ├── EventBus.ts           # Sistema de eventos
│   │   ├── StateMachine.ts       # Máquina de estados
│   │   └── types/                # Tipos e interfaces
│   │
│   ├── application/              # Lógica de negócio
│   │   ├── CommandProcessor.ts   # Processamento único de comandos (CLI e voz)
│   │   ├── IntentClassifier.ts   # Texto -> intenção (regras + fallback no LLM)
│   │   ├── ConfirmationService.ts# "sim/pode/manda" x "não/cancela/deixa"
│   │   ├── SpeechInputService.ts # Microfone -> validação do áudio -> STT
│   │   ├── VoicePipeline.ts      # Máquina de estados do push-to-talk
│   │   ├── MessageService.ts     # Mensagens recebidas, não lidas, foco, envio
│   │   ├── VoiceService.ts       # Saída de voz (TTS) e anúncios
│   │   ├── ResponseService.ts    # Redação da resposta e confirmação
│   │   └── nlu/                  # Normalização de texto e formatação da fala
│   │
│   ├── adapters/                 # Implementações de provedores
│   │   ├── whatsapp/
│   │   │   └── BaileysWhatsAppAdapter.ts
│   │   ├── ai/
│   │   │   └── OllamaProvider.ts
│   │   ├── audio/                # Captura do microfone
│   │   │   ├── WindowsMciRecorder.ts  # Windows (winmm/MCI, nativo)
│   │   │   └── SoxRecorder.ts         # Linux/macOS (sox)
│   │   ├── stt/
│   │   │   └── WhisperProvider.ts     # faster-whisper (worker Python persistente)
│   │   └── tts/
│   │       └── PiperTTSProvider.ts    # Windows: System.Speech; Linux/macOS: Piper
│   │
│   ├── interfaces/cli/
│   │   └── TerminalInterface.ts  # Terminal: comandos digitados + push-to-talk
│   │
│   ├── infrastructure/           # Infraestrutura
│   │   ├── config/               # Configuração
│   │   ├── logging/              # Logging
│   │   └── storage/              # Banco de dados
│   │
│   └── index.ts                  # Ponto de entrada (composição)
├── scripts/stt/whisper_worker.py # Worker do Whisper
└── tests/                        # Testes unitários (sem hardware/serviços externos)
```

### Fluxo de voz

O CLI e a voz convergem para o mesmo `CommandProcessor`, sem lógica duplicada:

```
 Teclado ──────────────────────────────┐
                                       ▼
 Microfone ─► Whisper (STT) ─► texto ─► CommandProcessor ─► serviços ─► resposta ─► TTS
                                       (IntentClassifier: regras → LLM só se preciso)
```

Estados do push-to-talk (`VoicePipeline`):

```
IDLE → WAITING_FOR_VOICE → RECORDING → PROCESSING_AUDIO → TRANSCRIBING
     → COMMAND_PROCESSING → ACTION → TTS_RESPONSE → IDLE
Erro: ERROR → (Celeste fala o problema) → IDLE      Ctrl+C: qualquer estado → IDLE
```

### Componentes

- **EventBus**: Sistema de eventos para desacoplamento entre componentes
- **StateMachine**: Controla o fluxo de estados do assistente
- **MessagingAdapter**: Interface abstrata para provedores de mensagens
- **AIProvider**: Interface abstrata para provedores de IA
- **SpeechToTextProvider**: Interface abstrata para STT
- **TextToSpeechProvider**: Interface abstrata para TTS

## Requisitos

### Sistema Operacional
- Windows, macOS ou Linux

### Dependências
- Node.js 18+
- npm ou yarn
- Ollama (para IA local)
- Python 3.9+ com `faster-whisper` (reconhecimento de voz local)
- Microfone (Windows: nenhuma ferramenta extra; Linux/macOS: `sox`)
- Piper TTS (apenas Linux/macOS; no Windows é usada a voz nativa)

## Instalação

### 1. Clone o repositório
```bash
git clone <repository-url>
cd celeste-local-assistant
```

### 2. Instale as dependências do Node.js
```bash
npm install
```

### 3. Configure as variáveis de ambiente
```bash
cp .env.example .env
```

Edite o arquivo `.env` conforme necessário (veja seção de configuração).

## Instalação e Configuração do Ollama

Ollama é o provedor de IA local para processamento de linguagem natural.

### Instalação

**Windows:**
```bash
winget install Ollama.Ollama
```

**macOS:**
```bash
brew install ollama
```

**Linux:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### Configuração

1. Inicie o Ollama:
```bash
ollama serve
```

2. Baixe um modelo (ex.: llama3.1:8b):
```bash
ollama pull llama3.1:8b
```

3. Configure no `.env` com o **nome exato** de um modelo instalado (`ollama list`):
```
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
```

Se o modelo configurado não estiver instalado, a IA aparece como `OFFLINE`.
Na inicialização a Celeste pré-carrega o modelo em segundo plano (o primeiro carregamento
de um modelo 8B pode levar mais de um minuto) e o mantém carregado por `OLLAMA_KEEP_ALIVE`.

## Instalação e Configuração do Whisper

Whisper é usado para reconhecimento de voz (Speech-to-Text), 100% local, via
[faster-whisper](https://github.com/SYSTRAN/faster-whisper). Não precisa de ffmpeg.

### Instalação (venv do projeto)

**Windows:**
```bash
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install faster-whisper
```

**Linux/macOS:**
```bash
python3 -m venv .venv
.venv/bin/python -m pip install faster-whisper
```

A Celeste usa automaticamente o Python de `.venv/` (ou `WHISPER_PYTHON`, se definido).
Na primeira execução o modelo (~145 MB para `base`) é baixado do Hugging Face e fica em cache.

O Whisper roda como um **worker persistente** (`scripts/stt/whisper_worker.py`): o modelo é
carregado uma vez na inicialização e reutilizado em todos os comandos.

### Configuração

```
WHISPER_MODEL=base          # tiny | base | small | medium (maior = mais preciso e mais lento)
WHISPER_LANGUAGE=pt
WHISPER_DEVICE=cpu          # cuda exige CUDA/cuDNN instalados
WHISPER_COMPUTE_TYPE=int8
```

Se o reconhecimento errar muito com o seu microfone, experimente `WHISPER_MODEL=small`.

## Instalação e Configuração do Piper TTS

Piper TTS é usado para síntese de voz (Text-to-Speech).

### Instalação

**Windows:**
Baixe os binários do [repositório Piper](https://github.com/rhasspy/piper)

**macOS/Linux:**
```bash
# Via pip
pip install piper-tts

# Ou compile do código fonte
git clone https://github.com/rhasspy/piper
cd piper
./build.sh
```

### Configuração

Configure no `.env`:
```
PIPER_MODEL=pt_BR-glow_tts
PIPER_VOICE_PATH=
```

**Nota:** No Windows, o sistema usa a síntese de voz nativa (System.Speech) e escolhe
automaticamente uma voz pt-BR instalada (ex.: "Microsoft Maria Desktop"). Para escolher outra:
`TTS_VOICE=Microsoft Maria Desktop` e `TTS_RATE=0` (-10 a 10).

## Microfone

- **Windows:** gravação nativa via `winmm.dll` (MCI), sem instalar nada. Se nada for captado,
  verifique *Configurações > Privacidade > Microfone* e o dispositivo de entrada padrão.
- **Linux/macOS:** instale o SoX (`sudo apt install sox` / `brew install sox`).

## Configuração do WhatsApp

Celeste usa Baileys para conectar ao WhatsApp via QR Code.

### Passos:

1. Execute o aplicativo:
```bash
npm run dev
```

2. Um QR Code será exibido no terminal

3. Escaneie o QR Code com seu WhatsApp (número que você quer monitorar)

4. A conexão será estabelecida automaticamente

### Sessão

A sessão é salva em `./sessions` por padrão. Você não precisará escanear o QR Code novamente, a menos que a sessão expire ou seja deletada.

## Execução

### Desenvolvimento
```bash
npm run dev
```

### Produção
```bash
npm run build
npm start
```

### Serviços que precisam estar rodando

- **Ollama** (`ollama serve`) com o modelo do `.env` instalado — opcional: sem ele os comandos
  simples continuam funcionando, mas frases livres não são interpretadas e as respostas são
  enviadas exatamente como ditadas.
- **WhatsApp** pareado (QR Code na primeira execução).
- Whisper, TTS e microfone são iniciados pela própria Celeste.

### Interação por voz (push-to-talk)

```
╔══════════════════════════════════════╗
║       CELESTE LOCAL ASSISTANT        ║
╚══════════════════════════════════════╝

WhatsApp: CONNECTED
AI:       ONLINE
STT:      ONLINE
TTS:      ONLINE
MIC:      ONLINE
────────────────────────────────────────

🎙️  Pressione ENTER para falar
```

1. Pressione **ENTER** → `🎙️ Ouvindo...`
2. Fale o comando (ex.: *"Celeste, status."*)
3. Pressione **ENTER** de novo → `🧠 Processando...` → `📝 Você disse:` → `🔊 Celeste:`
4. **Ctrl+C** cancela a gravação/processamento/fala e volta ao início (em repouso, Ctrl+C duas vezes sai)

A gravação para sozinha após `VOICE_MAX_RECORDING_MS` (30 s). Você também pode **digitar**
qualquer comando — ele é processado exatamente da mesma forma.

### O que dizer

Não é preciso falar comandos rígidos; "Celeste," no início é opcional.

| Intenção | Exemplos |
|---|---|
| STATUS | "status", "como está o sistema?", "como estão os serviços?", "como você está?" |
| HELP | "ajuda", "o que você consegue fazer?" |
| LIST_MESSAGES | "quais mensagens eu recebi?", "tenho mensagens novas?" |
| READ_LAST_MESSAGE | "leia a última mensagem", "leia novamente", "o que o João disse?" |
| REPLY_TO_MESSAGE | "responde que já vou verificar", "responde para o João dizendo que já estou chegando" |
| CONFIRM | "sim", "pode", "pode enviar", "manda" |
| DENY / CANCEL | "não", "cancela", "deixa", "esquece" |
| REPEAT | "repete", "não entendi" |
| STOP | "desligar", "encerrar" |

Comandos comuns são resolvidos por regras locais (instantâneo, sem LLM). Frases que não casam
com nenhuma regra são interpretadas pelo Ollama.

### Fluxo com o WhatsApp

1. Chega uma mensagem → a Celeste anuncia: *"Você recebeu uma mensagem de João: ..."*
2. *"Responde dizendo que já vou verificar."* → a Celeste usa a mensagem em foco (não pergunta "para quem?")
3. *"Preparei esta resposta para João: 'Já vou verificar.' Posso enviar?"*
4. *"Pode."* → envia. *"Não"* / *"cancela"* → descarta.

**Segurança:** nada é enviado sem um "sim" inequívoco. Respostas ambíguas ("sim, mas muda o
horário", frases longas) nunca confirmam — a Celeste pergunta de novo. O LLM nunca decide a confirmação.

Mensagens que chegam enquanto você fala são anunciadas ao final da interação.

### Comandos do terminal

- `ENTER` / `/voice` - Começa/termina a gravação
- `/status` - Verifica e mostra o status dos serviços
- `/help` - Mostra ajuda
- `/stop` - Encerra a Celeste

### Logs

O terminal mostra apenas avisos e erros (`LOG_CONSOLE_LEVEL=warn`) para não poluir a interface.
O log completo fica em `./logs/celeste.log` (`LOG_LEVEL`).

## Troubleshooting

### Problemas comuns

**QR Code não aparece:**
- Verifique se Ollama está rodando: `ollama serve`
- Verifique as configurações de rede

**Erro de conexão WhatsApp:**
- Delete a pasta `./sessions` e escaneie o QR Code novamente
- Verifique se você tem conexão com a internet

**TTS não funciona:**
- No Windows, o sistema usa voz nativa do PowerShell
- Em macOS/Linux, verifique se Piper está instalado corretamente

**STT OFFLINE / "O reconhecimento de voz está indisponível":**
- Instale o faster-whisper no `.venv` (veja "Instalação e Configuração do Whisper")
- Ou aponte `WHISPER_PYTHON` para um Python que tenha o `faster-whisper`

**"Não captei nenhum som" / MIC OFFLINE:**
- Windows: *Configurações > Privacidade > Microfone* → permitir apps da área de trabalho
- Verifique o dispositivo de entrada padrão e se o microfone não está mudo

**"Não consegui entender o áudio":**
- Fale mais perto do microfone e espere um instante após o ENTER antes de falar
- Experimente `WHISPER_MODEL=small`

**IA OFFLINE:**
- `ollama serve` e confira se `OLLAMA_MODEL` aparece em `ollama list`

**Erros de TypeScript:**
```bash
npm run build
```

## Testes

### Executar testes
```bash
npm test
```

### Testes em modo watch
```bash
npm run test:watch
```

### Testes unitários
O projeto inclui testes unitários (`tests/`) para:
- `ConfirmationService` — "sim/pode/manda" → CONFIRM; "não/cancela/deixa" → DENY/CANCEL; frases ambíguas nunca confirmam
- `IntentClassifier` — linguagem natural → intenções, extração de destinatário/conteúdo, fallback no LLM
- `CommandProcessor` — "status", "Celeste, status", "como está o sistema?" → STATUS; contexto da conversa; confirmação; erros
- `SpeechInputService` — iniciar/finalizar gravação, áudio vazio/silencioso, transcrição vazia, erros de STT
- `VoicePipeline` — fluxo completo com Microfone, Whisper, Ollama, TTS e WhatsApp simulados

**Nota:** Os testes usam fakes e não dependem de hardware de áudio, Ollama, Whisper nem de uma conta real do WhatsApp.

## Segurança

### Princípios de segurança

- **Processamento local**: Dados são processados localmente quando possível
- **Sem credenciais no código**: Use `.env` para configurações sensíveis
- **Git seguro**: `.gitignore` protege arquivos sensíveis
- **Logs seguros**: Logs não contêm informações sensíveis por padrão

### Arquivos sensíveis

**Nunca commit:**
- `.env`
- `celeste.db`
- `sessions/`
- Arquivos de áudio temporários

**Sempre mantenha seguro:**
- Sessões do WhatsApp
- Tokens de API (se configurar provedores externos)

## Custos

### Componentes Gratuitos (Fase 1)

- **Node.js & TypeScript**: Gratuito
- **Baileys (WhatsApp)**: Gratuito (usa biblioteca open-source)
- **Ollama**: Gratuito (executa localmente)
- **Whisper**: Gratuito (open-source)
- **Piper TTS**: Gratuito (open-source)
- **SQLite**: Gratuito

### Possíveis Custos Futuros

Se você implementar provedores alternativos nas fases futuras:

- **OpenAI API**: Pago por uso
- **Gemini API**: Pago por uso
- **Anthropic API**: Pago por uso
- **API oficial do WhatsApp**: Pago (versão Business)

## Roadmap

### Fase 1 - MVP ✅
- ✅ Integração com WhatsApp via Baileys
- ✅ Text-to-Speech básico
- ✅ Ollama para IA
- ✅ Confirmação antes de enviar
- ✅ CLI básica
- ✅ Logging estruturado
- ✅ SQLite para armazenamento

### Fase 1.5 (Atual) - Interação por voz ✅
- ✅ Push-to-talk no terminal (ENTER para falar)
- ✅ Speech-to-Text local com Whisper (faster-whisper)
- ✅ Command Processor único para CLI e voz
- ✅ Intenções em linguagem natural (regras + LLM)
- ✅ Contexto da conversa (responder sem repetir o destinatário)
- ✅ Respostas faladas e tratamento de erros por voz

### Fase 2 - Wake Word e Escuta Contínua
- Wake word "Celeste"
- Escuta contínua em background
- Melhor gerenciamento de áudio
- Detecção de início/fim de fala

### Fase 3 - Memória e Personalidade
- Memória contextual de conversas
- Histórico de conversas
- Personalidade customizável da Celeste
- Preferências do usuário

### Fase 4 - Modo Automático
- Modo automático opcional (com avisos)
- Regras por contato
- Respostas automáticas configuráveis
- Whitelist de contatos confiáveis

### Fase 5 - Interface Gráfica
- Dashboard web
- Status dos serviços
- Histórico de mensagens
- Configurações visuais

### Fase 6 - Integrações Locais
- Calendário
- Tarefas/To-do
- Notificações do sistema
- Automações do computador

### Fase 7 - Multi-Provider
- Suporte para OpenAI
- Suporte para Gemini
- Suporte para Anthropic
- Diferentes modelos locais
- Seleção dinâmica de modelo

## Contribuindo

Este é um projeto pessoal local. Se você quiser contribuir:

1. Fork o projeto
2. Crie uma branch para sua feature
3. Commit suas mudanças
4. Push para a branch
5. Abra um Pull Request

## Licença

ISC

## Suporte

Para problemas ou dúvidas:
- Verifique a seção de Troubleshooting
- Revise os logs em `./logs/celeste.log`
- Abra uma issue no repositório

## Agradecimentos

- [Baileys](https://github.com/WhiskeySockets/Baileys) - Biblioteca WhatsApp
- [Ollama](https://ollama.com/) - IA local
- [Whisper](https://github.com/openai/whisper) - Reconhecimento de voz
- [Piper TTS](https://github.com/rhasspy/piper) - Síntese de voz
