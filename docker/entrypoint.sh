#!/bin/sh
# Downloads the pinned GGUF models into /models (named volume) on first start, then runs the server.
# Each model is checked against its sha256 (from the HF LFS metadata at REV); a mismatch aborts.
set -eu
REV=406756ee8e3b16e902ce40112986c1010775f888
BASE="https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/$REV"

fetch() { # $1 = path under /models, $2 = path in the HF repo, $3 = sha256
    dest="/models/$1"
    if [ -s "$dest" ] && echo "$3  $dest" | sha256sum -c --status -; then
        return
    fi
    echo "downloading $1"
    mkdir -p "$(dirname "$dest")"
    curl -fL --retry 3 -o "$dest.part" "$BASE/$2"
    if ! echo "$3  $dest.part" | sha256sum -c --status -; then
        rm -f "$dest.part"
        echo "sha256 mismatch for $1" >&2
        exit 1
    fi
    mv "$dest.part" "$dest"
}

fetch Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf 074e61ac1abd3d3efcfc10798d17bf9a975b31768b466fc2578364d206dde64c
fetch Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf 5d800fd204029302c10313daeafdb31c875c7c29ae31974d0d156cc7f512d1d0
fetch Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-q8_0.gguf Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-q8_0.gguf 771420bd20ff5f35407b4fa9cf9c5461e153800d3d772ef51c9febc0a520855d

if [ "$#" -eq 0 ]; then
    set -- server
fi
if [ "$1" = "server" ]; then shift; fi
# max 2 resident models: 3 resident measured 5.38 GiB peak vs 4.73 GiB with 2 under the 6g cap.
exec /app/audiocpp_server --config /app/server.json --backend cpu --max-loaded-models 2 "$@"
