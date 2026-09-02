import {
  splitIntoSegments, buildTxt, buildMarkdown, buildSrt, buildVtt, buildJson,
  fmtTime, talkTime,
} from './transcript.js';
import { PROVIDERS, summarize, buildPrompt, estimateTokens } from './llm.js';
import { Recorder, recordingSupported, systemAudioSupported,
         NoSystemAudioError } from './record.js';
import { LiveStream } from './stream.js';
import { PipWindow, supported as pipSupported } from './pip.js';
import { LiveSession, isSupported as liveSupported, secureOrigin, browserNote,
         localModelState, installLocalModel, probeConnectivity, LANGS } from './live.js';
import { t, setLang, getLang, detectLang, apply as applyI18n } from './i18n.js';

const API = 'https://api.assemblyai.com/v2';
const $ = id => document.getElementById(id);

let picked = null;          // the File the user chose
let segments = [];          // shaped transcript
let names = {};             // speaker label -> display name
let rows = [];              // { el, seg } for search/highlight
let baseName = 'transcript';
let stopAt = null, playingEl = null;
let live = null;            // active live-caption session, if any

const audio = $('audio'), list = $('list'), statusEl = $('status');

/* ---------------- language, then the compliance notice ----------------
   The notice is legal text, so it is shown only once the interface language is settled —
   a first-time visitor picks a language and reads the notice in it. */
const langMenu = $('langmenu');
const LANG_LABEL = { en: 'English', zh: '中文', ja: '日本語', ko: '한국어',
                     es: 'Español', fr: 'Français', de: 'Deutsch' };

function applyUiLang(lang) {
  const l = setLang(lang);
  $('langcur').textContent = LANG_LABEL[l];
  for (const b of langMenu.querySelectorAll('[data-ui-lang]')) {
    b.classList.toggle('sel', b.dataset.uiLang === l);
  }
  refreshDynamicText();
}

$('langbtn').onclick = e => {
  e.stopPropagation();
  const open = langMenu.classList.toggle('open');
  $('langbtn').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', () => {
  langMenu.classList.remove('open');
  $('langbtn').setAttribute('aria-expanded', 'false');
});
for (const b of langMenu.querySelectorAll('[data-ui-lang]')) {
  b.onclick = () => {
    applyUiLang(b.dataset.uiLang);
    langMenu.classList.remove('open');
    if (!localStorage.getItem('legal_ack')) $('legal').classList.add('show');
  };
}

applyUiLang(detectLang());
if (!localStorage.getItem('legal_ack')) $('legal').classList.add('show');

$('legalok').onclick = () => {
  localStorage.setItem('legal_ack', '1');
  $('legal').classList.remove('show');
};

/* Re-render anything built in JS rather than marked up with data-i18n.
   Runs during module init as well as on later switches, so it must not touch state that
   is still being set up further down — look elements up directly, and no-op when empty. */
function refreshDynamicText() {
  const k = $('key');
  if (k) $('keynote').textContent = k.value.trim() ? t('settings.hasKey') : '';
  if ($('toggle-label')) syncSettingsToggle();
  if (segments.length) { drawRows(); drawStats(); applySearch(); }
  else $('hint').textContent = t('hint.default');
  if ($('livego')) syncRecordLabels();
}

/* ---------------- key storage ----------------
   Keys default to localStorage so they survive a reload. On a shared or public computer
   that is the wrong default, so `remember` switches to sessionStorage, which the browser
   discards when the tab closes. Both are same-origin only — no other site can read them. */
const keyStore = {
  get remember() { return localStorage.getItem('remember_keys') !== '0'; },
  set remember(v) {
    localStorage.setItem('remember_keys', v ? '1' : '0');
    // moving between stores: carry values across, then clear the one we left
    const from = v ? sessionStorage : localStorage;
    const to   = v ? localStorage : sessionStorage;
    for (const k of KEY_NAMES) {
      const val = from.getItem(k);
      if (val !== null) { to.setItem(k, val); from.removeItem(k); }
    }
  },
  store() { return this.remember ? localStorage : sessionStorage; },
  get(k) { return sessionStorage.getItem(k) ?? localStorage.getItem(k); },
  set(k, v) { this.store().setItem(k, v); },
  del(k) { localStorage.removeItem(k); sessionStorage.removeItem(k); },
  clearAll() { for (const k of KEY_NAMES) this.del(k); },
};
// every key-bearing entry, so switching modes or wiping covers all of them
const KEY_NAMES = ['aai_key', ...Object.keys(PROVIDERS).map(p => 'llm_key_' + p)];

