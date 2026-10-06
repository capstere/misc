"""Real Web Audio + input regression tests. No runtime dependencies for the instrument."""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)


def embedded_mount(page):
    # Local-only fixture for environments where browser URL navigation is disabled.
    # Modules still execute natively, from Blob URLs; production files are not modified.
    page.goto('about:blank?test=1')
    html = re.sub(r'<script type="module"[^>]*></script>|<link[^>]*>', '', (ROOT / 'index.html').read_text())
    page.set_content(html)
    page.add_style_tag(content=(ROOT / 'style.css').read_text())
    files = {f'src/{name}.js': (ROOT / f'src/{name}.js').read_text() for name in ['music', 'audio', 'performance', 'app']}
    page.evaluate("""files => {
      window.moduleURLs = {};
      for (const [path, source] of Object.entries(files)) {
        let code = source;
        for (const [dep, url] of Object.entries(moduleURLs)) code = code.replaceAll("'./" + dep.split('/').pop() + "'", JSON.stringify(url));
        moduleURLs[path] = URL.createObjectURL(new Blob([code], {type: 'text/javascript'}));
      }
      const script = document.createElement('script'); script.type = 'module';
      script.src = moduleURLs['src/app.js']; document.head.append(script);
    }""", files)
    page.wait_for_function('!!window.__orbit')


