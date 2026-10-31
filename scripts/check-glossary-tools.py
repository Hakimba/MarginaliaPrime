#!/usr/bin/env python3
"""Verify glossary persistence, permissions and concurrency on a compiled reader."""

import argparse
import concurrent.futures
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    records = []

    def tool(index, name, arguments):
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                   'params': {'name': name, 'arguments': arguments}}
        result = subprocess.run([str(binary), '--reader-tools', str(index)],
                                input=json.dumps(request) + '\n', text=True,
                                capture_output=True, timeout=20, check=True)
        response = json.loads(result.stdout)['result']
        return response

    with tempfile.TemporaryDirectory(prefix='marginalia-glossary-release-') as directory:
        index = Path(directory) / 'book.json'
        state = index.with_suffix('.state.json')
        glossary = index.with_suffix('.glossary.json')

        def entry(term, page=2):
            return {'term': term, 'latex': '\\top' if term == '⊤' else '',
                    'explanation': 'Une proposition toujours vraie.', 'page': page}

        def checked(name, arguments):
            result = tool(index, name, arguments)
            assert not result.get('isError'), result
            records.append({'name': name, 'arguments': arguments, 'result': result})
            return json.loads(result['content'][0]['text'])

        assert checked('get_glossary', {}) == []
        assert checked('add_to_glossary', entry('⊤'))[0]['term'] == '⊤'
        assert len(checked('add_to_glossary', entry('⊤'))) == 1
        assert len(checked('add_to_glossary', entry('⊤', 20))) == 1
        assert len(checked('get_glossary', {'query': '⊤'})) == 2
        assert tool(index.with_name('other.json'), 'get_glossary', {})['content'][0]['text'] == '[]'
        state.write_text(json.dumps({'maxPage': 2}))
        assert [item['page'] for item in checked('get_glossary', {})] == [2]
        saved = checked('add_to_glossary', entry('⊤', 20))
        assert len(saved) == 1 and saved[0]['page'] == 20
        assert [item['page'] for item in checked('get_glossary', {})] == [2]
        state.write_text(json.dumps({'maxPage': 2, 'allowedWindow': [20, 21]}))
        assert len(checked('get_glossary', {})) == 2
        state.write_text(json.dumps({'maxPage': 2}))
        assert len(checked('get_glossary', {})) == 1
        state.write_text(json.dumps({'maxPage': 2, 'spoilersAllowed': True}))
        assert len(checked('get_glossary', {})) == 2
        index.write_text(json.dumps({'pageCount': 30, 'complete': False}))
        assert tool(index, 'add_to_glossary', entry('outside', 31)).get('isError')

        def add_parallel(number):
            result = tool(index, 'add_to_glossary', entry(f'term {number}'))
            assert not result.get('isError'), result

        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            list(pool.map(add_parallel, range(24)))
        assert len(checked('get_glossary', {})) == 26
        assert len(json.loads(glossary.read_text())) == 26
        before = glossary.read_bytes()
        for bad in [dict(entry(''), page=2), dict(entry('bad'), page=0),
                    dict(entry('bad'), date=1), dict(entry('bad'), explanation=' '),
                    dict(entry('bad'), term='x' * 201)]:
            assert tool(index, 'add_to_glossary', bad).get('isError')
            assert glossary.read_bytes() == before
        state.write_text('{broken')
        assert tool(index, 'get_glossary', {}).get('isError')
        saved = tool(index, 'add_to_glossary', entry('known-content'))
        assert not saved.get('isError')
        assert [item['term'] for item in json.loads(saved['content'][0]['text'])] == ['known-content']
        state.write_text('{}')
        glossary.write_text('{broken')
        assert tool(index, 'get_glossary', {}).get('isError')
        assert tool(index, 'add_to_glossary', entry('bad')).get('isError')
        assert glossary.read_text() == '{broken'

    (args.out / 'protocol.json').write_text(json.dumps(records, ensure_ascii=False, indent=2))
    result = {'passed': True, 'concurrentProcesses': 24, 'entriesPreserved': 26,
              'checks': ['no-index', 'upsert', 'distinct-senses', 'book-isolation',
                         'permissions', 'partial-index', 'concurrent-writes',
                         'strict-inputs', 'corrupt-state', 'corrupt-storage']}
    (args.out / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