/* ---------------- settings: transcription key ---------------- */
const keyInput = $('key');
keyInput.value = keyStore.get('aai_key') || '';
if (keyInput.value) $('keynote').textContent = t('settings.hasKey');
$('savekey').onclick = () => {
  const v = keyInput.value.trim();
  if (v) { keyStore.set('aai_key', v); $('keynote').textContent = t(keyStore.remember ? 'settings.saved' : 'settings.savedSession'); }
  else { keyStore.del('aai_key'); $('keynote').textContent = t('settings.cleared'); }
  refresh();
};
keyInput.oninput = refresh;

/* ---------------- settings: LLM provider ---------------- */
const provSel = $('provider'), modelSel = $('model'), llmKey = $('llmkey'), baseInput = $('baseurl');

for (const [id, p] of Object.entries(PROVIDERS)) {
  provSel.append(new Option(p.label, id));
}
provSel.value = localStorage.getItem('llm_provider') || 'openai';

function syncProvider() {
  const cfg = PROVIDERS[provSel.value];
  modelSel.textContent = '';
  for (const m of cfg.models) modelSel.append(new Option(m, m));
  // remembered model for this provider, if any
  const remembered = localStorage.getItem('llm_model_' + provSel.value);
  if (remembered) {
    if (![...modelSel.options].some(o => o.value === remembered)) modelSel.append(new Option(remembered, remembered));
    modelSel.value = remembered;
  }
  llmKey.value = keyStore.get('llm_key_' + provSel.value) || '';
  baseInput.value = localStorage.getItem('llm_base_' + provSel.value) || cfg.base;
  $('provnote').textContent = cfg.note || '';
  $('getkey').href = cfg.keyUrl || '#';
  $('getkey').style.display = cfg.keyUrl ? 'inline' : 'none';
  $('customwrap').style.display = provSel.value === 'custom' ? 'block' : 'none';
}
provSel.onchange = () => { localStorage.setItem('llm_provider', provSel.value); syncProvider(); };
syncProvider();

$('savellm').onclick = () => {
  const p = provSel.value;
  const k = llmKey.value.trim();
  if (k) keyStore.set('llm_key_' + p, k); else keyStore.del('llm_key_' + p);
  localStorage.setItem('llm_model_' + p, modelSel.value);
  const b = baseInput.value.trim();
  if (b) localStorage.setItem('llm_base_' + p, b); else localStorage.removeItem('llm_base_' + p);
  $('llmnote').textContent = k ? t(keyStore.remember ? 'settings.saved' : 'settings.savedSession') : t('settings.cleared');
};

// let the user type a model name that isn't in the list
$('addmodel').onclick = () => {
  const m = prompt(t('settings.modelPrompt'));
  if (m) { modelSel.append(new Option(m, m)); modelSel.value = m; }
};

/* remember-keys toggle and the wipe button */
$('rememberkeys').checked = keyStore.remember;
$('rememberkeys').onchange = e => {
  keyStore.remember = e.target.checked;
  $('keynote').textContent = t(e.target.checked ? 'settings.saved' : 'settings.savedSession');
};
$('forgetkeys').onclick = () => {
  keyStore.clearAll();
  keyInput.value = '';
  llmKey.value = '';
  $('keynote').textContent = t('settings.cleared');
  $('llmnote').textContent = '';
  refresh();
};

function syncSettingsToggle() {
  const collapsed = $('setup').classList.contains('collapsed');
  $('toggle-label').textContent = collapsed ? t('settings.show') : t('settings.hide');
  $('toggle-settings').setAttribute('aria-expanded', String(!collapsed));
  // amber until a transcription key is set, so the way in is obvious
  $('toggle-settings').classList.toggle('needskey', !$('key').value.trim());
}
$('toggle-settings').onclick = () => {
  $('setup').classList.toggle('collapsed');
  syncSettingsToggle();
};
syncSettingsToggle();

/* ---------------- file picking ---------------- */
const drop = $('drop'), fileInput = $('file');
drop.onclick = () => fileInput.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
};
fileInput.onchange = () => { if (fileInput.files[0]) setFile(fileInput.files[0]); };

function setFile(f) {
  picked = f;
  $('fname').textContent = f.name + '  (' + (f.size / 1048576).toFixed(1) + ' MB)';
  refresh();
}
function refresh() {
  $('go').disabled = !(picked && keyInput.value.trim());
  syncSettingsToggle();
}

function say(msg, isErr) {
  statusEl.textContent = msg;
  statusEl.className = 'show' + (isErr ? ' err' : '');
}

