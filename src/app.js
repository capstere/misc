import { ROOTS, SCALES, ROWS, KEYMAP, keyNotes, clamp } from './music.js';
import { Synth, PRESETS } from './audio.js';
import { Performance } from './performance.js';

const $ = id => document.getElementById(id);
const state = { root: 2, scale: 'pentatonic', octave: 4, preset: 0, layout: 'auto', tone: .48, space: .48, volume: .72, bpm: 96 };
try {
  const saved = JSON.parse(localStorage.getItem('orbit.settings.v1') || '{}');
  for (const [name, min, max] of [['root', 0, 11], ['octave', 2, 6], ['preset', 0, 7], ['bpm', 45, 180], ['tone', 0, 1], ['space', 0, 1], ['volume', 0, 1]]) {
    if (Number.isFinite(saved[name])) state[name] = clamp(saved[name], min, max);
  }
  for (const name of ['root', 'octave', 'preset', 'bpm']) state[name] = Math.round(state[name]);
  if (Object.hasOwn(SCALES, saved.scale)) state.scale = saved.scale;
  if (['auto', 'qwerty', 'qwertz', 'swedish'].includes(saved.layout)) state.layout = saved.layout;
} catch { /* Private browsing and unavailable storage must not stop the instrument. */ }
const save = () => { try { localStorage.setItem('orbit.settings.v1', JSON.stringify(state)); } catch {} };
let synth = null, performance = null, starting = null, ready = false;
let sustainLatched = false, expressionLatched = false, autoLayout = 'qwerty';
let toastTimer, accent = PRESETS[state.preset].color;
const detectedLabels = new Map();
const heldKeys = new Set(), pointers = new Map(), buttons = new Map(), pointerControls = new WeakSet();
const page = document.querySelector('.page');
page.inert = true;

function toast(message) {
  $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}
