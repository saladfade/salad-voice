# salad-voice

Fully local voice for the Pi coding agent: microphone dictation (speech-to-text),
text-to-speech with Kokoro, and voice cloning with Qwen3-TTS. All models run on CPU
inside one Docker container built from [audio.cpp](https://github.com/0xShug0/audio.cpp).
No cloud calls and no native Node modules.

## Commands

| Command | What it does |
|---|---|
| `/voice` | Record from the microphone (Enter = transcribe, Esc = cancel) and paste the transcript into the editor |
| `/voice tts <text>` | Speak `text` with the stock Kokoro voice (`af_heart`) and play it |
| `/voice clone-record` | Record a 10-second voice sample to `~/.pi/voice-clone.wav`, transcribed to `~/.pi/voice-clone.txt` |
| `/voice clone-play <text>` | Speak `text` in your cloned voice (Qwen3-TTS) |
| `/voice clone` | Show whether the clone sample and transcript exist |
| `/voice status` | Show container state, health and loaded models |
| `/voice stop` | Stop playback and stop the container |

The container starts on first use. The first start builds the image and downloads the models (slow).

## Architecture

```
Pi extension (index.ts, audio.ts, stt.ts, tts.ts)
  - arecord / aplay for audio capture and playback
  - HTTP to 127.0.0.1:8082 and docker CLI for start/stop/status
        |
        v
Docker container "salad-audiocpp" (image salad-audiocpp:latest)
  - audiocpp_server, CPU backend, 4 CPUs, 6 GiB memory limit
  - Parakeet-TDT 0.6B v3 (ASR), Kokoro 82M (TTS), Qwen3-TTS 0.6B Base (voice-clone TTS)
  - at most 2 models resident at once (--max-loaded-models 2)
  - /models  <-  named volume "salad-audiocpp-models"
```

HTTP API used by the extension:

- `GET /health`, `GET /v1/models`
- `POST /v1/audio/transcriptions` (multipart `file`, `model=parakeet-tdt`)
- `POST /v1/audio/speech` (`model=kokoro` or `model=qwen3-tts`; voice clone sent inline as base64 `voice_ref`)

### Container files

- `docker/Dockerfile`: two-stage build. Compiles `audiocpp_server` from a pinned audio.cpp commit (`AUDIOCPP_REF`) and runs it on Ubuntu 24.04 as user `ubuntu`. Models are not baked in.
- `docker/entrypoint.sh`: downloads the three pinned GGUF models into `/models` if missing, checks each file's sha256 against the expected value, then starts the server with `--max-loaded-models 2`.
- `docker/server.json`: server config (port 8082, CPU backend, lazy loading, model list).

## Setup

Install into your project's `.pi/extensions` (run from the project root):

```bash
mkdir -p .pi/extensions && cd .pi/extensions
git clone https://github.com/saladfade/salad-voice.git
```

Requirements:

- `alsa-utils` (`arecord`, `aplay`) for microphone and playback
- Docker, with your user in the `docker` group (`sudo usermod -aG docker $USER`, then log in again)
- Disk: about 3 GB for the models in the volume, plus the image

Then start Pi with this extension loaded and run `/voice status`. To build and start the
container by hand instead:

```bash
docker build -t salad-audiocpp:latest .pi/extensions/salad-voice/docker
docker run -d --name salad-audiocpp --restart unless-stopped --cpus 4 --memory 6g \
  -p 127.0.0.1:8082:8082 -v salad-audiocpp-models:/models salad-audiocpp:latest
curl http://127.0.0.1:8082/health
```

Port 8082 is bound to localhost only.

## Models

| File in `/models` | Role | sha256 |
|---|---|---|
| `Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf` | speech-to-text | `074e61ac…dde64c` |
| `Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf` | stock-voice TTS | `5d800fd2…512d1d0` |
| `Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-q8_0.gguf` | voice-clone TTS | `771420bd…520855d` |

All three come from `huggingface.co/audio-cpp/audio.cpp-gguf` at revision `406756ee`. The full
hashes are in `docker/entrypoint.sh`.

## Voice cloning

1. Run `/voice clone-record` and speak clearly for 10 seconds.
2. Run `/voice clone-play hello, this is my voice` to speak in that voice.

The sample stays on disk in `~/.pi/voice-clone.wav`; the transcript is in `~/.pi/voice-clone.txt`.

## Environment variables

None. The extension and the container read no environment variables. Container limits
and the model cap are set in the `docker run` flags used by `stt.ts` (`--cpus 4 --memory 6g`)
and in `docker/entrypoint.sh` (`--max-loaded-models 2`).

## Troubleshooting

- **"Docker not available"**: start the Docker daemon, and check that your user can run `docker info` without sudo.
- **"container not healthy after 10 min"**: run `docker logs salad-audiocpp`. A slow first-time model download is the usual cause; run `/voice status` again once it finishes.
- **"sha256 mismatch for ..."** in the logs: the download was corrupt or the file is not the pinned revision. Remove that file from the volume (`docker exec salad-audiocpp rm -f /models/<path>`), then start the container again.
- **"voice clone incomplete"**: run `/voice clone-record` to create the sample and transcript.
- **Out of memory**: the container is capped at 6 GiB. Peak measured RAM is about 2.5 GiB with Kokoro and Parakeet requests.
- **No audio captured**: check that `arecord` works from the shell and that the microphone is the default ALSA device.

## Files

- `index.ts`: `/voice` command and TUI components (recording, speaking, clone recording)
- `audio.ts`: `arecord` capture, `aplay`/`paplay` playback, WAV header builder
- `stt.ts`: container start/stop/status and the transcription client
- `tts.ts`: Kokoro and Qwen3-TTS requests, clone files in `~/.pi`
- `docker/`: container image, entrypoint and server config
