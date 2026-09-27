"""
Baixa o modelo de voz neural Kokoro-82M (Apache 2.0) para models/kokoro/.

Uso:
  .venv/Scripts/python scripts/tts/download_kokoro.py
  .venv/Scripts/python -m pip install kokoro-onnx sounddevice
"""
import os
import sys
import urllib.request

BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
FILES = ['kokoro-v1.0.onnx', 'voices-v1.0.bin']
TARGET = os.path.join(os.path.dirname(__file__), '..', '..', 'models', 'kokoro')


def main():
    os.makedirs(TARGET, exist_ok=True)
    for name in FILES:
        path = os.path.join(TARGET, name)
        if os.path.exists(path) and os.path.getsize(path) > 1_000_000:
            print(f'{name}: já existe')
            continue
        print(f'baixando {name}...')
        urllib.request.urlretrieve(f'{BASE}/{name}', path)
        print(f'{name}: {os.path.getsize(path) / 1_048_576:.0f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
