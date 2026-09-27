"""
Celeste - Whisper worker (faster-whisper).

Processo persistente: carrega o modelo uma vez e transcreve arquivos sob demanda,
evitando recarregar o modelo a cada comando de voz.

Protocolo (JSON por linha, UTF-8):
  stdout (inicio)  -> {"ready": true}  ou  {"fatal": "mensagem"}
  stdin            -> {"id": 1, "path": "C:/.../rec.wav"}
  stdout           -> {"id": 1, "text": "..."}  ou  {"id": 1, "error": "..."}

Configuracao via variaveis de ambiente:
  WHISPER_MODEL (base), WHISPER_LANGUAGE (pt), WHISPER_DEVICE (cpu),
  WHISPER_COMPUTE_TYPE (int8), WHISPER_INITIAL_PROMPT
"""
import json
import os
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    model_name = os.environ.get("WHISPER_MODEL", "base")
    language = os.environ.get("WHISPER_LANGUAGE", "pt") or None
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
    initial_prompt = os.environ.get("WHISPER_INITIAL_PROMPT") or None

    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as exc:  # noqa: BLE001
        emit({"fatal": f"{type(exc).__name__}: {exc}"})
        return 1

    emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            segments, _info = model.transcribe(
                request["path"],
                language=language,
                beam_size=5,
                vad_filter=True,
                initial_prompt=initial_prompt,
                condition_on_previous_text=False,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            emit({"id": request_id, "text": text})
        except Exception as exc:  # noqa: BLE001
            emit({"id": request_id, "error": f"{type(exc).__name__}: {exc}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
