# salad-voice

Fully local voice for the Pi coding agent: microphone dictation (STT),
text-to-speech (TTS), and voice cloning — no cloud, no native Node modules.

## Commands

| Command | What it does |
|---|---|
| ``/voice`` | Record microphone (Enter = transcribe, Esc = cancel) → whisper.cpp → sent as a user message |
| ``/voice tts <text>`` | Synthesize with Qwen3-TTS (llama-tts) and play it back |
| ``/voice stop`` | Stop current playback |
| ``/voice status`` | Show whisper server / TTS model / binary status |
| ``/voice clone-record`` | Record a 10-second voice sample for cloning (stored in `~/.pi/voice-clone.wav`) |
| ``/voice clone-play <text>`` | Speak `text` using your cloned voice |

## Requirements

- ``alsa-utils`` (arecord, aplay) — installed
- Docker for the whisper and TTS servers
- ``~/llama.cpp/bin/llama-tts`` — optional local TTS fallback

## 1. Build & run the whisper server (STT)

```bash
sudo docker build -t salad-whisper .pi/extensions/salad-voice/docker
sudo docker run --rm -p 8081:8081 salad-whisper
```

(`sudo` needed until you're in the `docker` group: `sudo usermod -aG docker $USER`, then re-login.)

The server loads `base.en` (~142 MB) at startup and serves
`POST /inference` (multipart `file`) and `GET /health` on port 8081.

Better accuracy: edit the model URL in `docker/Dockerfile` to
`ggml-small.en.bin` (~244 MB) and rebuild.

## 2. Build & run the TTS server (audio.cpp)

```bash
cd .pi/extensions/salad-voice/docker
sudo docker build -f Dockerfile.tts -t salad-tts .
sudo docker run --rm -p 8082:8080 salad-tts
```

The image bakes in the Qwen3-TTS 1.7B Base GGUF (audio.cpp format, ~1.1 GB,
downloaded at build time) and the default voice reference (`voice/b.wav`).
The server serves `POST /v1/audio/speech` and `GET /health` on port 8082.

Voice cloning works without staging files: the extension sends the recorded
sample inline as base64 `voice_ref`.

### Local fallback

If the TTS server is not running, `tts.ts` falls back to the local
`llama-tts` binary (auto-detected: `SALAD_LLAMA_TTS` → known install
locations → PATH), forced to CPU via `CUDA_VISIBLE_DEVICES=99` (the GPU is
usually occupied by Pi's own LLM). First run downloads
`ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF` (~1.7 GB) into the Hugging Face
cache.

Override with `SALAD_TTS_MODEL` (HF repo id or local `.gguf` path — the
`mmproj` next to a local backbone is picked up automatically).
If a TTS entry appears in `~/.pi/agent/models-store.json` or
`llamacpp-infra-models.json`, it is picked up automatically.

Note: Qwen3-TTS can repeat the phrase in the generated audio (a ~5 s
phrase came out as ~12 s in testing), so transcripts may contain the
repetition too.

## 3. Voice cloning

Record your voice sample (speak clearly for 10 seconds):

```
/voice clone-record
```

Then use it to speak any text in your voice:

```
/voice clone-play hello, this is my voice
```

The cloned sample is stored at `~/.pi/voice-clone.wav`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| ``SALAD_WHISPER_URL`` | ``http://127.0.0.1:8081`` | whisper server base URL |
| ``SALAD_TTS_URL`` | ``http://127.0.0.1:8082`` | audio.cpp TTS server base URL |
| ``SALAD_LLAMA_TTS`` | ``~/llama.cpp/bin/llama-tts`` | llama-tts fallback binary |
| ``SALAD_TTS_MODEL`` | ``ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF`` | TTS model |

## Files

- ``index.ts`` — ``/voice`` command + TUI overlays (RecordingComponent, SpeakingComponent, CloneRecordComponent)
- ``audio.ts`` — arecord capture, aplayer playback, WAV header builder
- ``stt.ts`` — whisper server HTTP client
- ``tts.ts`` — audio.cpp server client + llama-tts fallback (voice cloning via inline base64 `voice_ref` / `--tts-speaker-file`)
- ``docker/Dockerfile`` — whisper.cpp server image
- ``docker/Dockerfile.tts`` + ``docker/server.json`` — audio.cpp TTS server image
- ``voice/b.wav`` — default voice reference (baked into the TTS image)
