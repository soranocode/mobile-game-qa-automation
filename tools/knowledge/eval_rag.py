"""Evaluate retrieval only against the authored smoke set; no LLM or game commands."""
import json
from datetime import datetime, timezone

from rag import Rag, REPO, encoded, sha, PREPROCESSING


def main():
    cases = json.loads((REPO / 'config/rag-eval.json').read_text(encoding='utf-8'))['cases']
    engine = Rag()
    results = []
    for case in cases:
        for mode in ['semantic', 'hybrid']:
            answer = engine.search(case['query'], limit=3, semantic_only=mode == 'semantic')
            ids = [r['id'] for r in answer['results']]
            results.append({'query': case['query'], 'mode': mode, 'ids': ids,
                            'hit_at_3': bool(set(ids) & set(case['expected_any'])),
                            'seconds': answer['seconds'],
                            'source_hashes': {r['id']: r['source_sha256'] for r in answer['results']},
                            'distances': [r['distance'] for r in answer['results']]})
    payload = {'scope': 'Authored retrieval smoke only; no gameplay or general accuracy claim',
               'created_at': datetime.now(timezone.utc).isoformat(),
               'provenance': {'manifest': json.loads(engine.manifest_path.read_text(encoding='utf-8')),
                   'preprocessing': PREPROCESSING,
                   'retriever_sha256': sha((REPO / 'tools/knowledge/rag.py').read_bytes()),
                   'cases_sha256': sha((REPO / 'config/rag-eval.json').read_bytes())},
               'results': results, 'execution_authorized': False}
    path = REPO / 'brain-store/rag/retrieval-smoke.json'
    path.write_bytes(encoded(payload))
    print(json.dumps({'cases': len(cases),
        'semantic_hit_at_3': sum(r['hit_at_3'] for r in results if r['mode'] == 'semantic'),
        'hybrid_hit_at_3': sum(r['hit_at_3'] for r in results if r['mode'] == 'hybrid'),
        'evidence': path.relative_to(REPO).as_posix(), 'gameplay_started': False}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
