import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('cursor_delegate', Path(__file__).with_name('delegate.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        profile = self.repo / bridge.PROFILE
        profile.parent.mkdir(parents=True)
        profile.write_text('Offline proposal worker', encoding='utf-8')
        self.source = self.repo / 'small.py'
        self.source.write_text('def example(): return 1\n', encoding='utf-8')

    def task(self, files=None):
        return bridge.prepare('Review one function', files or ['small.py'], ['Concrete evidence'], repo=self.repo)

    def response(self, callback=None, **changes):
        def call(args, **options):
            self.assertNotIn('--force', args)
            self.assertNotIn('--approve-mcps', args)
            self.assertEqual(args[args.index('--mode') + 1], 'ask')
            self.assertTrue(args[-1].startswith('Read AGENTS.md and TASK.json.'))
            self.assertNotIn('input', options)
            self.assertEqual(options['stdin'], subprocess.DEVNULL)
            self.assertEqual(options['shell'], False)
            if callback:
                callback(options)
            envelope = {'type': 'result', 'subtype': 'success', 'is_error': False,
                        'result': json.dumps({'status': 'proposal', 'summary': 'One scoped finding',
                                              'files_read': ['small.py'], 'findings': [], 'tests': 'not run'})}
            envelope.update(changes)
            return subprocess.CompletedProcess(args, 0, json.dumps(envelope), '')
        return call

    def run_task(self, task, invoke):
        return bridge.run(task['id'], repo=self.repo, launcher=['fake-agent'], invoke=invoke)

    def test_only_explicit_files_are_copied_and_tools_are_denied(self):
        (self.repo / 'unrelated.txt').write_text('unrelated', encoding='utf-8')
        task = self.task()
        workspace = self.repo / 'brain-store/cursor-tasks' / task['id'] / 'workspace'
        self.assertFalse((workspace / 'unrelated.txt').exists())
        config = json.loads((workspace / '.cursor/cli.json').read_text(encoding='utf-8'))
        self.assertIn('Mcp(*:*)', config['permissions']['deny'])
        self.assertIn('Shell(*)', config['permissions']['deny'])
        self.assertEqual(task['state'], 'prepared')

    def test_parent_paths_local_state_secrets_and_duplicates_are_rejected(self):
        for path in ['../outside.py', 'C:/outside.py', '.env', 'qa.local.json', 'conversations/a.md', 'work/a.py']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.task([path])
        with self.assertRaises(ValueError):
            self.task(['small.py', 'small.py'])

    def test_success_remains_a_proposal_and_cannot_be_dispatched_twice(self):
        task = self.task()
        result = self.run_task(task, self.response())
        self.assertEqual(result['state'], 'needs_review')
        self.assertFalse(result['accepted'])
        with self.assertRaises(ValueError):
            self.run_task(task, self.response())

    def test_stale_source_prevents_sending_any_prompt(self):
        task = self.task()
        self.source.write_text('changed', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Source changed'):
            self.run_task(task, lambda *a, **kw: self.fail('must not dispatch'))

    def test_concurrent_source_change_or_deletion_marks_result_stale(self):
        for delete in [False, True]:
            self.source.write_text('original', encoding='utf-8')
            task = self.task()
            result = self.run_task(task, self.response(lambda _: self.source.unlink() if delete else self.source.write_text('changed', encoding='utf-8')))
            self.assertEqual(result['state'], 'stale')
            self.assertFalse(result['accepted'])

    def test_snapshot_tampering_prevents_dispatch(self):
        task = self.task()
        file = self.repo / 'brain-store/cursor-tasks' / task['id'] / 'workspace/small.py'
        file.write_text('tampered', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'snapshot changed'):
            self.run_task(task, self.response())

    def test_worker_editing_snapshot_cannot_be_successful(self):
        task = self.task()
        result = self.run_task(task, self.response(lambda options: (Path(options['cwd']) / 'small.py').write_text('changed', encoding='utf-8')))
        self.assertEqual(result['state'], 'failed')

    def test_malformed_or_error_terminal_is_not_success(self):
        for changes in [{'is_error': True}, {'result': 'not JSON'}]:
            task = self.task()
            self.assertEqual(self.run_task(task, self.response(**changes))['state'], 'failed')

    def test_timeout_has_no_automatic_retry(self):
        task = self.task()
        def timeout(args, **kw):
            raise subprocess.TimeoutExpired(args, 1)
        self.assertEqual(self.run_task(task, timeout)['state'], 'failed')
        with self.assertRaises(ValueError):
            self.run_task(task, self.response())

    def test_existing_exclusive_claim_prevents_a_concurrent_dispatch(self):
        task = self.task()
        job, _ = bridge.load_task(task['id'], repo=self.repo)
        (job / 'dispatch.lock').touch()
        with self.assertRaises(FileExistsError):
            self.run_task(task, lambda *a, **kw: self.fail('must not dispatch twice'))

    def test_progress_followed_by_one_json_block_is_parsed(self):
        task = self.task()
        text = json.dumps({'status': 'proposal', 'summary': 'Scoped', 'files_read': ['small.py']})
        result = self.run_task(task, self.response(result='Reading the supplied file.```json\n'+text+'\n```'))
        self.assertEqual(result['state'], 'needs_review')
        self.assertFalse(result['accepted'])
        with self.assertRaises(ValueError):
            bridge.parse_proposal('```json\n'+text+'\n```\n```json\n'+text+'\n```')

    def test_reconciliation_reads_terminal_evidence_without_resending(self):
        task = self.task()
        self.run_task(task, self.response())
        result = bridge.reconcile(task['id'], repo=self.repo)
        self.assertTrue(result['reconciled'])
        self.assertEqual(result['state'], 'needs_review')
        self.assertFalse(result['accepted'])

    def test_reconciliation_requires_confirmed_process_completion(self):
        task = self.task()
        self.run_task(task, lambda args, **kw: subprocess.CompletedProcess(args, 1, '', 'failed'))
        with self.assertRaises(ValueError):
            bridge.reconcile(task['id'], repo=self.repo)


if __name__ == '__main__':
    unittest.main()
