/* Audio recording via MediaRecorder.

   Why this exists: the Web Speech API is a dictation API, not a transcription one. It
   drops audio it cannot finalize, times out on silence, and never exposes the raw audio,
   so a conversation reliably loses sentences no matter how the restarts are handled.

   MediaRecorder instead captures to a file — it is a tape recorder, so nothing can be
   "missed". The complete recording then goes to the same AssemblyAI pipeline the Upload
   tab uses, which yields accurate text *and* speaker separation.

   Live captions still run alongside as a disposable preview, so there is something to
   watch while recording; the accurate transcript replaces it on stop.

   Three sources are supported — see SOURCES below. Capturing what the computer is playing
   needs getDisplayMedia, which is a screen-sharing API: the browser will only hand over
   audio the user has explicitly picked in its own dialog, and there is no way to request
   audio without it. Two consequences worth knowing:

     - On macOS, Chrome can only capture the audio of a *tab*, never the whole system.
       Windows also allows whole-screen audio. This is enforced by the browser.
     - The user must tick "Share tab audio" in that dialog. If they forget, the stream
       arrives with no audio track at all, which is why that case is detected and reported
       rather than left to produce a silent recording. */

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',              // Safari
  'audio/ogg;codecs=opus',
];

export const SOURCES = ['mic', 'system', 'both'];

