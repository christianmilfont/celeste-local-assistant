"""
Celeste - voz neural local (Kokoro-82M via kokoro-onnx), worker persistente.

O modelo é carregado uma vez. Cada fala é sintetizada frase por frase numa thread enquanto
a anterior toca (sounddevice): a voz começa rápido e sem pausas entre as frases.

Protocolo (JSON por linha, UTF-8):
  stdout (início) -> {"ready": true} | {"fatal": "..."}
  stdin           -> {"type": "speak", "id": 1, "text": "...", "voice": "pf_dora", "speed": 1.0}
                     {"type": "stop"}        (interrompe a fala atual)
  stdout          -> {"id": 1, "event": "started"}   (o áudio começou de fato)
                     {"id": 1, "event": "done"}      (terminou ou foi interrompida)
                     {"id": 1, "event": "error", "error": "..."}

Configuração: KOKORO_MODEL, KOKORO_VOICES, KOKORO_VOICE (pf_dora), KOKORO_SPEED (1.0), KOKORO_LANG (pt-br)
"""
import json
import os
import queue
import re
import sys
import threading
import time


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


SAMPLE_RATE = 24000  # taxa de amostragem do Kokoro

# Modelo de custo medido nesta máquina (CPU): usado para planejar o início sem pausas.
SYNTH_FIXED_S = 0.40      # custo fixo por trecho
SYNTH_PER_CHAR_S = 0.041  # síntese por caractere
AUDIO_PER_CHAR_S = 0.063  # duração de áudio por caractere (velocidade 1.0)


def gapless_start_delay(lengths, speed, calibration=1.0):
    """
    Menor atraso de início T tal que cada trecho k já esteja sintetizado quando chegar a vez
    dele tocar: T = max_k (pronto_k - áudio_antes_k). Assim a fala sai contínua, sem pausas.
    """
    ready = 0.0
    audio_before = 0.0
    delay = 0.0
    for length in lengths:
        ready += (SYNTH_FIXED_S + SYNTH_PER_CHAR_S * length) * calibration
        delay = max(delay, ready - audio_before)
        audio_before += AUDIO_PER_CHAR_S * length / speed
    return delay

# Corte antes de conjunções: onde a fala naturalmente "respira".
CONJUNCTION = r"\s(?=(?:e|ou|mas|que|porque|quando|para|com|sem|enquanto)\s)"


def split_sentences(text, first=34, growth=1.3, cap=170):
    """
    Divide a fala em trechos que crescem ~1,3x a cada vez (34, 44, 57, 74... caracteres).
    Como a síntese leva ~0,75 s por segundo de áudio, o próximo trecho fica pronto antes de o
    atual terminar de tocar: a fala começa rápido e não tem pausas no meio.
    Os cortes preferem fim de frase, depois vírgula/ponto e vírgula, depois espaço.
    """
    text = re.sub(r"\s+", " ", text).strip()
    chunks = []
    target = first
    while text:
        if len(text) <= target * 1.35:
            chunks.append(text)
            break
        window = text[: int(target * 1.35)]
        cut = -1
        for pattern in (r"[.!?…](?=\s)", r"[,;:](?=\s)", CONJUNCTION, r"\s"):
            matches = [m.end() for m in re.finditer(pattern, window) if m.end() >= target * 0.6]
            if matches:
                cut = matches[0] if pattern not in (r"\s", CONJUNCTION) else matches[-1]
                break
        if cut <= 0:
            cut = len(window)
        chunks.append(text[:cut].strip())
        text = text[cut:].strip()
        target = min(int(target * growth), cap)
    return [c for c in chunks if c]


