"""Local Chroma discovery over curated knowledge; never authorizes or runs gameplay."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

from lookup import REPO, ROOT, normalize, score

VERSION = 'ocean-rag/1'
PREPROCESSING = 'token-safe-recursive/2'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True).encode('utf-8')


def write_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_bytes(encoded(value))
    temp.replace(path)


def load_config(repo=REPO):
    config = json.loads((repo / 'config/rag.json').read_text(encoding='utf-8'))
    if config.get('schema') != VERSION or config['dimensions'] != 384:
        raise ValueError('Unsupported RAG profile')
    if not re.fullmatch(r'[a-f0-9]{40}', config['model_revision']):
        raise ValueError('An immutable model revision is required')
    for key in ['database', 'model_cache']:
        path = Path(config[key])
        if path.is_absolute() or '..' in path.parts or not (repo / path).resolve().is_relative_to((repo / 'brain-store').resolve()):
            raise ValueError('RAG caches must stay in ignored brain-store')
    if not 1 <= config['threads'] <= 4 or not 200 <= config['chunk_chars'] <= 1000 or not 0 <= config['chunk_overlap'] < config['chunk_chars']:
        raise ValueError('Invalid local resource or chunk limits')
    return config


def source_index(root=ROOT):
    raw = (root / 'index.json').read_bytes()
    index = json.loads(raw)
    # Validate relative source paths and IDs without loading all card contents.
    ids, paths = set(), set()
    for record in index['records']:
        p = Path(record['path'])
        if record['id'] in ids or p.is_absolute() or '..' in p.parts or '\\' in record['path'] or ':' in record['path'] or not (root / p).resolve().is_relative_to(root.resolve()):
            raise ValueError('Invalid knowledge identity/path')
        if p.as_posix() in paths:
            raise ValueError('Each indexed card must have a distinct source path')
        ids.add(record['id'])
        paths.add(p.as_posix())
    for record in index['records']:
        if set(record.get('related_ids', [])) - ids:
            raise ValueError('Unknown related knowledge ID')
    for route in index.get('routes', {}).values():
        if set(route.get('first', []) + route.get('if_needed', [])) - ids:
            raise ValueError('Unknown route knowledge ID')
    return index, sha(raw)


def eligible(record, config):
    status = record.get('status', 'unknown').upper().strip()
    return not any(status.startswith(prefix) for prefix in config['excluded_status_prefixes'])


def exact_ids(query, index, records):
    query = normalize(query)
    routes = [r for name, r in index.get('routes', {}).items() if normalize(name) == query]
    if routes:
        return list(dict.fromkeys(x for route in routes for x in route.get('first', []) if x in records))
    return [r['id'] for r in records.values() if query in [normalize(r['id']), *map(normalize, r.get('aliases', []))]]


def chunks(record, text, config):
    """Discovery fragments; full cards are loaded separately without truncation."""
    section = record['title']
    sections = []
    lines = []
    for line in text.splitlines():
        if re.match(r'^#{1,4} ', line):
            if lines:
                sections.append((section, '\n'.join(lines)))
            section = line.lstrip('# ').strip()
            lines = []
        else:
            lines.append(line)
    if lines:
        sections.append((section, '\n'.join(lines)))
    prefix = record['title'] + '\n' + ' '.join(record.get('aliases', []))
    result = []
    for title, body in sections:
        body = body.strip()
        if not body:
            continue
        size, overlap = config['chunk_chars'], config['chunk_overlap']
        for start in range(0, len(body), size - overlap):
            piece = body[start:start + size]
            result.append({'section': title, 'document': prefix + '\n' + title + '\n' + piece})
            if start + size >= len(body):
                break
    if not result:
        result = [{'section': section, 'document': prefix + '\n' + text}]
    return result


def token_safe_parts(text, tokenizer):
    """Preserve all text, overlapping at word boundaries until every piece fits."""
    if not tokenizer.encode(text).overflowing:
        return [text]
    if len(text) < 40:
        raise ValueError('Cannot split text within the configured tokenizer limit')
    middle = len(text) // 2
    boundaries = [m.start() for m in re.finditer(r'\s', text) if len(text) // 4 < m.start() < 3 * len(text) // 4]
    cut = min(boundaries, key=lambda n: abs(n - middle)) if boundaries else middle
    overlap = min(12, len(text) // 10)
    return token_safe_parts(text[:cut + overlap], tokenizer) + token_safe_parts(text[cut - overlap:], tokenizer)


class Rag:
    def __init__(self, *, repo=REPO, root=ROOT, embedder=None, client=None, tokenizer=None):
        self.repo, self.root = repo, root
        self.config = load_config(repo)
        self.folder = repo / 'brain-store/rag'
        self.manifest_path = self.folder / 'manifest.json'
        self.name = 'ocean_memory_' + sha(encoded({**self.config, 'preprocessing': PREPROCESSING}))[:16]
        self._embedder, self._client = embedder, client
        self._tokenizer = tokenizer
        self._snapshot = None
        self._collection = None
        self._allow_download = False

    def model_snapshot(self):
        if self._snapshot is None:
            os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
            from huggingface_hub import snapshot_download
            from huggingface_hub.errors import LocalEntryNotFoundError
            options = dict(repo_id=self.config['model_repository'], revision=self.config['model_revision'],
                cache_dir=str(self.repo / self.config['model_cache']),
                allow_patterns=['config.json', 'model_optimized.onnx', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json'])
            try:
                self._snapshot = snapshot_download(**options, local_files_only=True)
            except LocalEntryNotFoundError:
                if not self._allow_download:
                    raise ValueError('Pinned embedding model is not cached; run explicit sync first')
                self._snapshot = snapshot_download(**options, local_files_only=False)
        return self._snapshot

    def tokenizer(self):
        if self._tokenizer is None:
            from fastembed.common.preprocessor_utils import load_tokenizer
            self._tokenizer, _ = load_tokenizer(Path(self.model_snapshot()))
        return self._tokenizer

    def embeddings(self, documents):
        if self._embedder is None:
            os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
            from fastembed import TextEmbedding
            self._embedder = TextEmbedding(model_name=self.config['model'],
                cache_dir=str(self.repo / self.config['model_cache']), threads=self.config['threads'],
                providers=['CPUExecutionProvider'], local_files_only=True, specific_model_path=self.model_snapshot())
        tokenizer = getattr(getattr(self._embedder, 'model', None), 'tokenizer', None)
        if tokenizer is not None and any(x.overflowing for x in tokenizer.encode_batch(documents)):
            raise ValueError('Embedding text exceeds the model token limit; shorten query/chunks explicitly')
        vectors = [list(map(float, x)) for x in self._embedder.embed(documents, batch_size=8)]
        if any(len(v) != self.config['dimensions'] for v in vectors):
            raise ValueError('Embedding dimensions differ from saved profile')
        return vectors

    def collection(self, create=False):
        if self._collection is None:
            if self._client is None:
                import chromadb
                from chromadb.config import Settings
                self._client = chromadb.PersistentClient(path=str(self.repo / self.config['database']),
                    settings=Settings(anonymized_telemetry=False))
            if create:
                self._collection = self._client.get_or_create_collection(self.name, embedding_function=None,
                    configuration={'hnsw': {'space': 'cosine'}})
            else:
                self._collection = self._client.get_collection(self.name, embedding_function=None)
        return self._collection

    @contextmanager
    def writer(self):
        self.folder.mkdir(parents=True, exist_ok=True)
        lock = self.folder / 'writer.lock'
        handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(handle, str(os.getpid()).encode('ascii'))
        os.close(handle)
        try:
            yield
        finally:
            lock.unlink()

    def sync(self):
        started = time.perf_counter()
        self._allow_download = True  # Downloads belong to explicit indexing, never retrieval.
        index, index_hash = source_index(self.root)
        wanted = {}
        count = 0
        for record in index['records']:
            if not eligible(record, self.config):
                continue
            data = (self.root / record['path']).read_bytes()
            parts = []
            seen = set()
            for part in chunks(record, data.decode('utf-8'), self.config):
                for document in token_safe_parts(part['document'], self.tokenizer()):
                    if document not in seen:
                        parts.append({'document': document, 'section': part['section']})
                        seen.add(document)
            for n, part in enumerate(parts):
                metadata = {'card_id': record['id'], 'path': record['path'], 'title': record['title'],
                    'section': part['section'], 'kind': record['kind'], 'status': record.get('status', 'unknown'),
                    'source_sha256': sha(data), 'record_sha256': sha(encoded(record)),
                    'profile': self.config['profile'], 'chunk_sha256': sha(part['document'].encode('utf-8'))}
                wanted[record['id'] + ':' + str(n)] = {'document': part['document'], 'metadata': metadata}
            count += 1
        with self.writer():
            dirty = self.folder / 'incomplete-sync'
            dirty.write_text('Sync incomplete until manifest is committed', encoding='utf-8')
            collection = self.collection(create=True)
            existing = collection.get(include=['metadatas'])
            old = dict(zip(existing['ids'], existing['metadatas']))
            changed = [key for key, value in wanted.items() if old.get(key) != value['metadata']]
            for start in range(0, len(changed), 16):
                ids = changed[start:start + 16]
                documents = [wanted[x]['document'] for x in ids]
                collection.upsert(ids=ids, documents=documents, metadatas=[wanted[x]['metadata'] for x in ids],
                                  embeddings=self.embeddings(documents))
            removed = sorted(set(old) - set(wanted))
            if removed:
                collection.delete(ids=removed)
            sources = {r['metadata']['path']: r['metadata']['source_sha256'] for r in wanted.values()}
            if source_index(self.root)[1] != index_hash or any(sha((self.root / path).read_bytes()) != expected for path, expected in sources.items()):
                raise ValueError('Sources changed during indexing; repeat explicit sync')
            write_json(self.manifest_path, {'schema': VERSION, 'collection': self.name, 'index_sha256': index_hash,
                'model': self.config['model'], 'model_revision': self.config['model_revision'], 'preprocessing': PREPROCESSING,
                'indexed_at': datetime.now(timezone.utc).isoformat(),
                'cards': count, 'chunks': len(wanted), 'config_sha256': sha(encoded(self.config))})
            dirty.unlink()
        return {'status': 'INDEX_READY', 'cards': count, 'chunks': len(wanted), 'embedded_chunks': len(changed),
                'removed_chunks': len(removed), 'seconds': round(time.perf_counter() - started, 3), 'execution_authorized': False}

    def ready(self, index_hash):
        if (self.folder / 'writer.lock').exists() or (self.folder / 'incomplete-sync').exists():
            raise ValueError('Index is busy/incomplete; finish or repeat explicit sync')
        manifest = json.loads(self.manifest_path.read_text(encoding='utf-8'))
        if manifest['collection'] != self.name or manifest['index_sha256'] != index_hash:
            raise ValueError('Knowledge metadata/model changed; run explicit sync')

    def search(self, query, *, limit=3, context=False, max_chars=6000, semantic_only=False, kind=None):
        if not query.strip() or len(query) > 2000 or not 1 <= limit <= 6 or not 1000 <= max_chars <= 20000:
            raise ValueError('Bounded query, 1..6 results and context budget required')
        started = time.perf_counter()
        index, index_hash = source_index(self.root)
        records = {r['id']: r for r in index['records'] if eligible(r, self.config)}
        if kind is not None:
            records = {id: r for id, r in records.items() if r['kind'] == kind}
        if not records:
            return {'status': 'NO_CONTEXT', 'results': [], 'execution_authorized': False}
        exact = [] if semantic_only else exact_ids(query, index, records)
        stale = []
        ranked = {}
        mode = 'exact'
        if exact:
            rows = [{'id': x, 'section': records[x]['title'], 'distance': None} for x in exact]
        else:
            mode = 'semantic' if semantic_only else 'hybrid'
            self.ready(index_hash)
            col = self.collection()
            where = {'profile': self.config['profile']}
            if kind is not None:
                where = {'$and': [where, {'kind': kind}]}
            n = min(30, len(col.get(where=where, include=[])['ids']) if kind is not None else col.count())
            if not n:
                return {'status': 'NO_CONTEXT', 'results': [], 'execution_authorized': False}
            result = col.query(query_embeddings=self.embeddings([query]), n_results=n,
                where=where, include=['metadatas', 'distances'])
            for metadata, distance in zip(result['metadatas'][0], result['distances'][0]):
                id = metadata['card_id']
                if id in ranked or id not in records or distance > self.config['max_distance']:
                    continue
                record = records[id]
                path = self.root / record['path']
                if not path.is_file() or sha(path.read_bytes()) != metadata['source_sha256'] or sha(encoded(record)) != metadata['record_sha256']:
                    stale.append(id)
                    continue
                ranked[id] = {'id': id, 'section': metadata['section'], 'distance': round(float(distance), 4),
                              'expected_source_sha256': metadata['source_sha256'], 'fusion': 1 / (60 + len(ranked) + 1)}
            if not semantic_only:
                lexical = sorted(((score(query, r), r['id']) for r in records.values()), reverse=True)
                for n, (weight, id) in enumerate((x for x in lexical if x[0] > 0), 1):
                    if id in ranked:
                        ranked[id]['fusion'] += 1 / (60 + n)
            rows = sorted(ranked.values(), key=lambda r: (-r['fusion'], r['id']))
        results, full = [], []
        for row in rows[:limit]:
            record = records[row['id']]
            data = (self.root / record['path']).read_bytes()
            if row.get('expected_source_sha256', sha(data)) != sha(data):
                stale.append(record['id'])
                continue
            row = {k: v for k, v in row.items() if k != 'expected_source_sha256'}
            text = data.decode('utf-8')
            results.append({**row, 'path': record['path'], 'title': record['title'], 'kind': record['kind'],
                            'status': record.get('status', 'unknown'), 'source_sha256': sha(data)})
            if context:
                full.append({'id': record['id'], 'path': record['path'], 'status': record.get('status', 'unknown'), 'text': text})
        response = {'status': 'DISCOVERY_CANDIDATES' if results else 'NO_CONTEXT', 'mode': mode,
            'rollout': 'experimental_discovery_only',
            'results': results, 'stale_card_ids': sorted(set(stale)), 'execution_authorized': False,
            'requires_source_review': True, 'use': 'Find owning cards; use the reviewed dispatcher packet before execution'}
        if stale:
            response['index_action'] = 'sync_required'
        if context:
            if len(encoded(full).decode('utf-8')) > max_chars:
                response['status'] = 'NEEDS_SPLIT'
                response['context'] = None
                response['reason'] = 'Full selected cards exceed budget; no card was truncated'
            else:
                response['context'] = full
        response['seconds'] = round(time.perf_counter() - started, 3)
        return response


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('sync')
    q = sub.add_parser('search')
    q.add_argument('query')
    q.add_argument('--limit', type=int, default=3)
    q.add_argument('--context', action='store_true')
    q.add_argument('--max-chars', type=int, default=6000)
    q.add_argument('--semantic-only', action='store_true', help='Evaluate vectors without exact/lexical shortcuts')
    q.add_argument('--kind', help='Restrict retrieval to a known kind, e.g. mission, ui or mechanic')
    args = p.parse_args()
    rag = Rag()
    if args.command == 'sync':
        return rag.sync()
    return rag.search(args.query, limit=args.limit, context=args.context,
                      max_chars=args.max_chars, semantic_only=args.semantic_only, kind=args.kind)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False, indent=2))
    except (ValueError, OSError, ImportError) as error:
        print(json.dumps({'status': 'NOT_READY', 'reason': str(error), 'execution_authorized': False}, ensure_ascii=False))
        sys.exit(1)
