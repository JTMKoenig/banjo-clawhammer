/* ================================================================
   DATA
   ================================================================ */

// Chord frets: [d(1st), B(2nd), G(3rd), D(4th), g(5th)]
// -1 = muted/not played
const CHORD_LIB = {
    'G': { frets: [0, 0, 0, 0, 0], label: 'G Major' },
    'C': { frets: [2, 1, 0, 2, 0], label: 'C Major' },
    'D': { frets: [4, 3, 2, 0, 0], label: 'D Major' },
    'D7': { frets: [1, 2, 0, 0, 0], label: 'D7' },
    'Em': { frets: [0, 0, 0, 2, 0], label: 'E Minor' },
    'Am': { frets: [0, 1, 2, 2, 0], label: 'A Minor' },
};

// Each progression has 4 chords; we'll repeat the progression 2× = 8 measures
const PROGRESSIONS = {
    G: {
        easy: [
            { title: 'Mountain Spring', chords: ['G', 'C', 'G', 'D'] },
            { title: 'Creek Walk', chords: ['G', 'G', 'C', 'G'] },
            { title: 'Open Road', chords: ['G', 'D', 'G', 'D'] },
        ],
        medium: [
            { title: 'Blue Ridge', chords: ['G', 'Em', 'C', 'D'] },
            { title: 'Hollow Wind', chords: ['G', 'C', 'Am', 'D7'] },
            { title: 'River Bend', chords: ['G', 'Am', 'D7', 'G'] },
        ],
    },
    C: {
        easy: [
            { title: 'Sunday Porch', chords: ['C', 'G', 'C', 'G'] },
            { title: 'Easy Morning', chords: ['C', 'C', 'G', 'C'] },
            { title: 'Gentle Path', chords: ['C', 'G', 'D7', 'C'] },
        ],
        medium: [
            { title: 'Old Farmhouse', chords: ['C', 'Am', 'G', 'D7'] },
            { title: 'Evening Shade', chords: ['C', 'G', 'Am', 'Em'] },
            { title: 'Valley Song', chords: ['C', 'Am', 'D7', 'G'] },
        ],
    },
    D: {
        easy: [
            { title: 'Dusty Trail', chords: ['D', 'G', 'D', 'G'] },
            { title: 'High Country', chords: ['D', 'D', 'G', 'D'] },
            { title: 'Ridge Path', chords: ['D', 'G', 'C', 'G'] },
        ],
        medium: [
            { title: 'Pine Ridge', chords: ['D', 'Em', 'G', 'D7'] },
            { title: 'Blue Mountain', chords: ['D', 'G', 'Em', 'D'] },
            { title: 'Forest Song', chords: ['D', 'G', 'C', 'D7'] },
        ],
    },
};

/* ================================================================
   STATE
   ================================================================ */
let currentKey = 'G';
let currentDiff = 'easy';
let selectedChordIdx = 0;
let currentProgression = null;
let lastAllMeasures = null;  // stored for audio playback
let currentTempo = 100;      // BPM (80–140)
let uiTabPositions = [];     // stored physical character positions for visual beat cursor
// UI Slider values are 0-1, 0.5 is default. We scale these up for audio engine later.
let currentBanjoVol = 0.5;
let currentMetroVol = 0.5;
let currentMetroPitch = 0.6;
let metroEnabled = false;    // metronome clicks on/off
let metroAccent = true;      // accent downbeat

/* ================================================================
   TAB GENERATION
   ================================================================ */

/**
 * Generate a single 16-position measure for a chord.
 * Returns: array of 5 arrays (rows = strings d, B, G, D, g), each length 16.
 * Values: '-' for rest, number string for fret, 'h2' for hammer-on.
 */