/* ---------------- transcribe ----------------
   Shared by the Upload tab and the Record tab: both end up with a File and want the
   same speaker-separated result, so there is one implementation. */
async function transcribeFile(file, key, progress) {
  progress(t('upload.uploading') + ' ' + file.name + '…');
  const up = await fetch(API + '/upload', {
    method: 'POST', headers: { authorization: key }, body: file,
  });
  if (!up.ok) throw new Error('Upload failed (' + up.status + '). '
    + (up.status === 401 ? 'That API key was rejected.' : await up.text()));
  const { upload_url } = await up.json();

  progress(t('upload.queued'));
  const post = await fetch(API + '/transcript', {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({
      audio_url: upload_url,
      speaker_labels: true,
      speech_models: ['universal-3-pro', 'universal-2'],
    }),
  });
  if (!post.ok) throw new Error('Could not start transcription. ' + await post.text());
  const { id } = await post.json();

  const started = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 4000));
    const res = await fetch(API + '/transcript/' + id, { headers: { authorization: key } });
    const job = await res.json();
    if (job.status === 'completed') return job;
    if (job.status === 'error') throw new Error(job.error || 'Transcription failed.');
    const el = Date.now() - started;
    progress(t('upload.working') + ' ' + Math.floor(el / 60000) + 'm '
      + String(Math.floor(el / 1000) % 60).padStart(2, '0') + 's ' + t('upload.elapsed'));
  }
}

$('go').onclick = async () => {
  const key = keyInput.value.trim();
  if (!picked || !key) return;
  $('go').disabled = true;
  try {
    render(await transcribeFile(picked, key, say));
  } catch (e) {
    say(e.message || String(e), true);
  } finally {
    $('go').disabled = false;
  }
};

/* ---------------- record ----------------
   MediaRecorder captures the audio; AssemblyAI transcribes the complete file. Live
   captions run alongside purely as a preview, because the Web Speech API drops speech
   it cannot finalize and can never be made reliable enough to be the record itself. */
let recorder = null;
let liveStream = null;
let pip = null;             // floating always-on-top window, while recording
let finals = [];            // { text, gap } per completed turn, mirrored into the PiP window
let idleTimer = 0;          // fires when nobody has spoken for IDLE_STOP_MS
let breakNext = false;      // the next turn follows a pause and starts a new paragraph

/* Any value the floating window reads as a handover will do; a pause is by definition a
   longer break than the one that grouping is trying to detect. */
const RESUME_GAP_MS = 5000;

/* A recording left running costs money on two counts: the streaming socket bills for as
   long as it is open, and the final pass bills for the whole file — so a session forgotten
   overnight is charged for the silence twice over. Stopping on silence bounds both.

   Ten minutes is long enough to sit through a pause in a meeting, a question being read, or
   someone stepping out, and short enough that a session forgotten at the end of the day
   costs minutes rather than hours. */
const IDLE_STOP_MS = 10 * 60 * 1000;

for (const [code, label] of LANGS) $('lang').append(new Option(label, code));
$('source').value = localStorage.getItem('live_source') || 'mic';
$('source').onchange = () => localStorage.setItem('live_source', $('source').value);
if (!systemAudioSupported()) {
  // Keep the control visible but honest: the options simply cannot work here.
  for (const o of $('source').options) if (o.value !== 'mic') o.disabled = true;
}

$('lang').value = localStorage.getItem('live_lang') || 'en-US';
$('lang').onchange = () => {
  localStorage.setItem('live_lang', $('lang').value);
  if (live) live.setLang($('lang').value);
};

function showMode(mode) {
  const up = mode === 'upload';
  $('pane-upload').style.display = up ? '' : 'none';
  $('pane-live').style.display = up ? 'none' : '';
  $('tab-upload').classList.toggle('active', up);
  $('tab-live').classList.toggle('active', !up);
  if (!up && !recordingSupported()) {
    $('livego').disabled = true;
    $('livenote').className = 'note err';
    $('livenote').textContent = t('live.unsupported');
  }
}
$('tab-upload').onclick = () => showMode('upload');
$('tab-live').onclick = () => showMode('live');

const mmss = ms => String(Math.floor(ms / 60000)).padStart(2, '0') + ':'
                 + String(Math.floor(ms / 1000) % 60).padStart(2, '0');

