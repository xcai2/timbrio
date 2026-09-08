/* A floating always-on-top window for the recording session.

   Why this exists: while recording a call you are looking at Zoom, or a doc, or an IDE —
   not at this page. A normal in-page overlay disappears the moment you switch apps, which
   is exactly when you need to see that recording is still running.

   Document Picture-in-Picture opens a real OS window that floats above other applications,
   and unlike video PiP it holds arbitrary DOM — so the timer, the level meter and the live
   captions all move into it and keep updating.

   Two limits are worth knowing, because they shaped this file:

   1. The window cannot be made transparent. A browser-owned window has its own chrome and
      an opaque backing; `opacity` on the body only fades content against that backing.
      Unobtrusiveness therefore comes from being small, not from being faint. The palette
      is tuned for an hour of reading rather than for a glance — see the dark-mode block
      below for why it stops short of maximum contrast.

   2. Only Chrome and Edge implement it. Everywhere else `supported()` is false and the
      caller simply keeps the captions in the page, which still works.

   Stylesheets are not inherited by the PiP document, so the styles below are inlined here
   rather than shared with styles.css — this window is small and self-contained, and copying
   a handful of rules costs less than making the main stylesheet serve two very different
   layouts. */

const WIDTH = 420, HEIGHT = 300;

/* Silence long enough to read as a handover rather than a breath. Conversational turn-taking
   gaps cluster around 200ms, while a speaker pausing mid-thought rarely runs this long, so
   700ms separates the two cases far more often than not — and an occasional wrong guess only
   costs a paragraph break. */
const HANDOVER_MS = 700;

/* Ceilings that end a paragraph on their own, so the window never fills with one
   undifferentiated block when the timings give no handover to detect. Turns vary wildly in
   length — "Sure." and a forty-word answer are both one turn — so a character budget backs
   up the turn count, and whichever is reached first wins. */
const MAX_TURNS_PER_PARA = 3;
const MAX_CHARS_PER_PARA = 240;

export function supported() {
  return 'documentPictureInPicture' in window;
}