function generateMeasure(chordName, difficulty, variation) {
    const { frets } = CHORD_LIB[chordName];
    const [fd, fB, fG, fD, fg] = frets;

    // 5 strings × 16 positions
    const m = Array.from({ length: 5 }, () => Array(16).fill('-'));

    if (difficulty === 'easy') {
        // BUM (strum) on beats 1 & 3 (pos 0, 8)
        // THUMB (5th string) on beats 2 & 4 (pos 4, 12)
        const strumPositions = [0, 8];
        const thumbPositions = [4, 12];

        for (const p of strumPositions) {
            m[0][p] = fd.toString(); // d
            m[1][p] = fB.toString(); // B
            m[2][p] = fG.toString(); // G
            m[3][p] = fD.toString(); // D
        }
        for (const p of thumbPositions) {
            m[4][p] = fg.toString(); // g (5th, drone)
        }

        // Small variation: alternate melody note between 1st and 2nd string on beat 3
        if (variation % 2 === 1) {
            m[0][8] = '-';
            m[1][8] = fB.toString();
        }

    } else {
        // MEDIUM: more melodic movement

        // Beat 1: single melody note on 1st string (d)
        m[0][0] = fd.toString();

        // Beat 1+ (pos 2): inner strings strum
        m[1][2] = fB.toString();
        m[2][2] = fG.toString();

        // Beat 2 (pos 4): thumb
        m[4][4] = fg.toString();

        // Beat 3 (pos 8): single melody note — vary between strings
        if (variation % 3 === 0) {
            m[0][8] = fd.toString();
        } else if (variation % 3 === 1) {
            const passNote = fd === 0 ? 2 : fd;
            m[0][8] = passNote.toString();
        } else {
            m[1][8] = fB.toString();
        }

        // Beat 3+ (pos 10): second string fill
        m[2][10] = fG.toString();

        // Beat 4 (pos 12): thumb
        m[4][12] = fg.toString();

        // Occasional hammer-on flourish on position 14 (d string)
        if (variation % 4 === 0 && fd === 0) {
            m[0][14] = 'h2';
        }
    }

    return m;
}

/**
 * Render a row of up to 4 measures into display strings.
 * Returns { chordLine: string, stringLines: string[] }
 */
function renderMeasureRow(measures, chordNames, startMeasureIdx) {
    const STR_NAMES = ['d', 'B', 'G', 'D', 'g'];

    // First find col widths for each pos in each measure
    const measureColWidths = measures.map(measure => {
        const colWidths = [];
        for (let pos = 0; pos < 16; pos++) {
            let maxW = 1;
            for (let strIdx = 0; strIdx < 5; strIdx++) {
                if (measure[strIdx][pos].length > maxW) maxW = measure[strIdx][pos].length;
            }
            colWidths.push(maxW);
        }
        return colWidths;
    });

    let currentChOffset = 2; // "d|"
    let chordLine = '  ';

    for (let m = 0; m < measures.length; m++) {
        // We only add a single unit of space before the first string position, which is effectively 0 spaces because it aligns with the column
        const mLengthBefore = currentChOffset;

        const globalMeasureIdx = startMeasureIdx + m;
        if (!uiTabPositions[globalMeasureIdx]) uiTabPositions[globalMeasureIdx] = [];

        for (let pos = 0; pos < 16; pos++) {
            const w = measureColWidths[m][pos];
            uiTabPositions[globalMeasureIdx][pos] = {
                leftCh: currentChOffset,
                widthCh: w
            };
            currentChOffset += w;
        }
        currentChOffset += 1; // '|'
        const wMeasure = currentChOffset - mLengthBefore; // Length of the measure block itself
        const name = chordNames[m] || '';
        chordLine += name.padEnd(wMeasure, ' ');
    }

    const stringLines = STR_NAMES.map((name, strIdx) => {
        let line = name + '|';
        for (let m = 0; m < measures.length; m++) {
            const measure = measures[m];

            // Format each position column
            for (let pos = 0; pos < 16; pos++) {
                let val = measure[strIdx][pos];
                // Pad to column width
                if (val.length < measureColWidths[m][pos]) {
                    val = val.padEnd(measureColWidths[m][pos], '-');
                }
                line += val;
            }
            line += '|';
        }
        return line;
    });

    return { chordLine, stringLines };
}

/**
 * Build the full tab HTML for a song (plays progression twice = 8 measures).
 */
