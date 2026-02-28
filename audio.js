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
    vol.connect(banjoMasterGain);
    src.start(when);
    return { type: 'banjo', src: src };
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
let banjoMasterGain = null;
let metroMasterGain = null;
let activeSrcs = []; // No longer strictly needed for stop as we use nodes
let isPlaying = false;
let currentBpm = 90;
let currentMeasures = [];
let currentPlayOpts = {};
let masterOnStop = null;

// Sequencer state
let nextNoteTime = 0.0;
let currentMeasure = 0;
let currentPos = 0; // 0-15 (sixteenth notes)
let timerID = null;

// How far ahead to schedule audio (secs)
const SCHEDULE_AHEAD_TIME = 0.1;
// How often the timer wakes up to schedule (secs)
const LOOKAHEAD = 25.0;

function updateAudioSettings(bVol, mVol, mPitch, mEnabled, mAccent) {
    // bVol and mVol are UI 0-1 values where 0.5 is the old default (0.65 and 1.0)
    const engineBanjoVol = (bVol / 0.5) * 0.65;
    const engineMetroVol = (mVol / 0.5) * 1.0;

    if (banjoMasterGain) banjoMasterGain.gain.setTargetAtTime(engineBanjoVol, getAudioCtx().currentTime, 0.02);

    // If metronome is disabled, force its master gain to 0
    const actualMetroVol = mEnabled ? engineMetroVol : 0;
    if (metroMasterGain) metroMasterGain.gain.setTargetAtTime(actualMetroVol, getAudioCtx().currentTime, 0.02);
}

/* ── Metronome click ─────────────────────────────────────────────
   Woodblock-style noise burst: band-passed white noise.
   Cuts through tonal banjo content clearly.
   @param ctx      – AudioContext
   @param when     – schedule time
   @param isAccent – true = downbeat (louder, lower resonance)    */
function metronomeClick(ctx, when, isAccent, pitch = 1.0) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    // Base frequencies that are lower, since user liked pitch=0.5
    const freq = (isAccent ? 500 : 800) * pitch;

    osc.type = 'sine';
    // Small pitch drop creates a nice "tick" transient
    osc.frequency.setValueAtTime(freq * 1.5, when);
    osc.frequency.exponentialRampToValueAtTime(freq, when + 0.02);

    // Amplitude envelope
    const peakGain = isAccent ? 0.8 : 0.5;
    env.gain.setValueAtTime(0.001, when);
    env.gain.exponentialRampToValueAtTime(peakGain, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.08);

    osc.connect(env);
    env.connect(metroMasterGain);

    osc.start(when);
    osc.stop(when + 0.1);

    // No longer returning osc for activeSrcs tracking, as pitch is set at schedule time
}

function getAudioCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        banjoMasterGain = audioCtx.createGain();
        metroMasterGain = audioCtx.createGain();
        banjoMasterGain.connect(audioCtx.destination);
        metroMasterGain.connect(audioCtx.destination);
    }
    return audioCtx;
}

/**
 * Play the song represented by allMeasures.
 * @param {Array}    allMeasures  – result of mapping generateMeasure() over all chords
 * @param {number}   bpm          – tempo (default 90)
 * @param {Function} onStop       – called when playback ends naturally or is stopped
 */
/**
 * @param {Object}   metronomeOpts
 * @param {boolean}  metronomeOpts.enabled      – play clicks at all
 * @param {boolean}  metronomeOpts.accentDownbeat – accent beat 1 of each measure
 */
function nextNote() {
    // Advance time by a 16th note
    const secondsPerBeat = 60.0 / currentBpm;
    nextNoteTime += 0.25 * secondsPerBeat; // 16th note

    // Advance position
    currentPos++;
    if (currentPos === 16) {
        currentPos = 0;
        currentMeasure++;
    }
}

function scheduleNote(measureIdx, pos, time) {
    const ctx = getAudioCtx();
    const playOpts = currentPlayOpts;
    const clickEnabled = playOpts.enabled === true;
    const accentDownbeat = playOpts.accentDownbeat !== false;
    const metroPitch = playOpts.metroPitch !== undefined ? playOpts.metroPitch : 1.0;

    // Metronome (on quarter beats: pos 0, 4, 8, 12)
    if (pos % 4 === 0 && clickEnabled) {
        const beat = pos / 4;
        const isAccent = accentDownbeat && beat === 0;
        metronomeClick(ctx, time, isAccent, metroPitch);
    }

    if (measureIdx >= currentMeasures.length) return;
    const measure = currentMeasures[measureIdx];

    for (let str = 0; str < 5; str++) {
        const cell = measure[str][pos];
        if (cell === '-') continue;

        let fret;
        if (cell === 'h2') {
            fret = 2;
        } else {
            fret = parseInt(cell, 10);
            if (isNaN(fret)) continue;
        }

        const midiNote = OPEN_MIDI[str] + fret;
        const freq = midiToFreq(midiNote);

        const isDrone = str === 4;
        const gain = isDrone ? 0.35 : 0.45;
        const decay = isDrone ? 0.991 : 0.994;

        pluckString(ctx, freq, gain, time, decay);
    }
}

function scheduler() {
    // While there are notes that will need to play before the next interval,
    // schedule them and advance the pointer.
    while (nextNoteTime < getAudioCtx().currentTime + SCHEDULE_AHEAD_TIME) {
        if (currentMeasure >= currentMeasures.length) {
            // Song finished scheduling
            // Need to set a fallback timer to call the stop callback since AudioBuffers don't have "ended"
            // Wait for the final note tail to finish before firing callback
            const remainingTime = (nextNoteTime - getAudioCtx().currentTime) * 1000 + 3500;
            setTimeout(() => {
                if (isPlaying) {
                    isPlaying = false;
                    if (masterOnStop) masterOnStop();
                }
            }, remainingTime);
            return; // stop scheduling
        }

        scheduleNote(currentMeasure, currentPos, nextNoteTime);
        nextNote();
    }
    timerID = setTimeout(scheduler, LOOKAHEAD);
}

function playSong(allMeasures, bpm = 90, onStop, playOpts = {}) {
    if (isPlaying) stopSong();

    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();

    isPlaying = true;
    currentBpm = bpm;
    currentMeasures = allMeasures;
    currentPlayOpts = playOpts;
    masterOnStop = onStop;

    currentMeasure = 0;
    currentPos = 0;

    // Start slightly in the future
    nextNoteTime = ctx.currentTime + 0.1;

    // Apply init levels to master nodes
    updateAudioSettings(playOpts.banjoVolume !== undefined ? playOpts.banjoVolume : 0.5,
        playOpts.metroVolume !== undefined ? playOpts.metroVolume : 0.5,
        playOpts.metroPitch !== undefined ? playOpts.metroPitch : 1.0,
        playOpts.enabled === true,
        playOpts.accentDownbeat !== false);

    scheduler();
}

function stopSong() {
    isPlaying = false;
    clearTimeout(timerID);

    // We cannot easily 'stop' AudioBufferSourceNodes that are already scheduled and connected
    // unless we kept track of every single node and ran `.stop()`.
    // But since we are using master gains, we can just suspend the context, or close it,
    // or just let the queued lookahead notes drop out (it's only 0.1s max).
    // For instant stop, closing the context is easiest, and we spin up a new one next time.
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
        banjoMasterGain = null;
        metroMasterGain = null;
    }
}
