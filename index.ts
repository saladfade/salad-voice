import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { Recorder, Player, buildWav } from "./audio.js";
import { WHISPER_URL, transcribe, whisperHealth } from "./stt.js";
import { TTS_SERVER_URL, generateTtsWav, resolveTtsBinary, resolveTtsModel, ttsServerHealthy } from "./tts.js";

const CLONE_WAV = path.join(require("os").homedir(), ".pi", "voice-clone.wav");

/**
 * salad-voice — fully local voice for the Pi TUI.
 *
 *   /voice              record microphone → whisper.cpp STT → send as user message
 *   /voice tts <text>   local Qwen3-TTS (llama-tts) → play via aplayer
 *   /voice stop         stop current playback
 *   /voice status       show server/model status
 *   /voice clone-record record a 10s voice sample for cloning (stored in ~/.pi/voice-clone.wav)
 *   /voice clone-play <text> speak text using the cloned voice
 *   /voice clone        show voice clone status
 *
 * Requirements: alsa-utils (arecord/aplay), whisper.cpp docker server on :8081,
 * llama-tts binary. See README.md.
 */
export default function (pi: ExtensionAPI) {
  let activePlayer: Player | null = null;

  // Register commands at load time (not just on startup) so /voice works
  // in "new", "resume", "fork" sessions too.
  pi.registerCommand("voice", {
    description: "Voice: /voice (dictate), /voice tts <text>, /voice stop, /voice status, /voice clone-record, /voice clone-play",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] ?? "";
      if (sub === "stop") return handleStop(ctx);
      if (sub === "status") return handleStatus(ctx);
      if (sub === "tts") {
        const text = (args ?? "").replace(/^tts\s*/i, "").trim();
        return handleTts(text, ctx);
      }
      if (sub.startsWith("clone")) {
        const sub2 = (args ?? "").trim().split(/[\s-]+/)[1] ?? "";
        if (sub2 === "record") return handleCloneRecord(ctx);
        if (sub2 === "play") {
          const text = (args ?? "").replace(/^clone[\s-]+play[\s-]*/i, "").trim();
          return handleClonePlay(text, ctx);
        }
        return handleCloneStatus(ctx);
      }
      return handleDictate(ctx);
    },
  });

  async function handleDictate(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.setStatus("voice", "Dictation requires the TUI.");
      return;
    }
    if (!(await whisperHealth())) {
      ctx.ui.setStatus("voice", `Whisper server not reachable at ${WHISPER_URL} — start it (see README) and retry.`);
      return;
    }

    const recorder = new Recorder();
    recorder.start();
    const ready = await recorder.waitReady();
    if (!ready) {
      ctx.ui.setStatus("voice", `Microphone unavailable: ${recorder.failed?.message ?? "no audio captured"}`);
      return;
    }

    const pcm = await ctx.ui.custom(
      (tui: TUI, theme: Theme, kb, done) => new RecordingComponent(theme, recorder, done),
    );
    if (!pcm) {
      ctx.ui.setStatus("voice", "Dictation cancelled.");
      return;
    }

    ctx.ui.setStatus("voice", "Transcribing…");
    try {
      const text = (await transcribe(buildWav(pcm))).trim();
      if (!text) {
        ctx.ui.setStatus("voice", "No speech detected.");
        return;
      }
      await pi.sendUserMessage(text);
      ctx.ui.setStatus("voice", "Voice message sent ✓");
    } catch (e) {
      ctx.ui.setStatus("voice", `Transcription failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleTts(text: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!text) {
      ctx.ui.setStatus("voice", "Usage: /voice tts <text to speak>");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.setStatus("voice", "TTS playback requires the TUI.");
      return;
    }
    activePlayer?.stop();
    activePlayer = null;

    const model = resolveTtsModel();
    ctx.ui.setStatus("voice", `Generating speech with ${model}…`);
    const result = await generateTtsWav(text, model);
    if (!result.wav) {
      ctx.ui.setStatus("voice", `TTS failed: ${result.error ?? "unknown error"}`);
      return;
    }

    const player = new Player();
    activePlayer = player;
    let settled = false;
    let done: (err: string | null) => void = () => {};
    const settle = (err: string | null) => {
      if (settled) return;
      settled = true;
      done(err);
    };
    player.onEnd = settle;

    const err = await ctx.ui.custom(
      (tui: TUI, theme: Theme, kb, cb) => {
        done = cb;
        player.start(result.wav);
        return new SpeakingComponent(theme, player, settle);
      },
    );
    activePlayer = null;
    fs.rmSync(result.wav, { force: true });
    if (err) ctx.ui.setStatus("voice", `Playback failed: ${err}`);
    else ctx.ui.setStatus("voice", "Speech complete ✓");
  }

  async function handleCloneRecord(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.setStatus("voice", "Recording requires the TUI.");
      return;
    }

    ctx.ui.setStatus("voice", "Speak clearly for 10 seconds… (Esc to cancel)");
    const recorder = new Recorder();
    recorder.start();
    const ready = await recorder.waitReady();
    if (!ready) {
      ctx.ui.setStatus("voice", `Microphone unavailable: ${recorder.failed?.message ?? "no audio"}`);
      return;
    }

    const pcm = await ctx.ui.custom(
      (tui: TUI, theme: Theme, kb, done) => new CloneRecordComponent(theme, recorder, done),
    );
    if (!pcm) {
      ctx.ui.setStatus("voice", "Recording cancelled.");
      return;
    }

    const wav = buildWav(pcm);
    try {
      fs.mkdirSync(path.dirname(CLONE_WAV), { recursive: true });
      fs.writeFileSync(CLONE_WAV, wav);
      ctx.ui.setStatus("voice", `Voice sample saved to ${CLONE_WAV}`);
    } catch (e) {
      ctx.ui.setStatus("voice", `Failed to save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleClonePlay(text: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!text) {
      ctx.ui.setStatus("voice", "Usage: /voice clone-play <text>");
      return;
    }
    const cloneExists = fs.existsSync(CLONE_WAV);
    if (!cloneExists) {
      ctx.ui.setStatus("voice", "No cloned voice yet — run /voice clone-record first");
      return;
    }

    if (ctx.mode !== "tui") {
      ctx.ui.setStatus("voice", "TTS playback requires the TUI.");
      return;
    }

    activePlayer?.stop();
    activePlayer = null;

    const model = resolveTtsModel();
    ctx.ui.setStatus("voice", `Cloning voice with ${model}…`);
    const result = await generateTtsWav(text, model, CLONE_WAV);
    if (!result.wav) {
      ctx.ui.setStatus("voice", `Voice cloning failed: ${result.error ?? "unknown error"}`);
      return;
    }

    const player = new Player();
    activePlayer = player;
    let settled = false;
    let done: (err: string | null) => void = () => {};
    const settle = (err: string | null) => {
      if (settled) return;
      settled = true;
      done(err);
    };
    player.onEnd = settle;

    const err = await ctx.ui.custom(
      (tui: TUI, theme: Theme, kb, cb) => {
        done = cb;
        player.start(result.wav);
        return new SpeakingComponent(theme, player, settle);
      },
    );
    activePlayer = null;
    fs.rmSync(result.wav, { force: true });
    if (err) ctx.ui.setStatus("voice", `Playback failed: ${err}`);
    else ctx.ui.setStatus("voice", "Cloned speech complete ✓");
  }

  function handleCloneStatus(ctx: ExtensionCommandContext): void {
    const exists = fs.existsSync(CLONE_WAV);
    const size = exists ? fs.statSync(CLONE_WAV).size : 0;
    ctx.ui.setStatus("voice", `Voice clone: ${exists ? "ready (" + (size / 1024).toFixed(1) + " KB)" : "not recorded"}`);
  }

  function handleStop(ctx: ExtensionCommandContext): void {
    if (activePlayer) {
      activePlayer.stop();
      ctx.ui.setStatus("voice", "Stopped playback.");
    } else {
      ctx.ui.setStatus("voice", "Nothing is playing.");
    }
  }

  async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
    const [ok, ttsServer] = await Promise.all([whisperHealth(), ttsServerHealthy()]);
    const model = resolveTtsModel();
    const bin = resolveTtsBinary();
    ctx.ui.setStatus(
      "voice",
      `Whisper: ${WHISPER_URL} → ${ok ? "reachable" : "NOT reachable"} · TTS server: ${TTS_SERVER_URL} → ${ttsServer ? "reachable" : "offline"} · fallback: ${model} @ ${fs.existsSync(bin) ? bin : "NOT FOUND"}`,
    );
  }
}