function updateLayout() {
  const layout = state.layout === 'auto' ? autoLayout : state.layout;
  for (const [code, button] of buttons) {
    let label = code === 'BracketLeft' ? '[' : code === 'BracketRight' ? ']' : code.slice(3);
    if (layout === 'qwertz') { if (label === 'Y') label = 'Z'; else if (label === 'Z') label = 'Y'; else if (label === '[') label = 'Ü'; else if (label === ']') label = '+'; }
    if (layout === 'swedish') { if (label === '[') label = 'Å'; else if (label === ']') label = '¨'; }
    if (state.layout === 'auto' && detectedLabels.has(code)) label = detectedLabels.get(code);
    button.querySelector('kbd').textContent = label;
    button.dataset.letter = label;
  }
  updateNotes();
}
function updateNotes() {
  for (const [code, button] of buttons) {
    const data = keyNotes(code, state);
    button.hidden = !data;
    if (!data) continue;
    button.querySelector('.key-note').textContent = data.label;
    button.setAttribute('aria-label', `${button.dataset.letter}: ${data.role === 'chord' ? 'ackord' : data.role === 'bass' ? 'bas' : 'ton'} ${data.label}`);
  }
  $('keyboard').classList.toggle('free', state.scale === 'chromatic');
  $('root').value = state.root; $('scale').value = state.scale; $('octaveValue').textContent = state.octave;
  $('octaveDown').disabled = state.octave === 2; $('octaveUp').disabled = state.octave === 6;
  $('safeLabel').textContent = state.scale === 'chromatic' ? 'ALLA 12 TONER. HELT FRITT.' : '● ALLA TONER HÖR IHOP';
  renderState();
}
function renderPreset() {
  const preset = PRESETS[state.preset]; accent = preset.color;
  document.documentElement.style.setProperty('--accent', accent);
  $('presetName').textContent = preset.name; $('soundKind').textContent = preset.kind;
  $('presetDescription').textContent = preset.text; $('presetIndex').textContent = `${String(state.preset + 1).padStart(2, '0')} / 08`;
  [...$('presetBank').children].forEach((button, i) => button.setAttribute('aria-pressed', i === state.preset));
  if (performance) performance.preset = state.preset;
}
function renderState() {
  const active = new Set(), sustained = new Set(); let last = null;
  if (performance) for (const entry of performance.sources.values()) {
    (entry.down ? active : sustained).add(entry.code); last = entry;
  }
  for (const [code, button] of buttons) {
    button.classList.toggle('active', active.has(code)); button.classList.toggle('held', sustained.has(code));
    button.setAttribute('aria-pressed', active.has(code) || sustained.has(code));
  }
  $('noteReadout').textContent = last ? last.label : `${ROOTS[state.root]} · ${SCALES[state.scale].name.toUpperCase()}`;
  $('voiceStatus').textContent = active.size + sustained.size ? `${active.size} SPELAS${sustained.size ? ` / ${sustained.size} SUSTAIN` : ''}` : performance?.playing ? 'LOOPEN SPELAR' : 'TYSTNAD ÄR OCKSÅ MUSIK';
  $('sustain').setAttribute('aria-pressed', performance?.sustain || false);
  $('expression').setAttribute('aria-pressed', synth?.expression || false);
  if (!performance) return;
  const p = performance, recording = p.recordState === 'recording', armed = p.recordState === 'armed';
  $('arp').setAttribute('aria-pressed', p.arp);
  $('arpHint').textContent = p.arp ? 'Håll A–L. Melodi och bas är fortfarande fria.' : 'Ge ackorden puls. Spela melodi ovanpå.';
  $('record').classList.toggle('recording', recording); $('record').classList.toggle('armed', armed);
  $('record').setAttribute('aria-label', recording ? 'Avsluta inspelningen och loopa' : armed ? 'Avbryt armeringen' : 'Spela in en ny loop');
  $('recordLabel').textContent = recording ? 'Avsluta' : armed ? 'Armerad' : 'Spela in';
  $('playLoop').disabled = !p.events.length || recording || armed;
  $('clearLoop').disabled = !p.events.length && !armed;
  $('playLoop').setAttribute('aria-pressed', p.playing); $('playIcon').textContent = p.playing ? 'Ⅱ' : '▶';
  $('loopTrack').classList.toggle('recording', recording || armed);
  $('loopBadge').textContent = recording ? 'INSPELNING' : armed ? 'VÄNTAR PÅ FÖRSTA TONEN' : p.events.length ? `${p.loopBeats / 4} TAKT${p.loopBeats > 4 ? 'ER' : ''} / ${p.events.length} TONER` : 'UPP TILL 8 TAKTER';
  $('loopHint').textContent = recording ? 'Tryck 2 för att avsluta till en hel takt.' : armed ? 'Första tonen startar. Tryck 2 för att avbryta.' : p.events.length ? p.playing ? 'Din idé snurrar. Spela något nytt ovanpå.' : 'Loopen är kvar. Tryck 3 för att spela.' : 'Spela in → avsluta → spela ovanpå.';
  $('bpm').disabled = recording; $('tap').disabled = recording;
  $('bpm').title = recording ? 'Avsluta inspelningen innan du ändrar tempo.' : '45–180 BPM';
  if (document.activeElement !== $('bpm')) $('bpm').value = p.bpm;
}
async function ensureAudio() {
  if (ready && synth?.ctx.state === 'running') return true;
  if (starting) return starting;
  starting = (async () => {
    try {
      if (!synth) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error('Web Audio unavailable');
        synth = new Synth(new Context({ latencyHint: 'interactive' }));
        performance = new Performance(synth, renderState); performance.preset = state.preset;
        synth.setTone(state.tone); synth.setSpace(state.space); synth.setVolume(state.volume); performance.setTempo(state.bpm);
        synth.ctx.onstatechange = () => {
          if (ready && synth.ctx.state !== 'running') {
            panic(); ready = false; $('audioStatus').textContent = 'Spela för att väcka'; document.body.classList.remove('running');
          }
        };
      }
      if (synth.ctx.state !== 'running') await synth.ctx.resume();
      if (synth.ctx.state !== 'running') throw new Error('Audio activation needed');
      ready = true; page.inert = false; $('entry').hidden = true;
      $('audioStatus').textContent = 'Ljud aktivt'; document.body.classList.add('running');
      performance.startClock(); renderState();
      // Optional enhancement only. Physical KeyboardEvent.code remains the source of truth.
      if (state.layout === 'auto' && navigator.keyboard?.getLayoutMap) {
        navigator.keyboard.getLayoutMap().then(map => { for (const code of KEYMAP.keys()) { const label = map.get(code); if (label && label.length === 1) detectedLabels.set(code, label.toUpperCase()); } autoLayout = map.get('KeyY')?.toLowerCase() === 'z' ? 'qwertz' : 'qwerty'; updateLayout(); }).catch(() => {});
      }
      return true;
    } catch {
      $('entryHint').textContent = 'Ljudet kunde inte starta. Klicka för att försöka igen.';
      toast('Klicka på Kliv in för att aktivera ljudet.'); return false;
    }
  })();
  try { return await starting; } finally { starting = null; }
}
function panic(message) {
  heldKeys.clear(); pointers.clear(); sustainLatched = false; expressionLatched = false;
  performance?.panic(); renderState();
  if (message) toast(message);
}
function releaseLive() {
  if (!performance) return;
  for (const source of [...performance.sources.keys()]) performance.release(source, true);
  sustainLatched = false; expressionLatched = false;
  heldKeys.delete('Space'); heldKeys.delete('ShiftLeft'); heldKeys.delete('ShiftRight');
  performance.pedal(false); synth.setTone(state.tone, false); synth.cancelGroup('arp');
  pointers.clear();
}
function setMapping(change) { releaseLive(); Object.assign(state, change); updateNotes(); save(); }
function setPreset(value) { state.preset = (value + PRESETS.length) % PRESETS.length; renderPreset(); save(); }
function octave(delta) { setMapping({ octave: clamp(state.octave + delta, 2, 6) }); }
function syncPedal() { performance?.pedal(sustainLatched || heldKeys.has('Space')); }
function syncExpression() { synth?.setTone(state.tone, expressionLatched || heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight')); renderState(); }
function playCode(source, code) { const data = keyNotes(code, state); if (data && performance) performance.press(source, { ...data, code }); }
function shortcut(code) {
  if (code === 'ArrowLeft') setPreset(state.preset - 1);
  else if (code === 'ArrowRight') setPreset(state.preset + 1);
  else if (code === 'ArrowUp') octave(1);
  else if (code === 'ArrowDown') octave(-1);
  else if (code === 'Digit1') performance.setArp(!performance.arp);
  else if (code === 'Digit2') performance.toggleRecord();
  else if (code === 'Digit3') performance.toggleLoop();
  else if (code === 'Digit4') performance.clearLoop();
}
const controlCodes = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Digit1', 'Digit2', 'Digit3', 'Digit4']);
const editor = target => target instanceof Element && Boolean(target.closest('input,select,textarea,[contenteditable="true"]'));
document.addEventListener('keydown', event => {
  const { code } = event;
  if (code === 'Escape') { event.preventDefault(); panic('Allt tyst. Börja om med en ton.'); if (editor(event.target)) event.target.blur(); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) { if (heldKeys.size || performance?.sources.size) panic(); return; }
  if (event.isComposing || editor(event.target)) return;
  if (!ready && (code === 'Enter' || code === 'Space')) { event.preventDefault(); ensureAudio(); return; }
  if (event.target instanceof HTMLButtonElement && (code === 'Enter' || code === 'Space')) return;
  const note = Boolean(keyNotes(code, state)), modifier = code === 'Space' || code.startsWith('Shift');
  if (!note && !modifier && !controlCodes.has(code)) return;
  event.preventDefault();
  if (event.repeat || heldKeys.has(code)) return;
  heldKeys.add(code);
  if (state.layout === 'auto' && KEYMAP.has(code) && event.key.length === 1 && !event.shiftKey) { detectedLabels.set(code, event.key.toUpperCase()); updateLayout(); }
  if (state.layout === 'auto' && ((code === 'KeyY' && event.key.toLowerCase() === 'z') || (code === 'KeyZ' && event.key.toLowerCase() === 'y'))) {
    autoLayout = 'qwertz'; updateLayout();
  }
  ensureAudio().then(ok => {
    if (!ok || !heldKeys.has(code)) return;
    if (note) playCode(`k:${code}`, code);
    else if (code === 'Space') syncPedal();
    else if (code.startsWith('Shift')) syncExpression();
    else shortcut(code);
  });
});
// Key-up always releases, even when focus moved into a form control during a note.
document.addEventListener('keyup', event => {
  const code = event.code, had = heldKeys.delete(code);
  if (KEYMAP.has(code)) performance?.release(`k:${code}`);
  if (had && code === 'Space') syncPedal();
  if (had && code.startsWith('Shift')) syncExpression();
  if (had && !editor(event.target)) event.preventDefault();
});
window.addEventListener('blur', () => { if (ready) panic('Pausat när fönstret tappade fokus.'); else heldKeys.clear(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) panic(); });
window.addEventListener('pagehide', () => { panic(); performance?.stopClock(); });
window.addEventListener('pageshow', () => { if (ready) performance?.startClock(); });

for (const row of ROWS) {
  const element = document.createElement('div'); element.className = `key-row ${row.role}`; element.style.setProperty('--row', `var(--${row.role})`);
  const label = document.createElement('span'); label.className = 'row-label'; label.textContent = row.name.toUpperCase(); element.append(label);
  const codes = [...row.keys].map(letter => `Key${letter}`);
  if (row.role === 'melody') codes.push('BracketLeft', 'BracketRight');
  for (const code of codes) {
    const button = document.createElement('button');
    button.className = 'key'; button.dataset.code = code; button.type = 'button';
    button.innerHTML = '<kbd></kbd><span class="key-note"></span>'; buttons.set(code, button); element.append(button);
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); button.setPointerCapture(event.pointerId);
      const source = `p:${event.pointerId}:${code}`;
      pointers.set(event.pointerId, { code, source });
      ensureAudio().then(ok => { if (ok && pointers.get(event.pointerId)?.source === source) playCode(source, code); });
    });
    button.addEventListener('click', event => {
      if (event.detail !== 0) return;
      ensureAudio().then(ok => { if (!ok) return; const source = `access:${code}`; playCode(source, code); setTimeout(() => performance.release(source), 220); });
    });
  }
  $('keyboard').append(element);
}
window.addEventListener('pointermove', event => {
  const current = pointers.get(event.pointerId); if (!current || !ready) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.key');
  const code = target?.dataset.code;
  if (code === current.code) return;
  performance.release(current.source);
  const source = `p:${event.pointerId}:${code || 'gap'}`;
  pointers.set(event.pointerId, { code, source });
  if (code) playCode(source, code);
});
function endPointer(event) {
  const current = pointers.get(event.pointerId); if (!current) return;
  performance?.release(current.source, event.type === 'pointercancel'); pointers.delete(event.pointerId);
}
window.addEventListener('pointerup', endPointer); window.addEventListener('pointercancel', endPointer);
document.addEventListener('lostpointercapture', endPointer);