def run(browser, mount, name):
    page = browser.new_page(viewport={'width': 1366, 'height': 850}, device_scale_factor=1)
    errors, results = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('requestfailed', lambda r: errors.append(r.url + ': ' + str(r.failure)))
    mount(page)
    snap = lambda: page.evaluate('window.__orbit.snapshot()')
    def check(label, condition):
        assert condition, f'{name}: {label}; {snap()}'
        results.append(label)
        print(f'PASS {name}: {label}', flush=True)
    def body_focus():
        page.evaluate('document.activeElement.blur()')
    def silence():
        page.keyboard.press('Escape')
        page.wait_for_timeout(130)
    check('No audio context before first interaction', page.evaluate('__orbit.synth === null'))
    page.screenshot(path=str(OUT / f'{name}-entry.png'))
    # Actual first note, not a synthetic click-through autoplay bypass.
    page.keyboard.down('q')
    page.wait_for_function('__orbit.snapshot().ready && __orbit.snapshot().sources === 1')
    check('First letter activates audio and sounds', snap()['voices'] == 1)
    page.keyboard.up('q'); silence()
    page.screenshot(path=str(OUT / f'{name}-desktop.png'), full_page=True)
    check('26 playable physical keys', page.locator('.key:visible').count() == 26)
    bounds = page.evaluate("""() => ['KeyQ','KeyA','KeyZ'].map(code => {
      const r = document.querySelector(`[data-code=${code}]`).getBoundingClientRect(); return {x:r.x,width:r.width};
    })""")
    check('Keyboard rows have equal keys and real staggering', bounds[0]['x'] < bounds[1]['x'] < bounds[2]['x'] and max(b['width'] for b in bounds) - min(b['width'] for b in bounds) < 1)
    for key in 'qwertasdfg': page.keyboard.down(key)
    check('Ten simultaneous physical keys / polyphony', snap()['sources'] == 10 and snap()['voices'] >= 20)
    page.screenshot(path=str(OUT / f'{name}-playing.png'))
    before = snap()['voices']
    page.keyboard.down('q'); page.keyboard.down('q')
    check('Operating-system key repeat does not retrigger', snap()['voices'] == before)
    page.click('#presetBank button:nth-child(4)'); body_focus()
    check('Preset switch leaves held voices stable', snap()['sources'] == 10)
    for key in 'qwertasdfg': page.keyboard.up(key)
    check('Simultaneous key-up clears held sources', snap()['sources'] == 0)
    silence()
    page.keyboard.down('Space'); page.keyboard.down('a'); page.keyboard.up('a')
    check('Space pedal sustains released chord', snap()['sustain'] and snap()['sources'] == 1)
    page.keyboard.down('a'); page.keyboard.up('a'); page.keyboard.up('Space')
    check('Sustain up clears retriggered notes', not snap()['sustain'] and snap()['sources'] == 0)
    page.keyboard.down('Shift'); page.keyboard.down('q')
    check('Shift raises expression while playing', snap()['expression'])
    page.keyboard.up('Shift'); page.keyboard.up('q')
    check('Shift release resets expression', not snap()['expression'])
    page.keyboard.down('a'); page.keyboard.down('q'); page.select_option('#root', '7'); body_focus()
    check('Root switch releases original voice IDs safely', snap()['sources'] == 0)
    page.keyboard.up('a'); page.keyboard.up('q'); page.select_option('#scale', 'dorian'); body_focus()
    page.select_option('#scale', 'chromatic'); body_focus()
    check('Chromatic adds both missing semitone keys', page.locator('.key:visible').count() == 28)
    page.keyboard.down('['); page.keyboard.down(']'); check('All twelve chromatic pitches are playable', snap()['sources'] == 2)
    page.keyboard.up('['); page.keyboard.up(']'); page.select_option('#scale', 'dorian'); body_focus()
    page.keyboard.down('q'); page.keyboard.press('ArrowUp'); page.keyboard.up('q')
    check('Octave change cannot leave a held note', snap()['sources'] == 0)
    page.keyboard.down('q'); page.focus('#bpm'); page.keyboard.up('q')
    check('Key-up inside a form still releases note', snap()['sources'] == 0)
    page.keyboard.press('q'); check('Typing in form does not play notes', snap()['sources'] == 0); body_focus()
    page.select_option('#layout', 'qwertz'); body_focus()
    check('QWERTZ display matches physical Y and Z positions', page.locator('[data-code=KeyY] kbd').inner_text() == 'Z' and page.locator('[data-code=KeyZ] kbd').inner_text() == 'Y')
    page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyY',key:'z',bubbles:true}))")
    page.wait_for_timeout(30)
    check('QWERTZ input uses physical code, not the printed letter', page.locator('[data-code=KeyY]').get_attribute('aria-pressed') == 'true')
    page.evaluate("document.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyY',key:'z',bubbles:true}))")
    page.select_option('#layout', 'qwerty'); body_focus()
    silence()
    page.keyboard.press('1'); page.keyboard.down('a'); page.keyboard.down('q'); page.wait_for_timeout(180)
    check('Arp chord + live melody coexist', snap()['arp'] and snap()['sources'] == 2 and page.evaluate("[...__orbit.synth.voices.values()].some(v=>v.group==='arp')"))
    page.fill('#bpm', '137'); page.locator('#bpm').press('Enter'); body_focus()
    check('BPM updates live', page.evaluate('__orbit.performance.bpm') == 137)
    page.keyboard.press('1'); page.keyboard.up('a'); page.keyboard.up('q'); silence()
    page.keyboard.press('2'); check('Recording arms without empty leading silence', snap()['recording'] == 'armed')
    for key in ['q','w','e']:
        page.keyboard.down(key); page.wait_for_timeout(90); page.keyboard.up(key); page.wait_for_timeout(40)
    page.keyboard.press('2'); page.wait_for_timeout(70)
    check('Record / finish immediately creates playing loop', snap()['recording'] == 'ready' and snap()['events'] == 3 and snap()['looping'])
    check('Phrase length is a whole bar', page.evaluate('__orbit.performance.loopBeats % 4 === 0'))
    page.keyboard.down('z'); check('Live bass can play over recorded loop', snap()['sources'] == 1 and snap()['looping']); page.keyboard.up('z')
    page.keyboard.press('3'); check('Loop pause does not lose phrase', not snap()['looping'] and snap()['events'] == 3)
    page.keyboard.press('3'); page.wait_for_timeout(100)
    page.keyboard.down('Space'); page.keyboard.down('a'); page.keyboard.up('a')
    page.evaluate("window.dispatchEvent(new Event('blur'))")
    page.keyboard.up('Space'); page.wait_for_timeout(130)
    check('Blur clears sustain, loop and all voices', snap()['sources'] == 0 and snap()['voices'] == 0 and not snap()['looping'] and not snap()['sustain'])
    page.keyboard.press('4'); check('Clear loop discards only the phrase', snap()['events'] == 0)
    for _ in range(36): page.keyboard.press('q')
    silence(); check('Fast re-articulation + panic leaves no voices', snap()['voices'] == 0 and snap()['held'] == 0)
    for key in 'qwertyuiopasdfghjklzxcvbnm': page.keyboard.down(key)
    check('All keys are bounded by 48 synth voices', snap()['sources'] == 26 and snap()['voices'] <= 48)
    for key in 'qwertyuiopasdfghjklzxcvbnm': page.keyboard.up(key)
    silence()
    peak = page.evaluate('''() => {const a = new Float32Array(512); __orbit.synth.analyser.getFloatTimeDomainData(a); return Math.max(...a.map(Math.abs));}''')
    check('Panic also clears delay and reverb tails', peak < .0001)
    page.keyboard.down('q'); page.keyboard.press('Control'); page.keyboard.up('q'); silence()
    check('Browser modifier shortcuts cannot leave notes behind', snap()['sources'] == 0)
    page.evaluate('__orbit.synth.ctx.suspend()'); page.wait_for_timeout(80)
    check('Context suspension resets instrument', not snap()['ready'])
    page.keyboard.down('q'); page.wait_for_function('__orbit.snapshot().ready && __orbit.snapshot().sources === 1')
    check('Audio resumes after suspension without stale activation promise', snap()['voices'] == 1)
    page.keyboard.up('q'); silence()
    box = page.locator('[data-code=KeyA]').bounding_box()
    page.mouse.move(box['x']+10, box['y']+10); page.mouse.down()
    check('Pointer attack is playable', snap()['sources'] == 1)
    other = page.locator('[data-code=KeyS]').bounding_box()
    page.mouse.move(other['x']+10, other['y']+10)
    check('Pointer slide changes note without a stuck old chord', snap()['sources'] == 1)
    page.mouse.up(); check('Captured pointer release clears note', snap()['sources'] == 0)
    silence()
    for width in [320, 390, 768, 1024, 1440]:
        page.set_viewport_size({'width': width, 'height': 900})
        check(f'No horizontal overflow at {width}px', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
    page.set_viewport_size({'width': 390, 'height': 844}); page.wait_for_timeout(100)
    page.screenshot(path=str(OUT / f'{name}-mobile.png'), full_page=True)
    # Offline rendering exercises the actual oscillators, filters, FX and limiter in each engine.
    audio = page.evaluate("""async () => {
      const {Synth,PRESETS} = await import(window.moduleURLs?.['src/audio.js'] || new URL('src/audio.js',document.baseURI).href);
      const results=[];
      for(let preset=0;preset<PRESETS.length;preset++) {
        const rate=44100, ctx=new OfflineAudioContext(2,rate*6,rate), engine=new Synth(ctx);
        engine.setVolume(1);
        for(const midi of [48,55,60,63,67,72]) engine.play(midi,{preset,when:.02,duration:.9,velocity:.72});
        const output=await ctx.startRendering(); let peak=0,squares=0,tail=0,finite=true;
        for(let c=0;c<2;c++) {
          const data=output.getChannelData(c);
          for(let i=0;i<data.length;i++) {const v=data[i];finite=finite&&Number.isFinite(v);peak=Math.max(peak,Math.abs(v)); if(i<rate) squares+=v*v; if(i>rate*5.5)tail=Math.max(tail,Math.abs(v));}
        }
        results.push({preset:PRESETS[preset].name,peak,rms:Math.sqrt(squares/(rate*2)),tail,finite,voices:engine.voices.size});
      }
      return results;
    }""")
    for sound in audio:
        check(f"Audio render {sound['preset']}: audible, finite, no clipping, voices cleaned", sound['finite'] and .005 < sound['rms'] < .6 and sound['peak'] < .941 and sound['tail'] < .004 and sound['voices'] == 0)
    check('Preset loudness stays in a controlled range', max(s['rms'] for s in audio) / min(s['rms'] for s in audio) < 2.8)
    print('AUDIO ' + json.dumps(audio), flush=True)
    check('No console errors or failed resource requests', not errors)
    report = {'browser': name, 'checks': results, 'audio': audio, 'errors': errors, 'snapshot': snap()}
    (OUT / f'{name}.json').write_text(json.dumps(report, indent=2))
    page.close()
    return len(results)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', choices=['chromium','firefox','webkit','chrome','msedge'], default='chromium')
    parser.add_argument('--executable')
    parser.add_argument('--embedded', action='store_true')
    parser.add_argument('--base-url')
    args = parser.parse_args()
    server, temp = None, None
    if args.embedded:
        mount = embedded_mount
    else:
        base = args.base_url
        if not base:
            temp = tempfile.TemporaryDirectory()
            os.symlink(ROOT, Path(temp.name) / 'misc', target_is_directory=True)
            handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=temp.name)
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            base = f'http://127.0.0.1:{server.server_port}/misc/'
        def mount(page):
            response = page.goto(base.rstrip('/') + '/?test=1', wait_until='networkidle')
            assert response.status == 200, f'Site returned {response.status}'
            page.wait_for_function('!!window.__orbit')
    try:
        with sync_playwright() as p:
            engine = getattr(p, 'chromium' if args.browser in ['chrome','msedge'] else args.browser)
            options = {'headless': True}
            if args.executable: options['executable_path'] = args.executable
            if args.browser in ['chrome','msedge']: options['channel'] = args.browser
            browser = engine.launch(**options)
            try:
                count = run(browser, mount, args.browser)
                print(f'ALL {count} BROWSER CHECKS PASSED: {args.browser}', flush=True)
            finally:
                browser.close()
    finally:
        if server: server.shutdown()
        if temp: temp.cleanup()

if __name__ == '__main__': main()
