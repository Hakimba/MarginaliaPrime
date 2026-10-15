#!/usr/bin/env python3
"""Measure real navigation and hover events on an isolated X11 display."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import subprocess
import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

sys.dont_write_bytecode = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--seed', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--display', required=True)
    parser.add_argument('--book', default='6b580313df6b86fc70c318b78edb7226')
    parser.add_argument('--chat', choices=['closed', 'short', 'long'], default='closed')
    parser.add_argument('--spread', choices=['single', 'double'], default='single')
    parser.add_argument('--index', choices=['complete', 'build'], default='complete')
    parser.add_argument('--turns', type=int, default=30)
    parser.add_argument('--navigation', choices=['click', 'key'], default='click')
    parser.add_argument('--width', type=int, default=1300)
    parser.add_argument('--height', type=int, default=900)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    seed = args.seed.resolve()
    xdg = (args.out / 'xdg').resolve()
    shutil.copytree(seed, xdg)
    data = xdg / 'data/com.eddmann.marginalia'
    config = data / f'Marginalia/Books/{args.book}/config.json'
    book_config = json.loads(config.read_text())
    book_config.update(location='epubcfi(/6/60)', progress=[30, 417])
    book_config.setdefault('viewSettings', {})['spreadMode'] = (
        'none' if args.spread == 'single' else 'auto'
    )
    config.write_text(json.dumps(book_config))
    for settings in (xdg / 'config').rglob('settings.json*'):
        settings.write_text(settings.read_text().replace(str(seed), str(xdg)))
    if args.index == 'build':
        (data / f'index/{args.book}.json').unlink(missing_ok=True)
    if args.chat != 'closed':
        chat_dir = data / f'chats/{args.book}'
        chat_dir.mkdir(parents=True, exist_ok=True)
        pairs = 2 if args.chat == 'short' else 40
        content = ('Une explication de la matrice $A$ et de ses vecteurs.\n\n' * 25)
        messages = [
            {'role': role, 'content': content, 'timestamp': n}
            for n in range(pairs) for role in ['user', 'assistant']
        ]
        (chat_dir / 'perf.jsonl').write_text('\n'.join(map(json.dumps, messages)))
        (chat_dir / 'conversations.json').write_text(json.dumps([{
            'id': 'perf', 'name': 'Performance', 'createdAt': 0,
            'lastMessageAt': 1, 'messageCount': len(messages),
        }]))
    env = os.environ.copy()
    env.update(
        DISPLAY=args.display, WAYLAND_DISPLAY='', GDK_BACKEND='x11',
        GTK_IM_MODULE='gtk-im-context-simple', GTK_USE_PORTAL='0', NO_AT_BRIDGE='1',
        GIO_USE_VFS='local', MARGINALIA_PERF='1', MARGINALIA_PERF_OPEN=args.book,
        XDG_DATA_HOME=str(xdg / 'data'), XDG_CONFIG_HOME=str(xdg / 'config'),
        XDG_CACHE_HOME=str(xdg / 'cache'),
    )
    env.pop('MARGINALIA_SMOKE_ASK', None)
    if args.chat != 'closed':
        env['MARGINALIA_SMOKE_ASK'] = 'wait:600000'
    spec = importlib.util.spec_from_file_location('ui_drive', Path(__file__).with_name('ui-drive.py'))
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)
    dsp = display.Display(args.display)
    xtest.fake_input(dsp, X.MotionNotify, x=dsp.screen().width_in_pixels - 1,
                     y=dsp.screen().height_in_pixels - 1)
    dsp.sync()
    events = []
    offset = 0
    seen = set()
    log_path = args.out / 'app.log'
    pattern = re.compile(r'\[perf\] (\S+) (\{.*\})')

    def poll():
        nonlocal offset
        with log_path.open() as source:
            source.seek(offset)
            for line in source:
                match = pattern.search(line)
                if match:
                    event = json.loads(match[2])
                    identity = (match[1], match[2])
                    if identity not in seen:
                        seen.add(identity)
                        events.append({'name': match[1], **event})
            offset = source.tell()

    def wait_for(predicate, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            poll()
            if predicate():
                return
            if process.poll() is not None:
                raise RuntimeError(f'Application exited with {process.returncode}')
            time.sleep(0.02)
        raise TimeoutError('Expected event did not occur; see app.log')

    def successful_spread(event):
        return (event['name'] == 'pdf:spread-ready' and event.get('renders')
                and all(render and render.get('status') == 'completed'
                        for render in event['renders']))

    binary_sha256 = hashlib.sha256(args.binary.read_bytes()).hexdigest()
    cpu_start = resource.getrusage(resource.RUSAGE_SELF).ru_utime
    start = time.monotonic()
    result = {'conditions': vars(args).copy(), 'status': 'failed'}
    result['binarySha256'] = binary_sha256
    result['turns'] = []
    result['hoverPaintSamples'] = []
    result['processSamples'] = []
    result['conditions'] = {k: str(v) if isinstance(v, Path) else v for k, v in result['conditions'].items()}

    def sample_processes(phase):
        rows = subprocess.check_output(
            ['ps', '-eo', 'pid=,ppid=,rss=,comm='], text=True
        ).splitlines()
        processes = []
        for row in rows:
            pid, parent, rss, command = row.split(None, 3)
            processes.append({'pid': int(pid), 'parent': int(parent),
                              'rssKiB': int(rss), 'command': command})
        owned = {process.pid}
        while True:
            children = {p['pid'] for p in processes if p['parent'] in owned}
            if children <= owned:
                break
            owned.update(children)
        result['processSamples'].append({
            'phase': phase, 'turnsCompleted': len(result['turns']),
            'processes': [p for p in processes if p['pid'] in owned],
        })

    with log_path.open('w') as output:
        process = subprocess.Popen([str(args.binary.resolve())], env=env, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            wait_for(lambda: any(successful_spread(e) for e in events), 60)
            window = driver.find_window(dsp)
            configured_at = len(events)
            window.configure(width=args.width, height=args.height)
            dsp.sync()
            if args.chat != 'closed':
                wait_for(lambda: any(e['name'] == 'chat:panel-open'
                                     and e['window'] == args.width and e['reader'] > 0
                                     for e in events[configured_at:]), 30)
                panel = [e for e in events if e['name'] == 'chat:panel-open'][-1]
                book_width = panel['reader']
                result['panelGeometry'] = panel
            else:
                book_width = args.width
            wait_for(lambda: any(e['name'] == 'pdf:layout-resize'
                                 for e in events[configured_at:]), 30)
            def viewport_ready():
                resized_at = max(e['t'] for e in events if e['name'] == 'pdf:layout-resize')
                return any(successful_spread(e) and e['t'] >= resized_at for e in events)

            wait_for(viewport_ready, 30)
            time.sleep(1)
            poll()
            result['readerWidth'] = book_width
            sample_processes('viewport-ready')
            driver.shot(dsp, window, str(args.out / 'before.png'))
            if args.navigation == 'key':
                prior = max(e['navigationId'] for e in events if e['name'] == 'pdf:navigation-start')
                driver.move(dsp, window, int(book_width * 0.95), int(args.height * 0.6))
                xtest.fake_input(dsp, X.ButtonPress, 1)
                xtest.fake_input(dsp, X.ButtonRelease, 1)
                dsp.sync()
                wait_for(lambda: any(successful_spread(e) and e['navigationId'] > prior
                                     for e in events))
                time.sleep(1)
                poll()
                result['firstMeasuredPages'] = [e['pages'] for e in events if successful_spread(e)][-1]
            right_key = dsp.keysym_to_keycode(XK.string_to_keysym('Right'))
            result['navigationEventOffset'] = len(events)
            last_completion = 0
            for _ in range(args.turns):
                time.sleep(max(0, 0.7 - (time.monotonic() - last_completion)))
                poll()
                first_event = len(events)
                previous = max(e['navigationId'] for e in events
                               if e['name'] == 'pdf:navigation-start')
                previous_pages = [e['pages'] for e in events if successful_spread(e)][-1]
                driver.move(dsp, window, int(book_width * 0.95), int(args.height * 0.6))
                click_start = time.monotonic()
                if args.navigation == 'click':
                    xtest.fake_input(dsp, X.ButtonPress, 1)
                    xtest.fake_input(dsp, X.ButtonRelease, 1)
                else:
                    xtest.fake_input(dsp, X.KeyPress, right_key)
                    xtest.fake_input(dsp, X.KeyRelease, right_key)
                dsp.sync()
                wait_for(lambda: any(successful_spread(e) and e['navigationId'] > previous
                                     and min(e['pages']) > min(previous_pages)
                                     for e in events[first_event:]))
                last_completion = time.monotonic()
                result['turns'].append({'events': events[first_event:].copy(),
                                       'inputToObservedCompletionMs':
                                       (time.monotonic() - click_start) * 1000})
                if len(result['turns']) in (50, 100):
                    sample_processes('navigation')
            result['hoverEventOffset'] = len(events)
            for _ in range(args.turns):
                driver.move(dsp, window, args.width + 20, args.height + 20)
                dsp.sync()
                time.sleep(0.4)
                baseline = window.get_image(0, args.height - 52, book_width, 52,
                                            X.ZPixmap, 0xffffffff).data
                hover_start = time.monotonic()
                driver.move(dsp, window, book_width // 2, args.height - 3)
                dsp.sync()
                deadline = hover_start + 2
                while time.monotonic() < deadline:
                    painted = window.get_image(0, args.height - 52, book_width, 52,
                                               X.ZPixmap, 0xffffffff).data
                    if painted != baseline:
                        result['hoverPaintSamples'].append({
                            'inputToFirstPixelChangeMs': (time.monotonic() - hover_start) * 1000,
                        })
                        break
                    time.sleep(0.01)
                else:
                    raise TimeoutError('Footer produced no visible change after hover')
                time.sleep(0.1)
                poll()
            time.sleep(1)
            poll()
            driver.shot(dsp, window, str(args.out / 'after.png'))
            sample_processes('after-hover')
            dsp.close()
            result['status'] = 'completed'
        except Exception as error:
            result['error'] = str(error)
            if 'dsp' in locals() and 'window' in locals():
                driver.shot(dsp, window, str(args.out / 'failure.png'))
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            poll()
    result['events'] = events
    result['errors'] = [line for line in log_path.read_text().splitlines()
                        if ('[ERROR]' in line or 'console.error:' in line or 'unhandled' in line)
                        and 'cover.png' not in line]
    result['harnessCpuSeconds'] = resource.getrusage(resource.RUSAGE_SELF).ru_utime - cpu_start
    result['elapsedSeconds'] = time.monotonic() - start
    result['traceLimitReached'] = any(e['name'] == 'perf:trace-limit' for e in events)
    (args.out / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k not in ['events', 'conditions', 'turns']}))
    if result['status'] != 'completed' or result['traceLimitReached'] or result['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