class Speaker:
    def __init__(self, kokoro, sd, lang):
        self.kokoro = kokoro
        self.sd = sd
        self.lang = lang
        self.jobs = queue.Queue()
        self.current_cancel = threading.Event()
        threading.Thread(target=self.run, daemon=True).start()

    def stop(self):
        """Interrompe a fala atual (e descarta as que estavam na fila). O fluxo de áudio
        verifica o cancelamento a cada bloco e fica em silêncio imediatamente."""
        self.current_cancel.set()
        while not self.jobs.empty():
            try:
                emit({"id": self.jobs.get_nowait()["id"], "event": "done"})
            except queue.Empty:
                break

    def run(self):
        while True:
            job = self.jobs.get()
            cancel = threading.Event()  # um sinal por fala: uma interrupção não afeta a próxima
            self.current_cancel = cancel
            try:
                self.speak(job, cancel)
            except Exception as exc:  # noqa: BLE001
                emit({"id": job["id"], "event": "error", "error": f"{type(exc).__name__}: {exc}"})
                continue
            emit({"id": job["id"], "event": "done"})

    def speak(self, job, cancel):
        """
        Um único fluxo de áudio contínuo alimentado por uma fila: os trechos entram conforme a
        síntese termina e tocam emendados (sem reabrir o dispositivo a cada frase).
        O cancelamento silencia o fluxo no próximo bloco (~40 ms).
        """
        import numpy as np

        pcm = queue.Queue()
        sentences = split_sentences(job.get("text", ""))
        voice = job.get("voice") or os.environ.get("KOKORO_VOICE", "pf_dora")
        speed = float(job.get("speed") or os.environ.get("KOKORO_SPEED", "1.0"))
        state = {"cur": None, "pos": 0, "producer_done": False, "go": False}
        started = threading.Event()
        finished = threading.Event()
        lengths = [len(sentence) for sentence in sentences]
        plan = {"delay": gapless_start_delay(lengths, speed), "t0": time.monotonic()}

        def produce():
            try:
                for index, sentence in enumerate(sentences):
                    if cancel.is_set():
                        break
                    t = time.monotonic()
                    samples, _rate = self.kokoro.create(sentence, voice=voice, speed=speed, lang=self.lang)
                    if index == 0:
                        # recalibra o plano com a velocidade real desta máquina/momento
                        expected = SYNTH_FIXED_S + SYNTH_PER_CHAR_S * lengths[0]
                        calibration = max(0.5, min(3.0, (time.monotonic() - t) / expected))
                        plan["delay"] = gapless_start_delay(lengths, speed, calibration)
                    pcm.put(np.asarray(samples, dtype=np.float32))
            finally:
                state["producer_done"] = True

        def callback(outdata, frames, _time, _status):
            out = outdata[:, 0]
            filled = 0
            while filled < frames and not cancel.is_set() and state["go"]:
                cur = state["cur"]
                if cur is None or state["pos"] >= len(cur):
                    try:
                        state["cur"], state["pos"] = pcm.get_nowait(), 0
                        started.set()
                        continue
                    except queue.Empty:
                        if state["producer_done"]:
                            finished.set()
                        break  # ainda sintetizando: completa o bloco com silêncio
                n = min(frames - filled, len(cur) - state["pos"])
                out[filled:filled + n] = cur[state["pos"]:state["pos"] + n]
                state["pos"] += n
                filled += n
            out[filled:] = 0

        threading.Thread(target=produce, daemon=True).start()
        announced = False
        with self.sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                  blocksize=1024, callback=callback):
            while not finished.is_set() and not cancel.is_set():
                # começa a tocar quando o plano garante fala contínua (ou quando tudo já foi sintetizado)
                if not state["go"] and not pcm.empty() and (
                    time.monotonic() - plan["t0"] >= plan["delay"] or state["producer_done"]
                ):
                    state["go"] = True
                if started.is_set() and not announced:
                    emit({"id": job["id"], "event": "started"})
                    announced = True
                time.sleep(0.02)
            if not cancel.is_set():
                time.sleep(0.12)  # deixa o último bloco sair do buffer do dispositivo
        if not announced:
            emit({"id": job["id"], "event": "started"})


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        import sounddevice as sd
        from kokoro_onnx import Kokoro

        kokoro = Kokoro(os.environ["KOKORO_MODEL"], os.environ["KOKORO_VOICES"])
        lang = os.environ.get("KOKORO_LANG", "pt-br")
        kokoro.create("Olá.", voice=os.environ.get("KOKORO_VOICE", "pf_dora"), lang=lang)  # aquece
    except Exception as exc:  # noqa: BLE001
        emit({"fatal": f"{type(exc).__name__}: {exc}"})
        return 1

    speaker = Speaker(kokoro, sd, lang)
    emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("type") == "stop":
            speaker.stop()
        elif message.get("type") == "speak":
            speaker.jobs.put(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
