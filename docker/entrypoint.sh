#!/bin/sh
# Downloads the pinned GGUF models into /models (named volume) on first start, then runs the server.
set -eu
REV=406756ee8e3b16e902ce40112986c1010775f888
BASE="https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/$REV"

fetch() { # $1 = path under /models, $2 = path in the HF repo
    dest="/models/$1"
    if [ ! -s "$dest" ]; then
        echo "downloading $1"
        mkdir -p "$(dirname "$dest")"
        curl -fL --retry 3 -o "$dest.part" "$BASE/$2"
        mv "$dest.part" "$dest"
    fi
}

fetch Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf
fetch Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf
fetch Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-q8_0.gguf Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-q8_0.gguf

if [ "$#" -eq 0 ]; then
    set -- server
fi
if [ "$1" = "server" ]; then shift; fi
exec /app/audiocpp_server --config /app/server.json --backend cpu "$@"