/** Full-screen "listening" overlay for dictation. */
class RecordingComponent implements Component {
  private finished = false;
  constructor(
    private theme: Theme,
    private recorder: Recorder,
    private onDone: (pcm: Buffer | null) => void,
  ) {}

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      this.finish();
    } else if (matchesKey(data, "escape")) {
      this.finished = true;
      void this.recorder.stop().then(() => this.onDone(null));
    }
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const pcm = await this.recorder.stop();
    this.onDone(pcm);
  }

  render(width: number): string[] {
    const s = Math.floor(this.recorder.durationMs / 1000);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    return [
      this.theme.fg("accent", `🎙 Listening… ${t}`),
      this.theme.fg("dim", "Enter = transcribe · Esc = cancel"),
    ];
  }

  invalidate(): void {}
}

/** Overlay shown while TTS audio plays. */
class SpeakingComponent implements Component {
  private finished = false;
  constructor(
    private theme: Theme,
    private player: Player,
    private onDone: (err: string | null) => void,
  ) {}

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, "escape")) {
      this.finished = true;
      this.player.stop();
      this.onDone(null);
    }
  }

  render(width: number): string[] {
    return [this.theme.fg("accent", "🔊 Speaking… (Esc to stop)")];
  }

  invalidate(): void {}
}

/** Overlay for voice clone recording. */
class CloneRecordComponent implements Component {
  private finished = false;
  constructor(
    private theme: Theme,
    private recorder: Recorder,
    private onDone: (pcm: Buffer | null) => void,
  ) {}

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      this.finish();
    } else if (matchesKey(data, "escape")) {
      this.finished = true;
      void this.recorder.stop().then(() => this.onDone(null));
    }
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const pcm = await this.recorder.stop();
    this.onDone(pcm);
  }

  render(width: number): string[] {
    const s = Math.floor(this.recorder.durationMs / 1000);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    const remaining = Math.max(0, 10 - s);
    return [
      this.theme.fg("accent", `🎙 Recording voice… ${t} / 10s`),
      this.theme.fg("dim", `${remaining}s remaining · Enter to finish · Esc to cancel`),
    ];
  }

  invalidate(): void {}
}