ROOTS.forEach((name, i) => $('root').add(new Option(name, i)));
Object.entries(SCALES).forEach(([id, scale]) => $('scale').add(new Option(scale.name, id)));
PRESETS.forEach((preset, i) => {
  const button = document.createElement('button'); button.type = 'button'; button.style.setProperty('--swatch', preset.color);
  button.innerHTML = `<span></span>${preset.name}`; button.setAttribute('aria-label', `${preset.name} — ${preset.kind}`);
  button.addEventListener('click', () => setPreset(i)); $('presetBank').append(button);
});
$('root').addEventListener('change', event => setMapping({ root: Number(event.target.value) }));
$('scale').addEventListener('change', event => setMapping({ scale: event.target.value }));
$('layout').value = state.layout;
$('layout').addEventListener('change', event => { state.layout = event.target.value; updateLayout(); save(); });
$('prevPreset').onclick = () => setPreset(state.preset - 1); $('nextPreset').onclick = () => setPreset(state.preset + 1);
$('octaveDown').onclick = () => octave(-1); $('octaveUp').onclick = () => octave(1);
$('enter').onclick = async () => { await ensureAudio(); $('enter').blur(); };
$('panic').onclick = () => panic('Allt tyst. Börja om med en ton.');
$('sustain').onclick = async () => { if (await ensureAudio()) { sustainLatched = !sustainLatched; syncPedal(); } };
$('expression').onclick = async () => { if (await ensureAudio()) { expressionLatched = !expressionLatched; syncExpression(); } };
$('arp').onclick = async () => { if (await ensureAudio()) performance.setArp(!performance.arp); };
$('record').onclick = async () => { if (await ensureAudio()) performance.toggleRecord(); };
$('playLoop').onclick = () => performance?.toggleLoop(); $('clearLoop').onclick = () => performance?.clearLoop();
for (const name of ['tone', 'space', 'volume']) {
  $(name).value = state[name] * 100;
  $(name).addEventListener('input', event => {
    state[name] = Number(event.target.value) / 100;
    if (synth) synth[{ tone: 'setTone', space: 'setSpace', volume: 'setVolume' }[name]](state[name]); save();
  });
}
$('bpm').value = state.bpm;
function tempo(value) {
  const bpm = clamp(Math.round(Number(value) || 96), 45, 180);
  if (!performance || performance.setTempo(bpm)) { state.bpm = bpm; $('bpm').value = bpm; save(); }
}
$('bpm').addEventListener('change', event => tempo(event.target.value));
$('bpm').addEventListener('keydown', event => { if (event.key === 'Enter') event.target.blur(); });
let taps = [];
$('tap').onclick = () => {
  const now = window.performance.now();
  if (taps.length && now - taps.at(-1) > 2200) taps = [];
  taps.push(now); if (taps.length > 5) taps.shift();
  if (taps.length > 1) tempo(60000 * (taps.length - 1) / (taps.at(-1) - taps[0]));
  else toast('Fortsätt klicka i takt.');
};
for (const id of ['pattern', 'division', 'arpOctaves', 'gate']) $(id).addEventListener('change', async () => {
  if (await ensureAudio()) performance.configureArp({ pattern: $('pattern').value, division: Number($('division').value), octaves: Number($('arpOctaves').value), gate: Number($('gate').value) / 100 });
});
// Mouse adjustments hand focus back to playing; keyboard form navigation remains native.
for (const element of document.querySelectorAll('select,input')) {
  element.addEventListener('pointerdown', () => pointerControls.add(element));
  element.addEventListener('change', () => { if (pointerControls.has(element)) { pointerControls.delete(element); element.blur(); } });
}
document.addEventListener('pointerup', event => {
  const button = event.target.closest?.('button'); if (button && !button.classList.contains('key')) button.blur();
});
$('helpButton').onclick = () => { $('help').hidden = !$('help').hidden; $('helpButton').setAttribute('aria-expanded', !$('help').hidden); };

