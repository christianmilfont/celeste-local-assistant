# Testing Guide - Celeste Local Assistant MVP

## Prerequisites for Testing

Before testing the MVP, ensure you have:

1. **Ollama installed and running**
   ```bash
   ollama serve
   ollama pull llama3.1:8b
   ```

2. **Environment file configured**
   ```bash
   # Copy the example file
   cp .env.example .env
   # Or run the setup script
   powershell -ExecutionPolicy Bypass -File scripts/setup-env.ps1
   ```

3. **Dependencies installed**
   ```bash
   npm install
   py -3.12 -m venv .venv
   .venv\Scripts\python -m pip install faster-whisper
   ```

## Test Sequence

### Test 1: Build Verification
```bash
npm run build
```
**Expected:** No compilation errors, `dist/` folder created

### Test 2: Application Startup
```bash
npm run dev
```
**Expected:**
- ASCII art header appears
- Status display shows initial state
- Commands help appears
- Prompt `>` appears

### Test 3: WhatsApp Connection
1. With the app running, a QR code should appear in the terminal
2. Scan the QR code with your WhatsApp
3. Wait for connection message

**Expected:**
- QR code displayed
- "WhatsApp connection established" log message
- Status shows `WhatsApp: CONNECTED`

### Test 4: Message Reception
1. From another phone, send a message to your WhatsApp
2. Watch the terminal logs

**Expected:**
- Log: "Message received"
- Log: "Announcing message"
- Voice announcement (if TTS is configured)
- State transitions logged

### Test 5: Voice Input (push-to-talk)
1. Confirm the panel shows `🎙️  Pressione ENTER para falar` and `STT: ONLINE`, `MIC: ONLINE`
2. Press ENTER, say "Celeste, status.", press ENTER

**Expected:**
- `🎙️ Ouvindo...` → `🧠 Processando...`
- `📝 Você disse: "Celeste, status."`
- `🔊 Celeste:` "Estou online. WhatsApp conectado, ..." (spoken)

3. Repeat with "Celeste, ajuda." → Celeste explains what she can do (spoken)

### Test 6: WhatsApp reply by voice
1. From another phone, send a message → Celeste announces "Você recebeu uma mensagem de ..."
2. Press ENTER, say "Leia novamente." → Celeste repeats the message
3. Press ENTER, say "Responde dizendo que já vou verificar." → "Preparei esta resposta para ...: '...'. Posso enviar?"
4. Press ENTER, say "Pode enviar." → "Mensagem enviada para ..." and the message arrives on the other phone

### Test 7: Cancellation
1. Repeat Test 6 but answer "Não" (or "cancela")

**Expected:**
- "Tudo bem, não vou enviar a mensagem."
- No message sent, state returns to IDLE

### Test 7b: Typed commands (same processing as voice)
Type `como estão os serviços?` → same answer as the spoken "status".

### Test 7c: Interruption and errors
- Press ENTER then Ctrl+C → `⏹️  Cancelado.`, back to `Pressione ENTER para falar`
- Press ENTER and stay silent, then ENTER → "Não captei nenhum som..." or "Não consegui entender o áudio. Pode repetir?"
- Stop Ollama and say something unusual → "... A inteligência artificial está indisponível no momento ..."

### Test 7d: Avatar 2D
1. On startup a small "Celeste" window opens (address shown as `Avatar:` in the panel)
2. At rest: `IDLE`, the 3D hologram breathes slowly; moving the mouse over the window rotates the head
3. Press ENTER → `LISTENING` (brighter); ENTER again → `THINKING` (blue-violet, faster breathing)
4. While she answers → `SPEAKING` (dotted mouth opens/closes with the voice, caption shown) → back to `IDLE`
5. Receive a WhatsApp message → `MESSAGE` then `SPEAKING` during the announcement
6. Stay silent in a voice turn → `ERROR` (red) while she says she did not understand → `IDLE`
7. `/stop` → the avatar window closes
8. Visual check: with Celeste running open `http://127.0.0.1:7717/?demo=1` (SVG fallback: `/variants/pointcloud/?demo=1`)

### Test 7e: Smart TV (Samsung)
1. With the TV on and on the same network, start Celeste: the panel shows `TV: Samsung ... (192.168.x.x) [não pareada]`
2. Say/type "a TV está ligada?" → "A TV está ligada." (no prompt on the TV)
3. Say "aumenta o volume em 2" → Celeste asks you to accept the authorization on the TV screen → accept with the remote → volume goes up by 2
4. "abre o YouTube" → YouTube opens; "tira o som da TV" → mutes
5. "desliga a TV" → the TV turns off; "a TV está ligada?" → "modo de espera"/"desligada"
6. "liga a TV" → turns on (requires the TV option to power on via network/mobile)

### Test 7f: Messages to contacts
1. Restart Celeste: the panel shows `Contatos: N` (if N is small, say "atualizar contatos")
2. Say "envie uma mensagem para <nome de um contato> dizendo que estou testando a Celeste"
3. Celeste answers "Preparei esta mensagem para <nome completo>: ... Posso enviar?" → say "pode"
4. The contact receives the message
5. With a name shared by 2+ contacts, Celeste asks "Para qual deles?" → answer with the surname
6. "envia uma mensagem para <nome>" (no text) → Celeste asks what to say → dictate the message

### Test 8: Status Command
Type `/status` in the CLI

**Expected:**
- Current status of all services displayed
- Current state shown

### Test 9: Help Command
Type `/help` in the CLI

**Expected:**
- List of available commands displayed

### Test 10: Graceful Shutdown
Type `/stop`, say "desligar", or press Ctrl+C twice

**Expected:**
- Log: "Stopping Celeste..."
- Log: "WhatsApp disconnected"
- Clean exit

## Known Limitations in MVP

1. **Wake word**: Not implemented (push-to-talk with ENTER)
2. **Continuous listening**: Not implemented (manual trigger only)
3. **Message context**: only messages received while Celeste is running can be read/replied to

## Troubleshooting Tests

### QR Code doesn't appear
- Check if Ollama is running: `ollama serve`
- Check network connection
- Try restarting the app

### TTS doesn't work
- Windows: Uses PowerShell native voice (should work)
- macOS/Linux: Ensure Piper TTS is installed
- Check audio output settings

### Message not sent
- Check WhatsApp connection status with `/status`
- Verify the message content is appropriate
- Check logs for errors

### Build errors
```bash
# Clean and rebuild
rm -rf dist node_modules
npm install
npm run build
```

## Manual Testing Checklist

- [ ] Application builds without errors
- [ ] Application starts successfully
- [ ] WhatsApp QR code appears
- [ ] WhatsApp connects after scanning
- [ ] Messages are received and logged
- [ ] Messages are announced (voice)
- [ ] Push-to-talk: ENTER → speak → ENTER shows the transcription
- [ ] Spoken commands are answered by voice
- [ ] Response commands are processed
- [ ] Confirmation flow works
- [ ] Cancellation works
- [ ] Status command shows correct info
- [ ] Application stops gracefully

## Success Criteria

The MVP is considered successful when:

1. ✅ Application starts and connects to WhatsApp
2. ✅ Messages are received and announced
3. ✅ User can respond via CLI commands
4. ✅ AI generates appropriate responses
5. ✅ Confirmation is required before sending
6. ✅ Messages are sent to correct contacts
7. ✅ All components log appropriately
8. ✅ Graceful shutdown works

## Next Steps After MVP

Once the MVP passes all tests:

1. Implement wake word detection
2. Add continuous listening
3. Implement memory/context
4. Add GUI (web dashboard)
