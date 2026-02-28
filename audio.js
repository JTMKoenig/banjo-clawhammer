/* ================================================================
   BANJO AUDIO ENGINE  –  Web Audio API / Karplus-Strong
   ================================================================
   Open-G tuning: g D G B d  (strings 5-1)
   Fret 0 on each string = the open-string pitch.

   We map each (string, fret) pair → a MIDI note number, then
   convert that to a frequency for Karplus-Strong synthesis.
   ================================================================ */

/* ── Open-string MIDI notes (Open G) ───────────────────────────
   String index in our data arrays: 0=d 1=B 2=G 3=D 4=g(5th)
   MIDI: D4=62, G4=67, B4=71, d5=74, g5=79               */
const OPEN_MIDI = [74, 71, 67, 62, 79];  // d, B, G, D, g

function midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
}

/* ── Karplus-Strong plucked string ─────────────────────────────
   Creates a convincing plucked-string tone entirely in the browser.
   @param ctx    – AudioContext
   @param freq   – desired frequency (Hz)
   @param gain   – volume 0-1
   @param when   – AudioContext time to start
   @param decay  – string decay coefficient (0.99 = long sustain)   */
function pluckString(ctx, freq, gain, when, decay = 0.994) {
    const sampleRate = ctx.sampleRate;
    const bufLen = Math.round(sampleRate / freq);
    const dur = 3.0; // seconds we'll render noise for
    const totalSamples = Math.ceil(sampleRate * dur) + bufLen * 2;

    // Seed the delay line with band-limited white noise
    const seed = new Float32Array(bufLen);
    for (let i = 0; i < bufLen; i++) seed[i] = Math.random() * 2 - 1;

    // Build output buffer via Karplus-Strong feedback loop
    const out = new Float32Array(totalSamples);
    const delay = new Float32Array(bufLen);
    delay.set(seed);

    let ptr = 0;
    for (let n = 0; n < totalSamples; n++) {
        const next = (ptr + 1) % bufLen;
        out[n] = delay[ptr];
        delay[ptr] = decay * 0.5 * (delay[ptr] + delay[next]);
        ptr = next;
    }

    // Bake into an AudioBuffer and schedule
    const audioBuffer = ctx.createBuffer(1, totalSamples, sampleRate);
    audioBuffer.copyToChannel(out, 0);

    const src = ctx.createBufferSource();
    const vol = ctx.createGain();
    src.buffer = audioBuffer;
    vol.gain.setValueAtTime(gain, when);

    src.connect(vol);
    vol.connect(ctx.destination);
    src.start(when);
    return src;
}

/* ================================================================
   SEQUENCER
   ================================================================
   Converts the raw measure data produced by generateMeasure() into
   a timed sequence of pluck events and plays them via the engine.

   Tab layout reminder:
     allMeasures[measureIdx] = 5×16 array (strings × positions)
     Each cell: '-' = silent | '0'..'9' = fret | 'h2' = hammer-on (treated as fret 2)

   Timing: 16 positions per measure @ bpm.  Position 0 tracks 8th-note
   subdivisions; each position is one 16th-note.
   ================================================================ */

let audioCtx = null;
let activeSrcs = [];
let isPlaying = false;
let stopFlag = false;

function getAudioCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
}

/**
 * Play the song represented by allMeasures.
 * @param {Array}    allMeasures  – result of mapping generateMeasure() over all chords
 * @param {number}   bpm          – tempo (default 90)
 * @param {Function} onStop       – called when playback ends naturally or is stopped
 */
function playSong(allMeasures, bpm = 90, onStop) {
    if (isPlaying) stopSong();

    const ctx = getAudioCtx();
    const sixteenth = 60 / bpm / 4;  // duration of one 16th-note in seconds
    const startTime = ctx.currentTime + 0.05;

    isPlaying = true;
    stopFlag = false;
    activeSrcs = [];

    for (let m = 0; m < allMeasures.length; m++) {
        if (stopFlag) break;
        const measure = allMeasures[m];       // 5 × 16 array
        const measureStart = startTime + m * 16 * sixteenth;

        for (let pos = 0; pos < 16; pos++) {
            for (let str = 0; str < 5; str++) {
                const cell = measure[str][pos];
                if (cell === '-') continue;

                // Resolve fret number
                let fret;
                if (cell === 'h2') {
                    fret = 2;               // hammer-on → fret 2
                } else {
                    fret = parseInt(cell, 10);
                    if (isNaN(fret)) continue;
                }

                const midiNote = OPEN_MIDI[str] + fret;
                const freq = midiToFreq(midiNote);

                // The 5th string (g drone) gets slightly lower volume/longer decay
                const isDrone = str === 4;
                const gain = isDrone ? 0.55 : 0.70;
                const decay = isDrone ? 0.991 : 0.994;

                const when = measureStart + pos * sixteenth;
                const src = pluckString(ctx, freq, gain, when, decay);
                activeSrcs.push(src);
            }
        }
    }

    // Figure out when the song ends and schedule the stop callback
    const totalDuration = allMeasures.length * 16 * sixteenth + 3.5; // +tail
    const endTime = startTime + totalDuration;
    const msUntilEnd = (endTime - ctx.currentTime) * 1000;

    const timer = setTimeout(() => {
        isPlaying = false;
        activeSrcs = [];
        if (onStop) onStop();
    }, msUntilEnd);

    // Store timer so stopSong() can cancel it
    activeSrcs._timer = timer;
}

function stopSong() {
    stopFlag = true;
    clearTimeout(activeSrcs._timer);
    activeSrcs.forEach(src => {
        try { src.stop(); } catch (_) { }
    });
    activeSrcs = [];
    isPlaying = false;
}