$('livego').onclick = async () => {
  if (recorder && recorder.active) { finishRecording(); return; }

  const key = keyInput.value.trim();
  if (!key) {
    $('setup').classList.remove('collapsed');
    syncSettingsToggle();
    $('livenote').className = 'note err';
    $('livenote').textContent = t('live.needkey');
    return;
  }

  $('livetext').textContent = '';
  $('interim').textContent = '';
  $('livenote').className = 'note';
  $('livenote').textContent = $('source').value === 'mic'
    ? t('live.recording') : t('live.sysHint');
  finals = [];

  recorder = new Recorder({
    onLevel: v => {
      $('meterwrap').classList.add('show');
      $('meter').style.width = Math.round(v * 100) + '%';
      pip?.setLevel(v);
    },
    onTick: ms => { $('rectime').textContent = mmss(ms); pip?.setTime(mmss(ms)); },
    onError: msg => { $('livenote').className = 'note err'; $('livenote').textContent = msg; },
    // Chrome's own "Stop sharing" banner ends the capture behind our back; finish the
    // recording properly so the audio is still transcribed rather than silently dropped.
    onEnded: () => { if (recorder?.active) finishRecording(); },
    source: $('source').value,
  });

  try {
    await recorder.start();
  } catch (e) {
    recorder = null;
    $('livenote').className = 'note err';
    const usingSystem = $('source').value !== 'mic';
    $('livenote').textContent =
        e instanceof NoSystemAudioError ? t('live.noSysAudio')
      : e.name === 'NotAllowedError'    ? (usingSystem ? t('live.shareDenied') : t('live.micdenied'))
      : (e.message || String(e));
    return;
  }

  setRecordState('recording');
  startLiveStream(key);
  noteSpeech();          // arm the idle countdown; silence from the outset still stops

  // Float the session above other apps, so it stays visible once the user switches to
  // the call they are recording. Best-effort: unsupported browsers, and a user who
  // dismisses the window, both just keep the in-page view.
  openPip();
};

/* ---------------- pause ----------------
   Pausing is a cost control, not just a convenience. A recording left running through a
   break is billed twice over: the streaming socket bills for as long as it is open, and
   the final pass bills for every minute of the file. Pausing closes the socket and stops
   the recorder, so a ten-minute break costs nothing on either count.

   The tracks stay held (see Recorder.pause) and the take stays open, so resuming is one
   click with no permission prompt and the audio continues into the same file. */
function setRecordState(state) {
  $('livego').dataset.state = state;
  $('livego').classList.toggle('listening', state === 'recording');
  $('rectime').classList.toggle('live', state === 'recording');
  $('rectime').classList.toggle('paused', state === 'paused');
  syncRecordLabels();
  pip?.setPaused(state === 'paused');
}

/* Labels only, driven off the button's own state — so a language switch can relabel both
   buttons without reaching for recorder state that may not exist yet at module init. */
function syncRecordLabels() {
  const state = $('livego').dataset.state || 'idle';
  $('livego').textContent = state === 'idle' ? t('live.start') : t('live.stop');
  const p = $('livepause');
  if (!p) return;
  p.style.display = state === 'idle' ? 'none' : '';
  p.textContent = state === 'paused' ? t('live.resume') : t('live.pause');
}

function pauseRecording() {
  if (!recorder?.pause()) return;
  // Closing the socket is where the streaming bill actually stops. It cannot be paused,
  // only closed and reopened — hence the fresh LiveStream on resume.
  if (liveStream) { liveStream.stop(); liveStream = null; }
  clearTimeout(idleTimer);
  $('interim').textContent = '';
  pip?.setCaptions(finals, '');
  setRecordState('paused');
  $('livenote').className = 'note';
  $('livenote').textContent = t('live.paused');
}

function resumeRecording() {
  const key = keyInput.value.trim();
  if (!recorder?.resume()) return;
  startLiveStream(key);
  // The pause is a gap in the conversation by definition, so the first turn after it
  // starts a new paragraph. The new socket's own timings restart at zero and would
  // otherwise report no gap at all, running the two halves of the break together.
  breakNext = true;
  noteSpeech();
  setRecordState('recording');
  $('livenote').className = 'note';
  $('livenote').textContent = pip?.open ? t('live.pipOpen') : t('live.recording');
}

$('livepause').onclick = () => {
  if (!recorder?.active) return;
  if (recorder.paused) resumeRecording(); else pauseRecording();
};

/* Live transcript from AssemblyAI's streaming API, over the same mic stream. Accurate
   enough to be the real thing rather than a rough preview; speaker labels still come from
   the final pass once the full recording is available.

   Built fresh on every start and every resume: a socket cannot be reopened, and the page
   holds the accumulated turns in `finals`, so a new one picks up where the last left off. */