function buildTabHTML(progression, difficulty) {
    const { chords } = progression;
    const allChords = [...chords, ...chords];
    const allMeasures = allChords.map((ch, i) => generateMeasure(ch, difficulty, i));
    lastAllMeasures = allMeasures;  // expose to audio engine

    uiTabPositions = []; // reset positions for new song

    let html = '';

    for (let row = 0; row < 2; row++) {
        const start = row * 4;
        const rowChords = allChords.slice(start, start + 4);
        const rowMeasures = allMeasures.slice(start, start + 4);

        const { chordLine, stringLines } = renderMeasureRow(rowMeasures, rowChords, start);
        const labelText = row === 0 ? 'Verse (measures 1–4)' : 'Repeat (measures 5–8)';

        // Syntax-colour the tab lines
        const coloredLines = stringLines.map(line =>
            line
                .replace(/^([dBGg])(\|)/, '<span class="str-name">$1</span><span class="str-bar">$2</span>')
                .replace(/\|/g, '<span class="str-bar">|</span>')
                .replace(/([1-9])/g, '<span class="str-fret">$1</span>')
                .replace(/h2/g, '<span class="str-fret">h2</span>')
        );

        html += `
      <div class="tab-block animate-in" style="animation-delay:${row * 0.08}s">
        <div class="tab-line-label">${labelText}</div>
        <div class="tab-section">
          <div class="tab-chord-labels">${chordLine}</div>
          <div class="tab-strings" style="position: relative;"><div class="beat-cursor" id="beat-cursor-${row}"></div>${coloredLines.join('\n')}</div>
        </div>
      </div>`;
    }

    return html;
}

/* ================================================================
   CHORD DIAGRAM (SVG)
   ================================================================ */

function drawChordDiagram(chordName) {
    const chord = CHORD_LIB[chordName];
    if (!chord) return;

    // Diagram column order (left → right): g(5th), D(4th), G(3rd), B(2nd), d(1st)
    const diagramOrder = [4, 3, 2, 1, 0];
    const frets = diagramOrder.map(i => chord.frets[i]);
    const stringLabels = ['g', 'D', 'G', 'B', 'd'];

    const svg = document.getElementById('chord-svg');
    const W = 160, H = 170;
    const marginLeft = 24, marginRight = 24, nutY = 50;
    const fretCount = 4, stringCount = 5;
    const stringSpacing = (W - marginLeft - marginRight) / (stringCount - 1);
    const fretSpacing = (H - nutY - 24) / fretCount;

    let s = '';

    // String labels at bottom
    for (let i = 0; i < stringCount; i++) {
        const x = marginLeft + i * stringSpacing;
        s += `<text x="${x}" y="${H - 4}" text-anchor="middle" fill="#555577" font-family="Courier New" font-size="9">${stringLabels[i]}</text>`;
    }

    // Open (○) / muted (✕) markers above nut
    for (let i = 0; i < stringCount; i++) {
        const x = marginLeft + i * stringSpacing;
        const f = frets[i];
        if (f === -1) {
            s += `<text x="${x}" y="${nutY - 12}" text-anchor="middle" fill="#555577" font-size="13" font-family="Arial">✕</text>`;
        } else if (f === 0) {
            s += `<circle cx="${x}" cy="${nutY - 14}" r="5" fill="none" stroke="#888899" stroke-width="1.5"/>`;
        }
    }

    // Nut
    s += `<rect x="${marginLeft - 2}" y="${nutY}" width="${W - marginLeft - marginRight + 4}" height="5" rx="2" fill="#c4910d"/>`;

    // Fret lines
    for (let f = 1; f <= fretCount; f++) {
        const y = nutY + 5 + f * fretSpacing;
        s += `<line x1="${marginLeft}" y1="${y}" x2="${W - marginRight}" y2="${y}" stroke="#2c2c46" stroke-width="1"/>`;
    }

    // String lines
    for (let i = 0; i < stringCount; i++) {
        const x = marginLeft + i * stringSpacing;
        s += `<line x1="${x}" y1="${nutY}" x2="${x}" y2="${H - 20}" stroke="#333345" stroke-width="${i === 0 ? 1.5 : 1}"/>`;
    }

    // Finger dots
    for (let i = 0; i < stringCount; i++) {
        const f = frets[i];
        if (f > 0) {
            const x = marginLeft + i * stringSpacing;
            const y = nutY + 5 + (f - 0.5) * fretSpacing;
            s += `<circle cx="${x}" cy="${y}" r="9" fill="#c4910d"/>`;
            s += `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="#000" font-size="10" font-weight="700" font-family="Inter,Arial">${f}</text>`;
        }
    }

    svg.innerHTML = s;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    document.getElementById('chord-name-display').textContent = chordName;
    document.getElementById('chord-label-display').textContent = chord.label;
}

