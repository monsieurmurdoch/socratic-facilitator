import sys
import json
from vosk import Model, KaldiRecognizer

def main():
    model = Model("server/models/stt/vosk-model")
    rec = KaldiRecognizer(model, 16000)

    # Read from stdin continuously
    while True:
        data = sys.stdin.buffer.read(4000)
        if len(data) == 0:
            break
        if rec.AcceptWaveform(data):
            print(rec.Result(), flush=True)
        else:
            print(rec.PartialResult(), flush=True)

if __name__ == '__main__':
    main()