function startLiveStream(key) {
  liveStream = new LiveStream({
    apiKey: key,
    stream: recorder.stream,
    lang: $('lang').value,
    onPartial: txt => {
      noteSpeech();
      $('interim').textContent = txt;
      $('livebox').scrollTop = $('livebox').scrollHeight;
      /* The pause that precedes a turn is only known once the turn closes and the API
         reports its word timings, so a live line has no measurement of its own. Wall-clock
         timing cannot stand in: turns are delivered after end-of-speech is detected, so the
         interval between messages reflects network and processing latency — a couple of
         hundred milliseconds regardless of how long the speaker actually paused.

         So the live line simply continues the current paragraph, and is regrouped from the
         real audio timings the moment it completes. Continuing is the safer provisional
         choice: joining then splitting reads as the text settling, whereas starting a new
         paragraph that later merges would pull text upward under the reader's eye. */
      pip?.setCaptions(finals, txt, 0);
    },
    onFinal: (txt, gapMs) => {
      noteSpeech();
      const p = document.createElement('p');
      p.textContent = txt;
      $('livetext').append(p);
      $('interim').textContent = '';
      // Measured on the audio timeline by the API, so it reflects the speaker's actual
      // pause rather than how quickly the network delivered the message. The exception is
      // the first turn after a resume: that socket's timeline starts at zero and knows
      // nothing of the break, so the break is asserted here instead of measured.
      const gap = breakNext ? RESUME_GAP_MS : (gapMs || 0);
      breakNext = false;
      // The page keeps one paragraph per turn; only the floating window, which is short,
      // needs to economise on lines, so the gap travels with the text for it to use.
      finals.push({ text: txt, gap });
      if ($('clearlive')) $('clearlive').style.display = 'inline-flex';
      $('livebox').scrollTop = $('livebox').scrollHeight;
      pip?.setCaptions(finals, '');
    },
    // The same turn, re-sent with punctuation. Revise the line in place so the reader sees
    // it improve rather than seeing it repeated.
    onReplace: txt => {
      if (!finals.length) return;
      finals[finals.length - 1].text = txt;
      const last = $('livetext').lastElementChild;
      if (last) last.textContent = txt;
      pip?.setCaptions(finals, '');
    },
    onState: st => {
      // The socket also connects on resume, when the floating window is the thing the user
      // is actually looking at — so don't overwrite the note that says where to look.
      if (st === 'connected' && !pip?.open) {
        $('livenote').className = 'note'; $('livenote').textContent = t('live.recording');
      }
    },
    onError: msg => { $('livenote').className = 'note'; $('livenote').textContent = msg + ' ' + t('live.stillRecording'); },
  });
  liveStream.start().catch(() => {});
}

/* ---------------- floating window ----------------
   The PiP window is a *view* onto the recording, never the recording itself: the Recorder
   and the LiveStream are untouched by opening or closing it. That separation is what makes
   it safe for the window to be closed at any moment. */
async function openPip() {
  if (!pipSupported() || pip) return;
  const p = new PipWindow({
    onStop: () => finishRecording(),
    onPause: () => $('livepause').click(),   // one path through the toggle, whoever pressed it
    onClose: () => {
      pip = null;
      $('livenote').className = 'note';
      $('livenote').textContent = recorder?.paused ? t('live.paused') : t('live.recording');
      showPipButton();          // closing the view never stops the take
    },
  });
  try {
    await p.start({
      labels: {
        title:  t('live.pipTitle'),
        stop:   t('live.pipStop'),
        pause:  t('live.pipPause'),
        resume: t('live.pipResume'),
        empty:  t('live.empty'),
      },
    });
  } catch {
    /* Chrome requires a live user gesture, and awaiting the microphone permission prompt
       can outlive the one from the Start click — reliably so on a first run, where the
       user spends seconds on the permission dialog. Recording is already underway and
       must not be disturbed, so offer the window as an explicit second click instead. */
    showPipButton();
    return;
  }
  pip = p;
  pip.setTime(mmss(recorder ? recorder.elapsed : 0));
  pip.setCaptions(finals, $('interim').textContent);
  // The window can be opened mid-pause, so it adopts the current state rather than
  // assuming a session it has just joined is running.
  pip.setPaused(!!recorder?.paused);
  $('pipbtn')?.remove();
  $('livenote').className = 'note';
  $('livenote').textContent = t('live.pipOpen');
}

/* Shown when the window could not be opened automatically, or after the user closes it —
   in both cases a plain click carries the user activation the API insists on. */
function showPipButton() {
  if (!pipSupported() || !recorder?.active || $('pipbtn')) return;
  const b = document.createElement('button');
  b.className = 'bar'; b.id = 'pipbtn'; b.style.marginTop = '10px';
  b.textContent = t('live.pipOpenBtn');
  b.onclick = () => openPip();
  $('livenote').after(b);
}