/* ================================================================
   CHORD CARDS
   ================================================================ */

function buildChordCards(chords) {
    const container = document.getElementById('chord-cards');
    container.innerHTML = '';

    chords.forEach((chordName, idx) => {
        const chord = CHORD_LIB[chordName];
        const card = document.createElement('div');
        card.className = 'chord-card' + (idx === selectedChordIdx ? ' selected' : '');
        card.innerHTML = `
      <div class="chord-card-num">${idx + 1}</div>
      <div class="chord-card-info">
        <div class="chord-card-name">${chordName}</div>
        <div class="chord-card-label">${chord.label}</div>
      </div>`;
        card.addEventListener('click', () => {
            selectedChordIdx = idx;
            document.querySelectorAll('.chord-card').forEach((c, i) => {
                c.classList.toggle('selected', i === idx);
            });
            drawChordDiagram(chordName);
        });
        container.appendChild(card);
    });
}

/* ================================================================
   GENERATE
   ================================================================ */

function setPlayBtnState(playing) {
    const btn = document.getElementById('play-btn');
    if (!btn) return;
    if (playing) {
        btn.textContent = '⏹ Stop';
        btn.classList.add('playing');
    } else {
        btn.textContent = '▶ Play';
        btn.classList.remove('playing');
    }
}

function generate() {
    // Stop any current playback when a new song is generated
    if (typeof stopSong === 'function' && isPlaying) {
        stopSong();
        setPlayBtnState(false);
    }

    const pool = PROGRESSIONS[currentKey][currentDiff];
    const prog = pool[Math.floor(Math.random() * pool.length)];
    currentProgression = prog;
    selectedChordIdx = 0;

    buildChordCards(prog.chords);
    drawChordDiagram(prog.chords[0]);

    const header = document.getElementById('tab-header');
    header.style.display = 'flex';
    document.getElementById('song-title').textContent = prog.title;

    const diffLabel = currentDiff.charAt(0).toUpperCase() + currentDiff.slice(1);
    document.getElementById('song-meta').innerHTML =
        `<span class="badge-key">Key of ${currentKey}</span><span>${diffLabel}</span><span>4/4 Time</span><span>Clawhammer</span>`;

    const content = document.getElementById('tab-content');
    content.innerHTML = buildTabHTML(prog, currentDiff);

    content.insertAdjacentHTML('beforeend', `
    <div class="tab-legend">
      <div class="legend-item"><div class="legend-dot open"></div><span>Open string (0)</span></div>
      <div class="legend-item"><div class="legend-dot fret"></div><span>Fretted note</span></div>
      <div class="legend-item"><div class="legend-dot thumb"></div><span>Drone / thumb (g string)</span></div>
    </div>
    <div class="pattern-guide">
      <h3>🪕 Clawhammer Pattern — Bum-Ditty</h3>
      <div class="pattern-steps">
        <div class="pattern-step">
          <div class="step-badge">1</div>
          <div class="step-text"><strong>BUM</strong>Strike down with back of nail on melody string</div>
        </div>
        <div class="pattern-step">
          <div class="step-badge">2</div>
          <div class="step-text"><strong>DIT</strong>Brush/strum across strings on the off-beat</div>
        </div>
        <div class="pattern-step">
          <div class="step-badge">3</div>
          <div class="step-text"><strong>TY</strong>Thumb drops onto the 5th string (g drone)</div>
        </div>
      </div>
    </div>`);
}

/* ================================================================
   VISUAL BEAT INDICATOR
   ================================================================ */

let lastActiveCursorRow = -1;

function resetVisualBeat() {
    for (let i = 0; i < 2; i++) {
        const c = document.getElementById(`beat-cursor-${i}`);
        if (c) c.style.display = 'none';
    }
    lastActiveCursorRow = -1;
}

function stopVisualBeat() {
    resetVisualBeat();
}

