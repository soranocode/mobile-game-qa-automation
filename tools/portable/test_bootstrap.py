import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('portable_bootstrap',Path(__file__).with_name('bootstrap.py'))
bootstrap=importlib.util.module_from_spec(spec);spec.loader.exec_module(bootstrap)


class SetupTests(unittest.TestCase):
    def test_only_loopback_endpoint_without_credentials_is_accepted(self):
        self.assertTrue(bootstrap.endpoint_ok('http://127.0.0.1:8080/mcp'))
        for value in ['https://example.com/mcp','http://u:p@localhost:8080/mcp','http://localhost:8080/mcp?token=example']:
            self.assertFalse(bootstrap.endpoint_ok(value))

    def test_a_folder_without_unity_project_cannot_be_selected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError,'Unity project'):
                bootstrap.local_config(folder,'http://127.0.0.1:8080/mcp')

    def test_local_paths_are_resolved_without_touching_game_files(self):
        with tempfile.TemporaryDirectory() as folder:
            game=Path(folder);(game/'Assets').mkdir();(game/'ProjectSettings').mkdir()
            marker=game/'ProjectSettings/ProjectVersion.txt';marker.write_text('m_EditorVersion: 6000.0.66f2\n')
            before=marker.read_bytes()
            config=bootstrap.local_config(game,'http://127.0.0.1:8080/mcp')
            self.assertEqual(config['gameProject'],str(game.resolve()))
            self.assertEqual(marker.read_bytes(),before)
            self.assertEqual(len(list(game.rglob('*'))),3)


if __name__=='__main__':unittest.main()