const CSS = `
  :root {
    color-scheme: light dark;
    /* Captions carry the whole point of this window, so they get the strongest contrast in
       the palette. The in-progress line is distinguished by *italics*, not by dimming —
       dimming the newest text is exactly backwards when it is the line being read. */
    --bg: #ffffff;
    --fg: #111014;          /* finished captions — the primary content */
    --fg-interim: #4a4458;  /* in-progress — softer, still comfortably readable */
    --chrome: #f3f0fb;
    --line: #e0dbee;
    --empty: #8b849c;
    --rec: #dc2626;         /* the recording dot */
    --meter: #7c3aed;       /* input level */
    --live: #0d7a6f;        /* the line currently being spoken */
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Microsoft YaHei", sans-serif;
    color: var(--fg); background: var(--bg);
    display: flex; flex-direction: column; height: 100vh;
    font-size: 14px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      /* Tuned for long sessions rather than for a glance. Pure white on pure black reaches
         about 18:1, which is past the point of diminishing returns: the eye keeps
         readjusting to the extremes and bright glyphs bloom against the dark ground. Backing
         both ends off to roughly 11:1 stays far above the 4.5:1 accessibility floor while
         removing that strain, and the ground is warmed slightly — a warm grey emits less
         blue than a neutral one, which matters most at night, when this window is likely to
         be open for an hour at a time. */
      --bg: #22201d;          /* warm grey, not black */
      --fg: #ddd6ca;          /* soft cream, not white */
      --fg-interim: #9a9287;
      --chrome: #2b2825;
      --line: #3a3630;
      --empty: #7d766c;
      /* Desaturated to sit on the warm ground: a fully saturated red or violet against a
         muted background is the one thing that would reintroduce glare. */
      --rec: #e06c5f;
      --meter: #b39ddb;
      /* A soft teal: far enough from the cream body text to be spotted instantly, muted
         enough not to reintroduce the glare the warm palette exists to avoid. */
      --live: #7fc8b8;
    }
    .stop:hover, .pause:hover { background: #34302b; }
  }
  .head {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-bottom: 1px solid var(--line);
    background: var(--chrome);
    flex: 0 0 auto;
  }
  .dot {
    width: 9px; height: 9px; border-radius: 50%; background: var(--rec);
    flex: 0 0 auto; animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
  /* Paused: the dot stops pulsing and drains of colour, and the timer dims with it. A
     still grey dot cannot be mistaken for the live one at a glance across the room —
     which matters, because the whole cost of a mistake here is a lost recording. */
  body.paused .dot { animation: none; background: var(--empty); }
  body.paused #time { color: var(--empty); }
  #time {
    font-variant-numeric: tabular-nums; font-weight: 700; font-size: 16px;
    letter-spacing: .01em;
  }
  .spacer { flex: 1 }
  .stop, .pause {
    font: inherit; font-weight: 600; cursor: pointer;
    padding: 5px 12px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  .stop:hover, .pause:hover { background: var(--chrome); }
  /* The window is only 420px wide and Stop carries a full sentence, so Pause gives up its
     padding first rather than pushing Stop off the edge. */
  .pause { padding: 5px 9px; }
  #meterwrap { height: 3px; background: var(--line); flex: 0 0 auto; }
  #meter {
    height: 100%; width: 0%; background: var(--meter);
    transition: width .1s linear;
  }
  #box {
    flex: 1; overflow-y: auto; padding: 12px;
    line-height: 1.6; color: var(--fg);
  }
  /* Finished captions are the primary content and stay at the palette's full contrast — a
     line does not become less worth reading once it is complete. Text fills the width and
     wraps naturally; the blank line between paragraphs marks a likely change of speaker. */
  #box .turn { color: var(--fg); margin: 0 0 11px; }
  #box .turn:last-of-type { margin-bottom: 0; }
  #box:empty::before, #box.blank::before {
    content: attr(data-empty); color: var(--empty);
  }
  /* The line still being spoken gets its own colour rather than a dimmer version of the
     finished one. Dimming says "less important"; a distinct hue says "different state",
     which is what this actually is — and it makes the live line findable at a glance in a
     window the reader is only glancing at. It settles into the normal colour on completion. */
  #interim { color: var(--live); font-style: italic; }
`;

export class PipWindow {
  /* onStop() — the user pressed Stop inside the floating window.
     onPause() — the user pressed Pause/Resume there. The caller owns the paused state and
                 reports it back via setPaused; this window never assumes the toggle worked.
     onClose() — the window was closed by the user (the OS close button), rather than by us.
                 Recording is deliberately left running: closing a view should never destroy
                 the take. The caller moves the captions back into the page. */
  constructor({ onStop, onPause, onClose } = {}) {
    this.onStop = onStop; this.onPause = onPause; this.onClose = onClose;
    this.win = null;
    this.closingSelf = false;
    this.labels = null;
  }

  get open() { return !!(this.win && !this.win.closed); }

  /* Must be called during a user gesture, or the browser refuses the window.
     `labels` carries the already-translated strings, so this module stays free of i18n. */
  async start({ labels }) {
    /* `disallowReturnToOpener` is deliberately left off. It hides the browser's own
       "back to tab" button, which an earlier version set on the reasoning that this is a
       HUD rather than a document — but a HUD that floats above every other window and
       covers the tab strip is precisely the one that needs a way back. Without that
       button the window offers no route to the page it came from at all. */
    const win = await documentPictureInPicture.requestWindow({
      width: WIDTH, height: HEIGHT,
    });
    this.win = win;
    this.labels = labels;

    const style = win.document.createElement('style');
    style.textContent = CSS;
    win.document.head.append(style);
    win.document.title = labels.title;

    win.document.body.innerHTML = `
      <div class="head">
        <span class="dot"></span>
        <span id="time">00:00</span>
        <span class="spacer"></span>
        <button class="pause" id="pause"></button>
        <button class="stop" id="stop"></button>
      </div>
      <div id="meterwrap"><div id="meter"></div></div>
      <div id="box" class="blank"></div>
    `;

    const $ = id => win.document.getElementById(id);
    this.el = { time: $('time'), meter: $('meter'), box: $('box'),
                stop: $('stop'), pause: $('pause') };
    this.el.stop.textContent = labels.stop;
    this.el.pause.textContent = labels.pause;
    this.el.box.dataset.empty = labels.empty;

    this.el.stop.onclick = () => this.onStop?.();
    this.el.pause.onclick = () => this.onPause?.();

    // Fires for both an OS close and our own close(); the flag tells them apart.
    win.addEventListener('pagehide', () => {
      this.win = null;
      if (!this.closingSelf) this.onClose?.();
    });

    return win;
  }

