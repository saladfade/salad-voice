import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { Recorder, beginPlayback, buildWav, endPlayback, stopPlayback, wasStopped } from "./audio.js";
import { CLONE_TXT, CLONE_WAV, cloneMissing, playWav, saveClone, speakClone, speakTts } from "./tts.js";
import { containerState, ensureRunning, health, loadedModels, stopContainer, transcribe } from "./stt.js";

/**
 * salad-voice — local voice for the Pi TUI, via the audio.cpp container.
 *
 *   /voice                    record microphone; Enter transcribes and pastes the text into the editor, Esc cancels
 *   /voice tts <text>         speak text with Kokoro
 *   /voice clone-record       record a 10 s voice sample to ~/.pi/voice-clone.wav, transcribed to ~/.pi/voice-clone.txt
 *   /voice clone-play <text>  speak text in the cloned voice (Qwen3-TTS)
 *   /voice clone              show whether the clone sample and transcript exist
 *   /voice status             container state, health and loaded models
 *   /voice stop               stop playback and the container
 *
 * The container (docker/) starts on first use. Requires alsa-utils (arecord, aplay) and docker.
 */
const CLONE_MS = 10_000;
const CLONE_BYTES = 16000 * 2 * 10; // 10 s of 16 kHz mono S16LE

export default function (pi: ExtensionAPI) {
  // Register commands at load time (not just on startup) so /voice works
  // in "new", "resume", "fork" sessions too.
  pi.registerCommand("voice", {
    description: "Voice: /voice (dictate), tts <text>, clone-record, clone-play <text>, clone, status, stop",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      const sp = input.indexOf(" ");
      const sub = sp < 0 ? input : input.slice(0, sp);
      const text = sp < 0 ? "" : input.slice(sp + 1).trim();
      switch (sub) {
        case "":
          return handleDictate(ctx);
        case "tts":
          return handleTts(ctx, text);
        case "clone-record":
          return handleCloneRecord(ctx);
        case "clone-play":
          return handleClonePlay(ctx, text);
        case "clone":
          return handleCloneStatus(ctx);
        case "status":
          return handleStatus(ctx);
        case "stop":
          return handleStop(ctx);
        default:
          return setStatus(ctx, "Usage: /voice | tts <text> | clone-record | clone-play <text> | clone | status | stop");
      }
    },
  });

  async function handleDictate(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") return setStatus(ctx, "Dictation requires the TUI.");
    try {
      await ensureRunning((msg) => setStatus(ctx, msg));
    } catch (e) {
      return setStatus(ctx, `Transcription container not available: ${errMsg(e)}`);
    }

    let pcm: Buffer | null;
    try {
      pcm = await recordPcm(ctx, { label: "🎙 Listening…", hint: "Enter = transcribe · Esc = cancel" });
    } catch (e) {
      return setStatus(ctx, errMsg(e));
    }
    if (!pcm) return setStatus(ctx, "Dictation cancelled.");

    setStatus(ctx, "Transcribing…");
    try {
      const text = await transcribe(buildWav(pcm));
      if (!text) return setStatus(ctx, "No speech detected.");
      ctx.ui.pasteToEditor(text);
      setStatus(ctx, "Transcript pasted into the editor ✓");
    } catch (e) {
      setStatus(ctx, `Transcription failed: ${errMsg(e)}`);
    }
  }

  async function handleTts(ctx: ExtensionCommandContext, text: string): Promise<void> {
    if (!text) return setStatus(ctx, "Usage: /voice tts <text>");
    await speak(ctx, "TTS", () => speakTts(text));
  }

  async function handleClonePlay(ctx: ExtensionCommandContext, text: string): Promise<void> {
    if (!text) return setStatus(ctx, "Usage: /voice clone-play <text>");
    const missing = await cloneMissing();
    if (missing.length) return setStatus(ctx, `No voice clone (missing ${missing.join(", ")}). Run /voice clone-record first.`);
    await speak(ctx, "Clone playback", () => speakClone(text));
  }

  async function handleCloneRecord(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") return setStatus(ctx, "Clone recording requires the TUI.");
    try {
      await ensureRunning((msg) => setStatus(ctx, msg));
    } catch (e) {
      return setStatus(ctx, `Transcription container not available: ${errMsg(e)}`);
    }

    let pcm: Buffer | null;
    try {
      pcm = await recordPcm(ctx, { label: "🎙 Recording voice sample…", hint: "Enter = stop · Esc = cancel", maxMs: CLONE_MS });
    } catch (e) {
      return setStatus(ctx, errMsg(e));
    }
    if (!pcm) return setStatus(ctx, "Clone recording cancelled.");

    setStatus(ctx, "Transcribing voice sample…");
    try {
      const wav = buildWav(pcm.subarray(0, CLONE_BYTES));
      const transcript = await transcribe(wav);
      if (!transcript) return setStatus(ctx, "No speech detected in the sample; clone not saved.");
      await saveClone(wav, transcript);
      setStatus(ctx, `Voice clone saved: ${CLONE_WAV} and ${CLONE_TXT} ✓`);
    } catch (e) {
      setStatus(ctx, `Clone failed: ${errMsg(e)}`);
    }
  }

  async function handleCloneStatus(ctx: ExtensionCommandContext): Promise<void> {
    const missing = await cloneMissing();
    const wav = missing.includes(CLONE_WAV) ? "missing" : "present";
    const txt = missing.includes(CLONE_TXT) ? "missing" : "present";
    const ok = await health();
    const model = !ok ? "container not reachable" : (await loadedModels().catch((): string[] => [])).includes("qwen3-tts") ? "loaded" : "not loaded (loads on first use)";
    setStatus(ctx, `Voice clone: sample ${wav} · transcript ${txt} · qwen3-tts ${model}`);
  }

  async function handleStop(ctx: ExtensionCommandContext): Promise<void> {
    stopPlayback();
    try {
      await stopContainer();
      setStatus(ctx, "Container stopped.");
    } catch (e) {
      setStatus(ctx, `Stop failed: ${errMsg(e)}`);
    }
  }

  async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
    const state = await containerState();
    const ok = await health();
    const loaded = ok ? (await loadedModels().catch(() => [])).join(", ") || "none" : "—";
    setStatus(ctx, `Container: ${state} · Health: ${ok ? "ok" : "not reachable"} · Models: ${loaded}`);
  }

  /** Synthesizes with the container and plays the result; Esc or /voice stop during either phase stops it. */
  async function speak(ctx: ExtensionCommandContext, label: string, synth: () => Promise<Buffer>): Promise<void> {
    beginPlayback();
    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "escape")) return undefined;
      stopPlayback();
      setStatus(ctx, "Playback stopped.");
      return { consume: true };
    });
    try {
      await ensureRunning((msg) => setStatus(ctx, msg));
      if (wasStopped()) return;
      setStatus(ctx, "Synthesizing…");
      const wav = await synth();
      if (wasStopped()) return;
      setStatus(ctx, "Playing… (Esc = stop)");
      if (await playWav(wav)) setStatus(ctx, "Playback finished.");
    } catch (e) {
      setStatus(ctx, `${label} failed: ${errMsg(e)}`);
    } finally {
      unsubscribe();
      endPlayback();
    }
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const setStatus = (ctx: ExtensionCommandContext, msg: string): void => ctx.ui.setStatus("voice", msg);

