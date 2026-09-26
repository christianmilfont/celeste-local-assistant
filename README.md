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
│   │   ├── MessageService.ts     # Gerenciamento de mensagens
│   │   ├── VoiceService.ts       # Serviço de voz (STT/TTS)
│   │   ├── ResponseService.ts   # Geração de respostas
│   │   └── ConversationService.ts
│   │
│   ├── adapters/                 # Implementações de provedores
│   │   ├── whatsapp/
│   │   │   └── BaileysWhatsAppAdapter.ts
│   │   ├── ai/
│   │   │   └── OllamaProvider.ts
│   │   ├── stt/
│   │   │   └── WhisperProvider.ts
│   │   └── tts/
│   │       └── PiperTTSProvider.ts
│   │
│   ├── infrastructure/           # Infraestrutura
│   │   ├── config/               # Configuração
│   │   ├── logging/              # Logging
│   │   └── storage/              # Banco de dados
│   │
│   └── index.ts                  # Ponto de entrada CLI
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
- Whisper (para reconhecimento de voz)
- Piper TTS (opcional, para síntese de voz)

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

2. Baixe um modelo (recomendado: llama3.2):
```bash
ollama pull llama3.2
```

3. Configure no `.env`:
```
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

## Instalação e Configuração do Whisper

Whisper é usado para reconhecimento de voz (Speech-to-Text).

### Instalação

**Pré-requisitos:**
- Python 3.8+
- pip

```bash
pip install openai-whisper
```

**Alternativa (via ffmpeg):**
```bash
# Instale ffmpeg primeiro
# Windows: chocolatey install ffmpeg
# macOS: brew install ffmpeg
# Linux: sudo apt install ffmpeg
```

### Configuração

Configure no `.env`:
```
WHISPER_MODEL=base
WHISPER_LANGUAGE=pt
```

**Nota:** Para o MVP, o Whisper é um placeholder. Você precisará configurar uma solução real de gravação de áudio para STT funcionar completamente.

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

**Nota:** No Windows, o sistema usa a síntese de voz nativa do PowerShell como fallback.

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

### Comandos da CLI

Após iniciar, você terá acesso aos seguintes comandos:

- `/status` - Mostra o status atual dos serviços
- `/voice` - Inicia captura de voz (placeholder no MVP)
- `/help` - Mostra ajuda
- `/stop` - Para o Celeste

### Fluxo de Uso

1. **Receber mensagem**: Celeste anuncia a mensagem por voz
2. **Responder**: Digite seu comando de resposta no terminal (ou use `/voice` quando STT estiver configurado)
3. **Confirmação**: Celeste pede confirmação antes de enviar
4. **Envio**: Confirme com "sim", "pode", "envia" ou cancele com "não", "cancelar"

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

**STT não funciona:**
- No MVP, STT é um placeholder
- Configure Whisper e ferramentas de gravação de áudio para uso real

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
O projeto inclui testes unitários para:
- MessageService
- Intent parser
- Confirmation flow
- State machine
- AIProvider
- MessagingAdapter
- Tratamento de erros

**Nota:** Os testes usam mocks e não dependem de uma conta real do WhatsApp.

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

### Fase 1 (Atual) - MVP ✅
- ✅ Integração com WhatsApp via Baileys
- ✅ Text-to-Speech básico
- ✅ Speech-to-Text placeholder
- ✅ Ollama para IA
- ✅ Confirmação antes de enviar
- ✅ CLI básica
- ✅ Logging estruturado
- ✅ SQLite para armazenamento

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