export function recordingSupported() {
  return typeof MediaRecorder !== 'undefined'
      && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/* Whether this browser can capture what the computer is playing. Safari and Firefox
   expose getDisplayMedia but decline to include audio, so presence of the method is
   necessary rather than sufficient — an empty audio track is caught at capture time. */
export function systemAudioSupported() {
  return !!navigator.mediaDevices?.getDisplayMedia;
}

/* Raised when the user completed the share dialog but left "Share tab audio" unticked.
   Distinguished from a cancel so the caller can explain the fix rather than fall silent. */
export class NoSystemAudioError extends Error {
  constructor() { super('no-system-audio'); this.name = 'NoSystemAudioError'; }
}

function pickMime() {
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';   // let the browser choose
}

export class Recorder {
  /* source — 'mic' (default), 'system' (what the computer is playing), or 'both'.
     onEnded() — the user revoked the screen share from the browser's own banner, which
                 ends system capture without touching this page. */
  constructor({ onLevel, onTick, onError, onEnded, source = 'mic' } = {}) {
    this.onLevel = onLevel; this.onTick = onTick; this.onError = onError;
    this.onEnded = onEnded;
    this.source = SOURCES.includes(source) ? source : 'mic';
    this.chunks = [];
    this.stream = null; this.rec = null; this.ctx = null;
    this.mixer = null; this.sources = [];
    this.startedAt = 0; this.raf = 0; this.timer = 0;
    this.pausedAt = 0; this.pausedMs = 0;
  }

  /* `active` covers a paused session too: the take is still open, the tracks are still
     held, and Stop is still the way out of it. `paused` distinguishes the two states. */
  get active() {
    return !!(this.rec && (this.rec.state === 'recording' || this.rec.state === 'paused'));
  }
  get paused() { return !!(this.rec && this.rec.state === 'paused'); }

  /* Recorded time, not wall-clock time — paused stretches are excluded, so the timer
     matches the length of the audio that will actually be transcribed and billed. */
  get elapsed() {
    if (!this.startedAt) return 0;
    return (this.pausedAt || Date.now()) - this.startedAt - this.pausedMs;
  }

  /* Suspend capture without ending the take. MediaRecorder keeps its chunks and resumes
     into the same file, so the paused stretch simply is not in the recording — which is
     the point: the final transcription pass is billed by audio length.

     The tracks are deliberately left running. Re-acquiring them would mean a fresh
     permission prompt, and for system audio a fresh share dialog, which would make
     resuming more disruptive than just leaving the recording going. */
  pause() {
    if (!this.rec || this.rec.state !== 'recording') return false;
    this.rec.pause();
    this.pausedAt = Date.now();
    return true;
  }

  resume() {
    if (!this.rec || this.rec.state !== 'paused') return false;
    this.rec.resume();
    this.pausedMs += Date.now() - this.pausedAt;
    this.pausedAt = 0;
    return true;
  }

  async start() {
    const wantsMic = this.source === 'mic' || this.source === 'both';
    const wantsSys = this.source === 'system' || this.source === 'both';

    /* Echo cancellation exists to subtract the speakers from the microphone — precisely
       the audio we are here to capture. Leaving it on while recording system sound would
       silently erase the far end of the call, so it is disabled whenever system audio is
       in play, and kept on for a plain mic recording where it genuinely helps. */
    if (wantsMic) {
      const clean = !wantsSys;
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: clean, noiseSuppression: clean, autoGainControl: clean },
      });
    }

    if (wantsSys) {
      try {
        /* video:true is required — Chrome rejects an audio-only display capture — but the
           video track is discarded immediately below; only the audio is kept. */
        this.display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (e) {
        this.mic?.getTracks().forEach(t => t.stop());   // don't strand the mic permission
        throw e;
      }
      this.display.getVideoTracks().forEach(t => { t.stop(); this.display.removeTrack(t); });

      if (!this.display.getAudioTracks().length) {
        this.mic?.getTracks().forEach(t => t.stop());
        this.display.getTracks().forEach(t => t.stop());
        throw new NoSystemAudioError();
      }
      // Stopping the share from Chrome's floating banner must not leave a dead recorder.
      this.display.getAudioTracks()[0].addEventListener('ended', () => this.onEnded?.());
    }

    this.stream = this.mixStreams();

    const mimeType = pickMime();
    this.mimeType = mimeType || 'audio/webm';
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.onerror = e => this.onError?.(e.error?.message || 'Recording failed.');
    // Emit a chunk every second so a crash cannot lose the whole session.
    this.rec.start(1000);
    this.startedAt = Date.now();

    this.startMeter();
    this.timer = setInterval(() => this.onTick?.(this.elapsed), 250);
  }

  /* Combine whichever sources were captured into the single track that MediaRecorder and
     the live stream both consume. With one source the stream is passed straight through —
     mixing a lone input through WebAudio would add a resampling stage for nothing.

     The two inputs are summed at slightly under unity: mic and system audio are each
     already normalised to peak near full scale, so adding them raw clips on loud moments.
     Attenuating both leaves headroom for the sum. */
  mixStreams() {
    const streams = [this.mic, this.display].filter(Boolean);
    if (streams.length === 1) return streams[0];

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.mixer = ctx;
    const dest = ctx.createMediaStreamDestination();
    for (const s of streams) {
      const gain = ctx.createGain();
      gain.gain.value = 0.75;
      const node = ctx.createMediaStreamSource(s);
      node.connect(gain).connect(dest);
      this.sources.push(node);
    }
    return dest.stream;
  }

  /* Resolves with the finished audio as a File, ready to upload. */
  stop() {
    return new Promise(resolve => {
      clearInterval(this.timer);
      cancelAnimationFrame(this.raf);
      const finish = () => {
        // Stop the captured sources, not just the mixed output — the mixed stream's track
        // is synthesised, so stopping it alone would leave the mic and the screen share
        // live, and Chrome's "sharing" banner on screen.
        for (const s of [this.stream, this.mic, this.display]) {
          s?.getTracks().forEach(t => t.stop());
        }
        this.ctx?.close().catch(() => {});
        this.mixer?.close().catch(() => {});
        this.ctx = null; this.mixer = null; this.sources = [];
        this.stream = null; this.mic = null; this.display = null;
        this.onLevel?.(0);
        const blob = new Blob(this.chunks, { type: this.mimeType });
        const ext = this.mimeType.includes('mp4') ? 'm4a'
                  : this.mimeType.includes('ogg') ? 'ogg' : 'webm';
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        resolve(new File([blob], `recording-${stamp}.${ext}`, { type: this.mimeType }));
      };
      if (this.rec && this.rec.state !== 'inactive') {
        this.rec.onstop = finish;
        this.rec.stop();
      } else finish();
    });
  }

  /* Input-level meter, so the user can see the mic is live. */
  startMeter() {
    if (!this.onLevel) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(this.stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!this.ctx) return;
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        this.onLevel(Math.min(1, peak / 60));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* meter is optional */ }
  }
}