const canvas = $('visualizer'), draw = canvas.getContext('2d'), signal = new Float32Array(512);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let width = 400, height = 145, dpr = 1, lastFrame = 0, lastMeter = -1, lastPercent = -1;
function resize() {
  const rect = canvas.getBoundingClientRect(); width = Math.max(1, rect.width); height = Math.max(1, rect.height);
  dpr = Math.min(window.devicePixelRatio || 1, 1.5); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
}
new ResizeObserver(resize).observe(canvas);
function frame(time) {
  requestAnimationFrame(frame);
  if (document.hidden || time - lastFrame < (reducedMotion.matches ? 110 : ready ? 33 : 140)) return;
  lastFrame = time;
  let energy = 0;
  if (synth && ready) { synth.analyser.getFloatTimeDomainData(signal); for (let i = 0; i < signal.length; i++) energy += signal[i] * signal[i]; energy = Math.sqrt(energy / signal.length); }
  else signal.fill(0);
  if (draw) {
    draw.setTransform(dpr, 0, 0, dpr, 0, 0); draw.clearRect(0, 0, width, height);
    draw.strokeStyle = '#303c2f'; draw.lineWidth = .7; draw.globalAlpha = .5; draw.setLineDash([2, 6]);
    draw.beginPath(); draw.moveTo(0, height / 2); draw.lineTo(width, height / 2); draw.stroke(); draw.setLineDash([]);
    for (let strand = 2; strand >= 0; strand--) {
      draw.beginPath(); draw.strokeStyle = accent; draw.globalAlpha = strand === 0 ? .82 : .15; draw.lineWidth = strand === 0 ? 1.4 : .8;
      for (let i = 0; i <= 150; i++) {
        const x = i / 150 * width, edge = Math.sin(i / 150 * Math.PI), sample = signal[(i * 3 + strand * 23) % signal.length];
        const y = height / 2 + sample * height * 2.1 * edge + (strand - 1) * Math.sin(i * .045 + time * .0006) * energy * height * 2;
        if (i === 0) draw.moveTo(x, y); else draw.lineTo(x, y);
      }
      draw.stroke();
    }
    draw.globalAlpha = 1;
  }
  const level = clamp(Math.ceil(Math.sqrt(energy) * 28), 0, 12);
  if (level !== lastMeter) { [...$('meter').children].forEach((el, i) => el.classList.toggle('lit', i < level)); lastMeter = level; }
  let progress = 0;
  if (performance?.playing) progress = Math.max(0, ((performance.now - performance.origin) * performance.bpm / 60) % performance.loopBeats) / performance.loopBeats;
  else if (performance?.recordState === 'recording') progress = clamp((performance.now - performance.recordStart) * performance.recordTempo / 60 / 32, 0, 1);
  const percent = Math.round(progress * 100);
  if (percent !== lastPercent) { $('loopProgress').style.transform = `scaleX(${progress})`; $('loopTrack').setAttribute('aria-valuenow', percent); lastPercent = percent; }
}
updateLayout(); renderPreset(); resize(); requestAnimationFrame(frame); $('enter').focus({ preventScroll: true });
// Opt-in test hook: absent on the normal instrument URL.
if (new URLSearchParams(location.search).has('test')) window.__orbit = { state, get synth() { return synth; }, get performance() { return performance; }, panic,
  snapshot: () => ({ ready, voices: synth?.voices.size || 0, sources: performance?.sources.size || 0, held: heldKeys.size,
    sustain: performance?.sustain || false, expression: synth?.expression || false, arp: performance?.arp || false,
    recording: performance?.recordState, events: performance?.events.length || 0, looping: performance?.playing || false, baseLatency: synth?.ctx.baseLatency ?? null }) };