/* ---------------- idle stop ----------------
   Restarted by every scrap of recognised speech, so the countdown measures silence rather
   than elapsed time. Speech is the right signal here: the input meter never reaches zero in
   a real room, so a level-based check would keep a session alive on air conditioning.

   A paused session is exempt. The countdown exists to stop a session that is quietly
   costing money, and a paused one is not — so silence during a deliberate hold should
   never end the take. (The socket can deliver a straggling turn just after a pause, which
   is why this is checked here and not only at the call sites.) */
function noteSpeech() {
  if (!recorder?.active || recorder.paused) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!recorder?.active || recorder.paused) return;
    // Say why before stopping — finishRecording immediately overwrites this with its own
    // progress messages, but the reason survives in the transcript that follows.
    $('livenote').className = 'note';
    $('livenote').textContent = t('live.idleStopped');
    finishRecording();
  }, IDLE_STOP_MS);
}

async function finishRecording() {
  clearTimeout(idleTimer);
  const key = keyInput.value.trim();
  $('livego').disabled = true;
  setRecordState('idle');   // clears the listening/paused styling and hides Pause
  $('meterwrap').classList.remove('show');
  $('interim').textContent = '';
  breakNext = false;
  if (liveStream) { liveStream.stop(); liveStream = null; }
  if (live) { live.stop(); live = null; }
  if (pip) { pip.close(); pip = null; }   // the transcript belongs in the page
  $('pipbtn')?.remove();

  const file = await recorder.stop();
  recorder = null;

  if (!file.size) {
    $('livenote').className = 'note err';
    $('livenote').textContent = t('live.nothing');
    $('livego').disabled = false;
    return;
  }

  const note = msg => { $('livenote').className = 'note'; $('livenote').textContent = msg; };
  try {
    note(t('live.transcribing'));
    picked = file;                       // so playback and exports use this audio
    const job = await transcribeFile(file, key, note);
    render(job);
    note(t('live.done'));
  } catch (e) {
    $('livenote').className = 'note err';
    $('livenote').textContent = (e.message || String(e)) + ' ' + t('live.keptAudio');
    offerDownload(file);
  } finally {
    $('livego').disabled = false;
  }
}

/* If transcription fails, the recording still exists — never make the user lose it. */
function offerDownload(file) {
  if ($('saverec')) $('saverec').remove();
  const b = document.createElement('button');
  b.className = 'bar'; b.id = 'saverec'; b.style.marginTop = '10px';
  b.textContent = t('live.download');
  b.onclick = () => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  $('pane-live').append(b);
}

/* ---------------- clear ----------------
   Wipes the current transcript and everything derived from it, returning the page to its
   initial state. Only in-memory state and the object URL are touched — saved API keys and
   the language choice are settings, not results, so they stay. */
function onClear() {
  const hasSomething = segments.length || $('livetext').textContent.trim();
  if (hasSomething && !confirm(t('toolbar.clearConfirm'))) return;
  clearTranscript();
}
$('clearall').onclick = onClear;
if ($('clearlive')) $('clearlive').onclick = onClear;

function clearTranscript() {
  segments = []; names = {}; rows = [];
  baseName = 'transcript';
  picked = null;
  stopAt = null; playingEl = null;

  list.textContent = '';
  $('stats').textContent = '';
  $('toolbar').classList.remove('show');
  $('search').value = '';
  $('searchnote').textContent = '';

  setSummary('', '');
  $('summarybox').classList.remove('show');

  // release the recording's object URL rather than leaking it
  if (audio.src) { try { URL.revokeObjectURL(audio.src); } catch { /* not an object URL */ } }
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  $('player').classList.remove('show');

  // reset both input modes
  $('fname').textContent = t('upload.none');
  fileInput.value = '';
  statusEl.className = '';
  statusEl.textContent = '';
  $('livetext').textContent = '';
  $('interim').textContent = '';
  $('livenote').className = 'note';
  $('livenote').textContent = '';
  $('rectime').textContent = '00:00';
  if ($('clearlive')) $('clearlive').style.display = 'none';
  $('saverec')?.remove();

  $('hint').textContent = t('hint.default');
  refresh();
}

/* ---------------- render ---------------- */
function speakerClass(s) {
  const c = String(s).toUpperCase().charCodeAt(0);
  return 'spk-' + (c >= 65 && c <= 70 ? String(s).toUpperCase() : 'A');
}
const nameOf = spk => names[spk] || t('speaker.prefix') + ' ' + spk;