/**
 * Records from the microphone through the listening overlay. Resolves with the PCM,
 * or null when cancelled with Esc. Throws when the microphone is unavailable.
 */
async function recordPcm(
  ctx: ExtensionCommandContext,
  opts: { label: string; hint: string; maxMs?: number },
): Promise<Buffer | null> {
  const recorder = new Recorder();
  recorder.start();
  try {
    if (!(await recorder.waitReady())) {
      throw new Error(`Microphone unavailable: ${recorder.failed?.message ?? "no audio captured"}`);
    }
    return await ctx.ui.custom<Buffer | null>((_tui, theme, _keybindings, done) => new RecordingComponent(theme, recorder, done, opts));
  } finally {
    await recorder.stop(); // no-op once stopped; kills arecord if the UI threw
  }
}

/** Full-screen recording overlay. Enter resolves with the PCM, Esc with null, maxMs stops it by itself. */
class RecordingComponent implements Component {
  private finished = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private theme: Theme,
    private recorder: Recorder,
    private onDone: (pcm: Buffer | null) => void,
    private opts: { label: string; hint: string; maxMs?: number },
  ) {
    if (opts.maxMs) {
      this.timer = setInterval(() => {
        if (recorder.durationMs >= opts.maxMs!) this.finish(false);
      }, 50);
    }
  }

  private finish(cancel: boolean): void {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    void this.recorder.stop().then((pcm) => this.onDone(cancel ? null : pcm));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.finish(true);
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) this.finish(false);
  }

  render(): string[] {
    const s = Math.floor(this.recorder.durationMs / 1000);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    return [this.theme.fg("accent", `${this.opts.label} ${t}`), this.theme.fg("dim", this.opts.hint)];
  }

  invalidate(): void {}
}
