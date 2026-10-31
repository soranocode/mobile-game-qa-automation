import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
import rag


class FakeEmbedding:
    def __init__(self):
        self.calls = 0

    def embed(self, documents, **kwargs):
        self.calls += len(documents)
        return [[1.] + [0.] * 383 for _ in documents]


class FakeTokenizer:
    def __init__(self, limit=10000):
        self.limit = limit

    def encode(self, text):
        return SimpleNamespace(overflowing=len(text) > self.limit)


class FakeCollection:
    def __init__(self):
        self.rows = {}

    def get(self, **kwargs):
        return {'ids': list(self.rows), 'metadatas': [r['metadata'] for r in self.rows.values()]}

    def upsert(self, *, ids, metadatas, documents, embeddings):
        self.rows.update({id: {'metadata': meta, 'document': text} for id, meta, text in zip(ids, metadatas, documents)})

    def delete(self, ids):
        for id in ids:
            del self.rows[id]

    def count(self):
        return len(self.rows)

    def query(self, **kwargs):
        return {'metadatas': [[r['metadata'] for r in self.rows.values()]], 'distances': [[.1] * len(self.rows)]}


class FakeClient:
    def __init__(self):
        self.collection = FakeCollection()

    def get_or_create_collection(self, *args, **kwargs):
        return self.collection

    get_collection = get_or_create_collection


class RagTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.root = self.repo / 'knowledge'
        self.root.mkdir()
        (self.repo / 'config').mkdir()
        self.config = rag.load_config()
        (self.repo / 'config/rag.json').write_text(json.dumps(self.config), encoding='utf-8')
        self.index = {'records': [
            {'id': 'CARD-A', 'path': 'a.md', 'kind': 'skill', 'title': 'Inventory',
             'aliases': ['inventory_alias'], 'status': 'HUMAN_APPROVED_SCOPED', 'tags': ['inventory']},
            {'id': 'CARD-B', 'path': 'b.md', 'kind': 'mechanic', 'title': 'Hook',
             'aliases': ['hook_alias'], 'status': 'SOURCE_REVIEWED', 'tags': ['hook']}], 'routes': {}}
        self.save_index()
        (self.root / 'a.md').write_text('# Inventory\nUse one item.\n## Stop\nDo not replay consumption.\n', encoding='utf-8')
        (self.root / 'b.md').write_text('# Hook\nAim at current target.\n', encoding='utf-8')
        self.embedding, self.client = FakeEmbedding(), FakeClient()
        self.rag = rag.Rag(repo=self.repo, root=self.root, embedder=self.embedding, client=self.client, tokenizer=FakeTokenizer())

    def save_index(self):
        (self.root / 'index.json').write_text(json.dumps(self.index), encoding='utf-8')

    def test_exact_alias_requires_no_embedding_or_chroma_index(self):
        result = self.rag.search('inventory_alias', context=True)
        self.assertEqual(result['mode'], 'exact')
        self.assertEqual(result['results'][0]['id'], 'CARD-A')
        self.assertEqual(self.embedding.calls, 0)
        self.assertFalse(result['execution_authorized'])
        self.assertIn('Do not replay', result['context'][0]['text'])

    def test_incremental_sync_embeds_only_changed_chunks(self):
        first = self.rag.sync()
        self.assertGreater(first['embedded_chunks'], 0)
        self.assertEqual(self.rag.sync()['embedded_chunks'], 0)
        (self.root / 'b.md').write_text('# Hook\nA revised instruction.\n', encoding='utf-8')
        update = self.rag.sync()
        self.assertGreater(update['embedded_chunks'], 0)
        self.assertLess(update['embedded_chunks'], first['embedded_chunks'])

    def test_current_source_change_is_not_returned_as_fresh_semantic_evidence(self):
        self.rag.sync()
        (self.root / 'a.md').write_text('Changed after indexing', encoding='utf-8')
        result = self.rag.search('new formulation', semantic_only=True)
        self.assertIn('CARD-A', result['stale_card_ids'])
        self.assertNotIn('CARD-A', [r['id'] for r in result['results']])

    def test_metadata_change_requires_sync_before_vector_search(self):
        self.rag.sync()
        self.index['records'][0]['status'] = 'REVOKED'
        self.save_index()
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.rag.search('new formulation')

    def test_removed_cards_are_deleted_from_vector_store(self):
        self.rag.sync()
        self.index['records'] = self.index['records'][:1]
        self.save_index()
        (self.root / 'b.md').unlink()
        self.assertGreater(self.rag.sync()['removed_chunks'], 0)
        self.assertTrue(all(r['metadata']['card_id'] == 'CARD-A' for r in self.client.collection.rows.values()))

    def test_proposals_are_excluded_and_source_status_is_preserved(self):
        self.index['records'][1]['status'] = 'PROPOSED unverified'
        self.save_index()
        self.assertEqual(self.rag.sync()['cards'], 1)
        result = self.rag.search('inventory_alias')
        self.assertEqual(result['results'][0]['status'], 'HUMAN_APPROVED_SCOPED')
        self.assertTrue(result['requires_source_review'])

    def test_context_limit_never_truncates_stop_rules(self):
        (self.root / 'a.md').write_text('Important context ' * 100 + '\nStop on new error.', encoding='utf-8')
        result = self.rag.search('inventory_alias', context=True, max_chars=1000)
        self.assertEqual(result['status'], 'NEEDS_SPLIT')
        self.assertIsNone(result['context'])

    def test_interrupted_sync_blocks_vector_reads_until_repaired(self):
        self.rag.sync()
        (self.rag.folder / 'incomplete-sync').touch()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.rag.search('new formulation')
        self.rag.sync()
        self.assertEqual(self.rag.search('new formulation')['status'], 'DISCOVERY_CANDIDATES')

    def test_model_change_does_not_reuse_old_collection(self):
        self.rag.sync()
        config = copy.deepcopy(self.config)
        config['model'] = 'different-model'
        (self.repo / 'config/rag.json').write_text(json.dumps(config), encoding='utf-8')
        other = rag.Rag(repo=self.repo, root=self.root, embedder=self.embedding, client=self.client)
        with self.assertRaisesRegex(ValueError, 'changed'):
            other.search('new formulation')

    def test_escaped_card_path_is_refused(self):
        self.index['records'][0]['path'] = '../outside.md'
        self.save_index()
        with self.assertRaises(ValueError):
            self.rag.search('inventory_alias')

    def test_token_boundaries_preserve_ending_constraints(self):
        text = 'Начало и подробности ' * 30 + 'Не повторять расход предмета.'
        parts = rag.token_safe_parts(text, FakeTokenizer(80))
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(len(p) <= 80 for p in parts))
        self.assertTrue(any('Не повторять расход предмета.' in p for p in parts))
        self.assertTrue(text.startswith(parts[0]))
        self.assertTrue(text.endswith(parts[-1]))

    def test_kind_limits_candidates_without_changing_their_approval(self):
        self.rag.sync()
        result = self.rag.search('new formulation', kind='mechanic', semantic_only=True)
        self.assertEqual([r['id'] for r in result['results']], ['CARD-B'])
        self.assertEqual(result['results'][0]['status'], 'SOURCE_REVIEWED')
        self.assertFalse(result['execution_authorized'])


if __name__ == '__main__':
    unittest.main()
