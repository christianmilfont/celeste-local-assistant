# Testing Guide - Celeste Local Assistant MVP

## Prerequisites for Testing

Before testing the MVP, ensure you have:

1. **Ollama installed and running**
   ```bash
   ollama serve
   ollama pull llama3.2
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

### Test 5: Voice Input (CLI Simulation)
Since STT is a placeholder in MVP, test with text input:

1. After receiving a message, type a response command:
   ```
   Responde que sim, vou mandar mais tarde.
   ```

**Expected:**
- Log: "Processing voice transcription"
- Log: "Intent detected: REPLY_TO_MESSAGE"
- Log: "Generating response"
- Log: "Requesting confirmation"
- Voice asks for confirmation

### Test 6: Confirmation Flow
1. When asked for confirmation, type:
   ```
   Pode
   ```

**Expected:**
- Log: "Response confirmed"
- Log: "Sending message"
- Message sent to WhatsApp
- State returns to IDLE

### Test 7: Cancellation
1. After receiving a message, type a response
2. When asked for confirmation, type:
   ```
   Não
   ```

**Expected:**
- Log: "Response cancelled"
- Log: "Cancelado." (voice)
- State returns to IDLE
- No message sent

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
Type `/stop` or press Ctrl+C

**Expected:**
- Log: "Stopping Celeste..."
- Log: "WhatsApp disconnected"
- Clean exit

## Known Limitations in MVP

1. **STT is placeholder**: Voice input is simulated with text input
2. **Audio recording**: Actual microphone recording not implemented
3. **Wake word**: Not implemented (use CLI commands)
4. **Continuous listening**: Not implemented (manual trigger only)

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

1. Implement actual STT with Whisper
2. Add audio recording functionality
3. Implement wake word detection
4. Add continuous listening
5. Implement memory/context
6. Add GUI (web dashboard)