function render(result) {
  const utterances = result.utterances || [];
  if (!utterances.length) { say(t('upload.nospeech'), true); return; }

  segments = splitIntoSegments(utterances);
  names = {};
  baseName = picked.name.replace(/\.[^.]+$/, '');

  audio.src = URL.createObjectURL(picked);
  $('player').classList.add('show');
  $('toolbar').classList.add('show');
  $('hint').textContent = t('hint.ready');
  statusEl.className = '';
  $('setup').classList.add('collapsed');
  syncSettingsToggle();

  drawRows();
  drawStats();
  list.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawRows() {
  list.textContent = '';
  rows = [];
  for (const seg of segments) {
    const row = document.createElement('div');
    row.className = 'row';

    const btn = document.createElement('button');
    btn.className = 'btn ' + speakerClass(seg.speaker);
    // live sessions have no audio to seek, so the play affordance is dropped there
    const playable = !!audio.getAttribute('src');
    if (playable) btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    const nm = document.createElement('span');
    nm.textContent = nameOf(seg.speaker);
    btn.append(nm);
    if (playable) {
      btn.title = 'Play ' + fmtTime(seg.start) + ' — ' + nameOf(seg.speaker);
      btn.onclick = () => play(seg.start / 1000, seg.end / 1000, row);
    } else {
      btn.style.cursor = 'default';
      btn.title = nameOf(seg.speaker);
    }

    const rename = document.createElement('button');
    rename.className = 'rename';
    rename.textContent = '✎';
    rename.title = 'Rename ' + nameOf(seg.speaker);
    rename.onclick = e => { e.stopPropagation(); renameSpeaker(seg.speaker); };

    const body = document.createElement('div');
    body.className = 'body';
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = seg.text;
    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = fmtTime(seg.start);
    body.append(text, time);

    const left = document.createElement('div');
    left.className = 'left';
    left.append(btn, rename);
    row.append(left, body);
    list.append(row);
    rows.push({ el: row, seg, textEl: text });
  }
}

function renameSpeaker(spk) {
  const next = prompt(t('speaker.renamePrompt') + ' ' + nameOf(spk) + ':', names[spk] || '');
  if (next === null) return;
  const v = next.trim();
  if (v) names[spk] = v; else delete names[spk];
  drawRows();
  drawStats();
  applySearch();
}

/* Speaker names with the localized fallback applied, for anything outside app.js —
   transcript.js and llm.js would otherwise fall back to the English "Speaker A". */
function resolvedNames() {
  const out = {};
  for (const s of segments) out[s.speaker] = nameOf(s.speaker);
  return out;
}

function drawStats() {
  const stats = talkTime(segments, resolvedNames());
  const el = $('stats');
  el.textContent = '';
  for (const s of stats) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const dot = document.createElement('i');
    dot.className = 'dot ' + speakerClass(s.speaker);
    chip.append(dot, document.createTextNode(`${s.name} · ${s.pct}% · ${fmtTime(s.ms)}`));
    el.append(chip);
  }
}

/* ---------------- search ---------------- */
const search = $('search');
search.oninput = applySearch;
$('clearsearch').onclick = () => { search.value = ''; applySearch(); };

function applySearch() {
  const q = search.value.trim().toLowerCase();
  let hits = 0;
  for (const { el, seg, textEl } of rows) {
    if (!q) {
      el.style.display = '';
      textEl.textContent = seg.text;
      continue;
    }
    const idx = seg.text.toLowerCase().indexOf(q);
    if (idx === -1) { el.style.display = 'none'; continue; }
    el.style.display = '';
    hits++;
    // rebuild with <mark> around every match, without using innerHTML on user text
    textEl.textContent = '';
    const lower = seg.text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(q, from);
      if (at === -1) { textEl.append(seg.text.slice(from)); break; }
      textEl.append(seg.text.slice(from, at));
      const m = document.createElement('mark');
      m.textContent = seg.text.slice(at, at + q.length);
      textEl.append(m);
      from = at + q.length;
    }
  }
  $('searchnote').textContent = q
    ? (hits ? hits + ' ' + t(hits === 1 ? 'toolbar.match' : 'toolbar.matches') : t('toolbar.nomatch'))
    : '';
}

/* ---------------- playback ---------------- */
function play(start, end, el) {
  if (playingEl) playingEl.classList.remove('playing');
  el.classList.add('playing');
  playingEl = el; stopAt = end;
  audio.currentTime = start;
  audio.play();
}
audio.addEventListener('timeupdate', () => {
  if (stopAt !== null && audio.currentTime >= stopAt) {
    audio.pause(); stopAt = null;
    if (playingEl) { playingEl.classList.remove('playing'); playingEl = null; }
  }
});
audio.addEventListener('pause', () => { stopAt = null; });