function updateVisualBeat(measureIdx, pos) {
    if (!uiTabPositions || !uiTabPositions[measureIdx]) return;

    const posData = uiTabPositions[measureIdx][pos];
    const rowIdx = Math.floor(measureIdx / 4);

    if (lastActiveCursorRow !== -1 && lastActiveCursorRow !== rowIdx) {
        const oldC = document.getElementById(`beat-cursor-${lastActiveCursorRow}`);
        if (oldC) oldC.style.display = 'none';
    }

    const cursor = document.getElementById(`beat-cursor-${rowIdx}`);
    if (cursor) {
        cursor.style.display = 'block';
        cursor.style.left = `${posData.leftCh}ch`;
        cursor.style.width = `${posData.widthCh}ch`;
    }
    lastActiveCursorRow = rowIdx;
}

/* ================================================================
   UI WIRING
   ================================================================ */

document.getElementById('key-group').addEventListener('click', e => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    currentKey = btn.dataset.key;
    document.querySelectorAll('#key-group button').forEach(b => b.classList.toggle('active', b === btn));
});

document.getElementById('diff-group').addEventListener('click', e => {
    const btn = e.target.closest('button[data-diff]');
    if (!btn) return;
    currentDiff = btn.dataset.diff;
    document.querySelectorAll('#diff-group button').forEach(b => b.classList.toggle('active', b === btn));
});

document.getElementById('generate-btn').addEventListener('click', generate);

document.getElementById('play-btn').addEventListener('click', () => {
    if (!lastAllMeasures) return;
    if (isPlaying) {
        stopSong();
        setPlayBtnState(false);
    } else {
        setPlayBtnState(true);
        playSong(lastAllMeasures, currentTempo, () => setPlayBtnState(false), {
            enabled: metroEnabled,
            accentDownbeat: metroAccent,
            banjoVolume: currentBanjoVol,
            metroVolume: currentMetroVol,
            metroPitch: currentMetroPitch
        });
    }
});

// Tempo slider
const tempoSlider = document.getElementById('tempo-slider');
const tempoDisplay = document.getElementById('tempo-display');
tempoSlider.addEventListener('input', () => {
    currentTempo = parseInt(tempoSlider.value, 10);
    tempoDisplay.textContent = currentTempo;
    if (typeof updateTempo === 'function') updateTempo(currentTempo);
});

// Volume sliders
const banjoVolSlider = document.getElementById('banjo-vol');
if (banjoVolSlider) {
    banjoVolSlider.addEventListener('input', () => {
        currentBanjoVol = parseFloat(banjoVolSlider.value);
        if (typeof updateAudioSettings === 'function') updateAudioSettings(currentBanjoVol, currentMetroVol, currentMetroPitch, metroEnabled, metroAccent);
    });
}

const metroVolSlider = document.getElementById('metro-vol');
if (metroVolSlider) {
    metroVolSlider.addEventListener('input', () => {
        currentMetroVol = parseFloat(metroVolSlider.value);
        if (typeof updateAudioSettings === 'function') updateAudioSettings(currentBanjoVol, currentMetroVol, currentMetroPitch, metroEnabled, metroAccent);
    });
}

const metroPitchSlider = document.getElementById('metro-pitch');
if (metroPitchSlider) {
    metroPitchSlider.addEventListener('input', () => {
        currentMetroPitch = parseFloat(metroPitchSlider.value);
        if (typeof updateAudioSettings === 'function') updateAudioSettings(currentBanjoVol, currentMetroVol, currentMetroPitch, metroEnabled, metroAccent);
    });
}

// Metronome toggles
document.getElementById('metro-enabled').addEventListener('change', e => {
    metroEnabled = e.target.checked;
    document.getElementById('metro-accent').disabled = !metroEnabled;
    if (typeof updateAudioSettings === 'function') updateAudioSettings(currentBanjoVol, currentMetroVol, currentMetroPitch, metroEnabled, metroAccent);
});
document.getElementById('metro-accent').addEventListener('change', e => {
    metroAccent = e.target.checked;
    if (typeof updateAudioSettings === 'function') updateAudioSettings(currentBanjoVol, currentMetroVol, currentMetroPitch, metroEnabled, metroAccent);
});
// Sync initial disabled state
document.getElementById('metro-accent').disabled = true;

// Auto-generate on load
generate();