  setTime(text) { if (this.open) this.el.time.textContent = text; }
  setLevel(v)   { if (this.open) this.el.meter.style.width = Math.round(v * 100) + '%'; }

  /* The level meter keeps moving while paused — on purpose. It is the cue that someone has
     started talking again, which is exactly the moment the user needs to hit Resume. */
  setPaused(on) {
    if (!this.open) return;
    this.win.document.body.classList.toggle('paused', !!on);
    this.el.pause.textContent = on ? this.labels.resume : this.labels.pause;
  }

  /* The caption view is rebuilt from the page's own state rather than kept in sync
     incrementally, so the two views can never drift apart.

     Turns flow together into paragraphs rather than taking a line each: the API ends a turn
     at every pause, so one turn is often a three-word sentence, and a line per turn would
     spend a whole row on "Images." in a window only a few lines tall.

     Running everything into one block is the opposite mistake — a two-person conversation
     becomes an unbroken wall. Since the live API reports turns but never identities, the
     silence before a turn is the only speaker cue available: a pause past HANDOVER_MS is
     usually someone else taking over, anything shorter is the same person breathing. The
     split is therefore a good guess, not a fact, which is why it only groups paragraphs and
     never claims to name a speaker. The final transcript, which does have diarisation,
     replaces all of this once recording stops.

     One rule governs both states. The live line is laid out by exactly the same grouping as
     the finished ones, using the gap recorded when the previous turn closed — if it were
     always given its own paragraph, as an earlier version did, it would visibly jump up and
     rejoin the block above the instant it completed and the real rule took over. Text that
     has already been read must not move. */
  setCaptions(finals, interim, interimGap = 0) {
    if (!this.open) return;
    const { box } = this.el;
    const d = this.win.document;
    box.textContent = '';

    let para = null, held = 0, chars = 0;
    const place = (text, gap, isLive) => {
      /* Two independent reasons to start a paragraph. The gap is the meaningful one — it
         guesses a change of speaker — but it depends on timings that are not always
         informative, and when it never fires the window fills with one unbroken block.
         So length breaks too: a paragraph that has taken on enough turns, or enough
         characters, ends regardless. That keeps a steady reading rhythm no matter how the
         timings behave, which matters more here than grouping being semantically perfect. */
      const speakerChange = gap >= HANDOVER_MS;
      const tooLong = held >= MAX_TURNS_PER_PARA || chars >= MAX_CHARS_PER_PARA;
      if (!para || speakerChange || tooLong) {
        para = d.createElement('p');
        para.className = 'turn';
        box.append(para);
        held = 0; chars = 0;
      } else {
        para.append(d.createTextNode(' '));
      }
      held += 1; chars += text.length;
      if (isLive) {
        // A span inside the paragraph, so the live text can be tinted while sitting in the
        // same block it will belong to once finished — nothing shifts on completion.
        const s = d.createElement('span');
        s.id = 'interim';
        s.textContent = text;
        para.append(s);
      } else {
        para.append(d.createTextNode(text));
      }
    };

    for (const item of finals) {
      // Tolerate plain strings so a caller that has no timing still renders.
      const text = typeof item === 'string' ? item : item.text;
      const gap  = typeof item === 'string' ? 0 : (item.gap || 0);
      place(text, gap, false);
    }
    if (interim) place(interim, interimGap, true);

    box.classList.toggle('blank', !finals.length && !interim);
    box.scrollTop = box.scrollHeight;
  }

  close() {
    if (!this.open) return;
    this.closingSelf = true;
    try { this.win.close(); } catch { /* already gone */ }
    this.win = null;
  }
}