/* ---------------- exports ---------------- */
function download(text, filename, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

$('export').onchange = e => {
  const fmt = e.target.value;
  e.target.selectedIndex = 0;
  if (!fmt || !segments.length) return;
  const meta = { title: baseName, generated: new Date().toISOString() };
  if (fmt === 'txt')  download(buildTxt(segments, resolvedNames()), baseName + ' - transcript.txt');
  if (fmt === 'md')   download(buildMarkdown(segments, resolvedNames(), baseName), baseName + ' - transcript.md', 'text/markdown');
  if (fmt === 'srt')  download(buildSrt(segments, resolvedNames()), baseName + '.srt', 'application/x-subrip');
  if (fmt === 'vtt')  download(buildVtt(segments, resolvedNames()), baseName + '.vtt', 'text/vtt');
  if (fmt === 'json') download(buildJson(segments, resolvedNames(), meta), baseName + '.json', 'application/json');
  if (fmt === 'summary') {
    const s = $('summary').dataset.md;
    if (s) download(s, baseName + ' - summary.md', 'text/markdown');
  }
};

/* ---------------- summary ---------------- */
let abortSummary = null;

$('summarize').onclick = async () => {
  if (!segments.length) return;
  const p = provSel.value;
  const apiKey = (localStorage.getItem('llm_key_' + p) || llmKey.value).trim();
  if (!apiKey) {
    $('setup').classList.remove('collapsed');
    setSummary('', t('summary.needkey') + ' ' + PROVIDERS[p].label + ' ' + t('summary.needkey2'), true);
    return;
  }
  const transcript = buildPrompt(segments, resolvedNames());
  const box = $('summarybox');
  box.classList.add('show');
  setSummary('', t('summary.working') + ' ' + PROVIDERS[p].label + ' · ' + modelSel.value
    + ' (~' + estimateTokens(transcript).toLocaleString() + ' ' + t('summary.tokens') + ')…');

  abortSummary = new AbortController();
  try {
    const md = await summarize({
      provider: p,
      apiKey,
      model: modelSel.value,
      baseUrl: baseInput.value.trim(),
      transcript,
      signal: abortSummary.signal,
    });
    setSummary(md, '');
  } catch (e) {
    if (e.name === 'AbortError') setSummary('', t('summary.cancelled'));
    else setSummary('', e.message || String(e), true);
  } finally {
    abortSummary = null;
  }
};

function setSummary(md, note, isErr) {
  const out = $('summary');
  out.dataset.md = md || '';
  out.textContent = '';
  if (md) out.append(renderMarkdown(md));
  const n = $('summarynote');
  n.textContent = note || '';
  n.className = 'note' + (isErr ? ' err' : '');
  $('copysummary').style.display = md ? 'inline-flex' : 'none';
}

$('copysummary').onclick = async () => {
  const md = $('summary').dataset.md;
  if (!md) return;
  await navigator.clipboard.writeText(md);
  $('summarynote').textContent = t('summary.copied');
};

/* Small Markdown renderer — headings, bullets, checkboxes, bold, inline code.
   Built with DOM nodes rather than innerHTML so model output can't inject markup. */
function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  let ul = null;
  const inline = (parent, s) => {
    // **bold** and `code`
    const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) parent.append(s.slice(last, m.index));
      if (m[2] !== undefined) { const b = document.createElement('strong'); b.textContent = m[2]; parent.append(b); }
      else { const c = document.createElement('code'); c.textContent = m[3]; parent.append(c); }
      last = m.index + m[0].length;
    }
    if (last < s.length) parent.append(s.slice(last));
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!ul) { ul = document.createElement('ul'); frag.append(ul); }
      const li = document.createElement('li');
      let body = bullet[1];
      const task = body.match(/^\[([ xX])\]\s*(.*)$/);
      if (task) {
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.disabled = true; cb.checked = task[1].toLowerCase() === 'x';
        li.append(cb, ' ');
        body = task[2];
      }
      inline(li, body);
      ul.append(li);
      continue;
    }
    ul = null;
    if (!line.trim()) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const el = document.createElement('h' + Math.min(6, h[1].length + 2));
      el.textContent = h[2];
      frag.append(el);
    } else {
      const p = document.createElement('p');
      inline(p, line);
      frag.append(p);
    }
  }
  return frag;
}
