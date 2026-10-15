#!/usr/bin/env python3

import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import unittest


class TestProcessIsolation(unittest.TestCase):
    def test_scripts_stop_their_children_and_preserve_another_reader(self):
        scripts = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sentinel_binary = root / 'Marginalia'
            shutil.copyfile('/bin/sleep', sentinel_binary)
            sentinel_binary.chmod(0o755)
            sentinel = subprocess.Popen([str(sentinel_binary), '60'], start_new_session=True)
            runner = root / 'runner'
            runner.write_text(
                '#!/usr/bin/env bash\n'
                'echo \'[perf] fixture {"t":1}\'\n'
                'echo \'[perf] library:ready {"t":2}\'\n'
                'echo "smoke: scenario done"\n'
                'echo "[sel] probe done"\n'
                'sleep 60 &\n'
                'echo $! > "$TEST_CHILD_PID"\n'
                'wait\n'
            )
            runner.chmod(0o755)
            try:
                for script, arguments in [
                    ('perf-run.sh', ['fixture', str(runner), '', '1']),
                    ('smoke-chat.sh', ['fixture', 'wait:1', '1']),
                    ('selection-probe.sh', ['fixture', '1', '1']),
                ]:
                    child_file = root / 'child.pid'
                    env = dict(os.environ, MARGINALIA_TEST_BINARY=str(runner),
                               TEST_CHILD_PID=str(child_file),
                               MARGINALIA_TEST_LOG=str(root / f'{script}.log'))
                    result = subprocess.run(['bash', str(scripts / script), *arguments],
                                            env=env, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIsNone(sentinel.poll(), f'{script} stopped an unrelated reader')
                    child = int(child_file.read_text())
                    stat = Path(f'/proc/{child}/stat')
                    if stat.exists():
                        self.assertEqual(stat.read_text().rsplit(')', 1)[1].split()[0], 'Z',
                                         f'{script} left its child running')
                runner.write_text('#!/usr/bin/env bash\nsleep 60\n')
                for script, arguments in [
                    ('perf-run.sh', ['fixture', str(runner), '', '1']),
                    ('smoke-chat.sh', ['fixture', 'wait:1', '1']),
                    ('selection-probe.sh', ['fixture', '1', '1']),
                ]:
                    result = subprocess.run(['bash', str(scripts / script), *arguments],
                                            env=env, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 1, f'{script} accepted an incomplete run')
                    self.assertIsNone(sentinel.poll())
            finally:
                os.killpg(sentinel.pid, signal.SIGTERM)
                sentinel.wait()


if __name__ == '__main__':
    unittest.main()
