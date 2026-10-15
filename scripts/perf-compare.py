#!/usr/bin/env python3
"""Alternate release builds on identical cloned fixtures and real X11 gestures."""

import argparse
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, required=True)
    parser.add_argument('--seed', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--display', required=True)
    parser.add_argument('--repeats', type=int, default=5)
    parser.add_argument('--turns', type=int, default=30)
    parser.add_argument('--navigation', choices=['click', 'key'], default='key')
    parser.add_argument('--chats', choices=['closed', 'short', 'long'], nargs='+', default=['closed', 'long'])
    args = parser.parse_args()
    if args.repeats < 1 or args.turns < 1:
        parser.error('repeats and turns must be positive')
    args.out.mkdir(parents=True, exist_ok=False)
    runs = []
    driver = Path(__file__).with_name('perf-session.py')
    for repeat in range(args.repeats):
        for chat in args.chats:
            for side in ['before', 'after']:
                out = args.out / f'{chat}-{side}-{repeat}'
                command = [sys.executable, str(driver), '--binary', str(getattr(args, side)),
                           '--seed', str(args.seed), '--out', str(out),
                           '--display', args.display, '--chat', chat,
                           '--turns', str(args.turns), '--navigation', args.navigation]
                load = os.getloadavg()
                with (args.out / f'{out.name}.log').open('w') as log:
                    completed = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
                entry = {'chat': chat, 'side': side, 'repeat': repeat, 'loadBefore': load,
                         'exitCode': completed.returncode, 'path': str(out)}
                runs.append(entry)
                (args.out / 'runs.json').write_text(json.dumps(runs, indent=2))
                print(json.dumps(entry), flush=True)
                if completed.returncode:
                    raise SystemExit(completed.returncode)
    summaries = []
    for chat in args.chats:
        for side in ['before', 'after']:
            measurements = []
            for run in runs:
                if run['chat'] != chat or run['side'] != side:
                    continue
                result = json.loads((Path(run['path']) / 'result.json').read_text())
                clicks = [turn['inputToObservedCompletionMs'] for turn in result['turns']]
                paints = [sample['inputToFirstPixelChangeMs']
                          for sample in result['hoverPaintSamples']]
                visible = [event['dur'] for turn in result['turns'] for event in turn['events']
                           if event['name'] == 'pdf:spread-ready']
                measurements.append({
                    'sha256': result['binarySha256'], 'readerWidth': result['readerWidth'],
                    'turns': len(clicks), 'hoverPaints': len(paints),
                    'inputMedianMs': statistics.median(clicks),
                    'inputP95Ms': percentile(clicks, .95), 'inputMaxMs': max(clicks),
                    'spreadMedianMs': statistics.median(visible),
                    'hoverPaintMedianMs': statistics.median(paints),
                    'hoverPaintP95Ms': percentile(paints, .95), 'hoverPaintMaxMs': max(paints),
                    'errors': len(result['errors']), 'harnessCpuSeconds': result['harnessCpuSeconds'],
                })
            summary = {'chat': chat, 'side': side, 'runs': measurements}
            for field in ['inputMedianMs', 'inputP95Ms', 'spreadMedianMs',
                          'hoverPaintMedianMs', 'hoverPaintP95Ms']:
                values = [run[field] for run in measurements]
                summary[field] = {'median': statistics.median(values),
                                  'range': [min(values), max(values)]}
            summaries.append(summary)
    (args.out / 'summary.json').write_text(json.dumps(summaries, indent=2))
    print(json.dumps(summaries), flush=True)


if __name__ == '__main__':
    main()
