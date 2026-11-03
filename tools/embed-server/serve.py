#!/usr/bin/env python3
"""Loopback embedding server for the dsh-obsidian-mem hybrid retrieval provider.

This is the operator-owned half of `retrievalEngine: hybrid`. The plugin ships
with `retrievalProvider.enabled: false` and never starts this process: the row
in `$DSH_HOME/cordis.patch.yml` names the endpoint, and the operator runs it.

Wire contract, from `lib/retrieval-provider.js` (the plugin is the client):

    POST /embed   {"model": str, "texts": [str], "kind": "query"|"passage"}
             ->   {"model": <the request's model, echoed>, "dimensions": int,
                   "vectors": [[float, ...], ...]}   L2-normalized, 1024-d
    POST /rerank  {"model": str, "query": str, "candidates": [{"id", "text"}]}
             ->   [{"id": str, "score": float}, ...]  cosine similarity
    GET  /health  ->   {"status": "ok", "model": str, "dimensions": int, ...}

The model is Qwen3-Embedding-0.6B. `kind: "query"` gets the official
instruction prefix (`config_sentence_transformers.json`); passages and absent
kinds get no prefix. Both are pooled at the last token (left padding) and
normalized, so cosine similarity is a dot product on the plugin's side.

Everything is local: the socket binds a loopback address only, and the server
refuses to start on anything else. It owns no vault state and writes only its
own logs.

Run it with --help for the flags; environment variables mirror them:
EMBED_HOME, EMBED_HOST, EMBED_PORT, EMBED_MODEL_DIR, EMBED_MODEL_NAME,
EMBED_MAX_TOKENS, EMBED_CHUNK, EMBED_DEVICE, EMBED_ATTN, EMBED_QUERY_INSTRUCTION.
"""
import argparse
import json
import logging
import os
import select
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# The provider bounds these on the client side; refusing them here keeps a
# misdirected request from turning into unbounded GPU work.
MAX_TEXTS = 16
MAX_TEXT_CHARS = 1200
MAX_RERANK_CANDIDATES = 10
MAX_REQUEST_BYTES = 4 * 1024 * 1024

# Official query instruction of Qwen3-Embedding-0.6B
# (config_sentence_transformers.json -> prompts.query). The model instruction is
# English for every language; the document prompt is the empty string.
QUERY_INSTRUCTION = (
    'Instruct: Given a web search query, retrieve relevant passages that answer the query\n'
    'Query:'
)

DEFAULT_PORT = 8790
LOOPBACK_HOSTS = ('127.0.0.1', '::1')


def log(message):
    print('[embed-server] ' + message, flush=True)


def env_flag(name, default):
    """Read a boolean environment variable; unknown text keeps the default."""
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in ('0', 'false', 'no', 'off')


def parse_args(argv):
    home = Path(os.environ.get('EMBED_HOME', Path.home() / '.dsh' / 'obsidian-mem-embed'))
    parser = argparse.ArgumentParser(
        description='Loopback Qwen3-Embedding server for dsh-obsidian-mem.',
    )
    parser.add_argument('--host', default=os.environ.get('EMBED_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('EMBED_PORT', DEFAULT_PORT)))
    parser.add_argument(
        '--model-dir',
        default=os.environ.get(
            'EMBED_MODEL_DIR', str(home / 'models' / 'Qwen3-Embedding-0.6B')
        ),
    )
    parser.add_argument(
        '--model-name',
        default=os.environ.get('EMBED_MODEL_NAME', 'Qwen/Qwen3-Embedding-0.6B'),
        help='name reported by /health only; /embed echoes the request model',
    )
    parser.add_argument(
        '--max-tokens',
        type=int,
        default=int(os.environ.get('EMBED_MAX_TOKENS', '512')),
        help='model-side truncation; the plugin sends at most 1200 code points',
    )
    parser.add_argument(
        '--chunk',
        type=int,
        default=int(os.environ.get('EMBED_CHUNK', '4')),
        help='texts per forward pass; smaller chunks let queries interleave with warm',
    )
    parser.add_argument('--device', default=os.environ.get('EMBED_DEVICE', 'auto'))
    parser.add_argument(
        '--attn',
        choices=('sdpa', 'eager', 'auto'),
        default=os.environ.get('EMBED_ATTN', 'sdpa'),
        help='attention implementation; sdpa falls back to eager when unavailable',
    )
    parser.add_argument(
        '--no-query-instruction',
        action='store_true',
        default=not env_flag('EMBED_QUERY_INSTRUCTION', True),
        help='do not prepend the official instruction to kind=query texts',
    )
    return parser.parse_args(argv)


class Embedder:
    """The model, its tokenizer, and the serialized forward pass."""

    def __init__(self, model_dir, device, max_tokens, chunk, attn='sdpa', query_instruction=True):
        import torch
        from transformers import AutoModel, AutoTokenizer

        self.torch = torch
        self.device = self._resolve_device(torch, device)
        self.max_tokens = max(1, max_tokens)
        self.chunk = max(1, chunk)
        self.attn = attn
        self.query_instruction = query_instruction
        self.lock = threading.Lock()
        self.tokenizer = AutoTokenizer.from_pretrained(
            model_dir, padding_side='left', local_files_only=True
        )
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        self.tokenizer.padding_side = 'left'
        self.dtype = torch.float16 if self.device == 'mps' else torch.float32

        started = time.monotonic()
        log('loading %s on %s (%s)' % (model_dir, self.device, self.dtype))
        self.model = self._load(model_dir)
        self.dimensions = int(self.model.config.hidden_size)
        log('model ready in %.1fs; dimensions=%d' % (time.monotonic() - started, self.dimensions))

        started = time.monotonic()
        try:
            self._forward(['warm up'])
        except RuntimeError:
            # MPS fp16 is the fast path, not a requirement: fall back to fp32
            # rather than leaving the operator with a service that never answers.
            log('fp16 forward failed on %s; reloading float32' % self.device)
            self.dtype = torch.float32
            self.model = self._load(model_dir)
            self._forward(['warm up'])
        log('warmup %.1fs; device=%s dtype=%s attn=%s maxTokens=%d chunk=%d instruction=%s'
            % (time.monotonic() - started, self.device, self.dtype, self.attn,
               self.max_tokens, self.chunk, self.query_instruction))

    def _load(self, model_dir):
        from transformers import AutoModel

        kwargs = {'dtype': self.dtype, 'local_files_only': True, 'use_safetensors': True}
        if self.attn in ('sdpa', 'eager'):
            kwargs['attn_implementation'] = self.attn
        try:
            model = AutoModel.from_pretrained(model_dir, **kwargs)
        except (TypeError, ValueError):
            if self.attn == 'eager':
                raise
            # An older transformers or a backend without scaled-dot-product
            # attention still has to serve: fall back rather than refuse to run.
            log('attn=%r unavailable; falling back to eager' % self.attn)
            self.attn = 'eager'
            kwargs['attn_implementation'] = 'eager'
            model = AutoModel.from_pretrained(model_dir, **kwargs)
        return model.to(self.device).eval()

    @staticmethod
    def _resolve_device(torch, preferred):
        available = torch.backends.mps.is_available()
        if preferred == 'auto':
            return 'mps' if available else 'cpu'
        if preferred not in ('mps', 'cpu'):
            raise SystemExit('EMBED_DEVICE must be auto, mps or cpu')
        if preferred == 'mps' and not available:
            log('mps is not available on this machine; using cpu')
            return 'cpu'
        return preferred

    def _forward(self, texts):
        torch = self.torch
        batch = self.tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=self.max_tokens,
            return_tensors='pt',
        )
        batch = {key: value.to(self.device) for key, value in batch.items()}
        with torch.inference_mode():
            hidden = self.model(**batch).last_hidden_state
            # padding_side='left', so index -1 is the last real token of every row.
            pooled = hidden[:, -1]
            return torch.nn.functional.normalize(pooled.float(), p=2, dim=1)

    def embed(self, texts, kind, cancel=None):
        """Return one L2-normalized vector per text, or None if the client went away.

        The provider client enforces its own timeout (at most 5 s) and destroys
        the socket when it fires. The forward pass is not interruptible once a
        chunk starts, but checking the socket between chunks stops the server
        from spending the rest of an abandoned batch while the client is already
        retrying smaller slices -- the cascade that otherwise turns one timeout
        into a queue of timeouts.
        """
        if kind == 'query' and self.query_instruction:
            texts = [QUERY_INSTRUCTION + text for text in texts]
        # Sort by length before chunking. Every chunk pads its rows to the
        # longest text in that chunk, so grouping similar lengths instead of
        # vault order cuts wasted padding (~12% on a mixed 16-note batch).
        # Vectors are scattered back to the caller's order afterwards because
        # the provider contract requires one vector per input, in input order.
        order = sorted(range(len(texts)), key=lambda index: len(texts[index]))
        vectors = [None] * len(texts)
        for start in range(0, len(order), self.chunk):
            if cancel is not None and cancel():
                log('client gone; stopping embed after %d/%d chunk(s)' % (start, len(order)))
                return None
            indices = order[start : start + self.chunk]
            slice_ = [texts[index] for index in indices]
            # The lock is per chunk, so a query embedding can interleave with a
            # warm batch instead of waiting for sixteen passages.
            with self.lock:
                result = self._forward(slice_).cpu().tolist()
            for index, vector in zip(indices, result):
                vectors[index] = vector
        return vectors


class Handler(BaseHTTPRequestHandler):
    server_version = 'dsh-obsidian-mem-embed/1'

    def log_message(self, format_string, *args):  # noqa: A002 - stdlib signature
        log('%s %s' % (self.address_string(), format_string % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _fail(self, status, code, message):
        self._send_json(status, {'error': code, 'message': message})

    def _client_gone(self):
        """True once the peer hung up (the plugin's provider timeout does this)."""
        connection = self.connection
        if connection is None:
            return True
        try:
            readable, _, _ = select.select([connection], [], [], 0)
            if not readable:
                return False
            return connection.recv(1, socket.MSG_PEEK) == b''
        except (OSError, ValueError):
            return True

    def _read_json(self):
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return None, 'invalid-content-length'
        if length <= 0 or length > MAX_REQUEST_BYTES:
            return None, 'invalid-content-length'
        try:
            return json.loads(self.rfile.read(length).decode('utf-8')), None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, 'invalid-json'

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/health':
            embedder = self.server.embedder
            self._send_json(
                200,
                {
                    'status': 'ok',
                    'model': self.server.model_name,
                    'dimensions': embedder.dimensions,
                    'device': embedder.device,
                    'attention': embedder.attn,
                    'maxTokens': embedder.max_tokens,
                    'queryInstruction': embedder.query_instruction,
                    'pid': os.getpid(),
                },
            )
            return
        self._fail(404, 'not-found', 'unknown path')

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path == '/embed':
            return self._handle_embed()
        if path == '/rerank':
            return self._handle_rerank()
        self._fail(404, 'not-found', 'unknown path')

    def _handle_embed(self):
        started = time.monotonic()
        payload, error = self._read_json()
        if error is not None:
            return self._fail(400, error, 'request body must be JSON')
        if not isinstance(payload, dict):
            return self._fail(400, 'invalid-body', 'expected an object')
        model = payload.get('model')
        texts = payload.get('texts')
        kind = payload.get('kind')
        if not isinstance(model, str) or not model:
            return self._fail(400, 'invalid-model', 'model must be a non-empty string')
        if not isinstance(texts, list) or not texts:
            return self._fail(400, 'invalid-texts', 'texts must be a non-empty array')
        if len(texts) > MAX_TEXTS:
            return self._fail(400, 'too-many-texts', 'texts must contain at most 16 items')
        if kind not in (None, 'query', 'passage'):
            return self._fail(400, 'invalid-kind', 'kind must be query or passage')
        for text in texts:
            if not isinstance(text, str):
                return self._fail(400, 'invalid-texts', 'every text must be a string')
            if len(text) > MAX_TEXT_CHARS:
                return self._fail(400, 'text-too-long', 'a text exceeds 1200 characters')
        embedder = self.server.embedder
        try:
            vectors = embedder.embed(texts, kind, cancel=self._client_gone)
        except Exception as exc:  # noqa: BLE001 - report, never leak text
            log('embed failed: %s' % type(exc).__name__)
            return self._fail(500, 'embed-failed', type(exc).__name__)
        if vectors is None:
            self.close_connection = True
            return
        body = [[round(value, 6) for value in vector] for vector in vectors]
        self._send_json(
            200,
            {'model': model, 'dimensions': embedder.dimensions, 'vectors': body},
        )
        log(
            'embed %d text(s) kind=%s %.0fms'
            % (len(texts), kind or 'none', (time.monotonic() - started) * 1000)
        )

    def _handle_rerank(self):
        payload, error = self._read_json()
        if error is not None:
            return self._fail(400, error, 'request body must be JSON')
        if not isinstance(payload, dict):
            return self._fail(400, 'invalid-body', 'expected an object')
        model = payload.get('model')
        query = payload.get('query')
        candidates = payload.get('candidates')
        if not isinstance(model, str) or not model:
            return self._fail(400, 'invalid-model', 'model must be a non-empty string')
        if not isinstance(query, str) or not query or len(query) > MAX_TEXT_CHARS:
            return self._fail(400, 'invalid-query', 'query must be a string of at most 1200 chars')
        if not isinstance(candidates, list) or not candidates:
            return self._fail(400, 'invalid-candidates', 'candidates must be a non-empty array')
        if len(candidates) > MAX_RERANK_CANDIDATES:
            return self._fail(400, 'too-many-candidates', 'at most 10 candidates')
        texts = []
        ids = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                return self._fail(400, 'invalid-candidates', 'every candidate must be an object')
            candidate_id = candidate.get('id')
            text = candidate.get('text')
            if not isinstance(candidate_id, str) or not isinstance(text, str):
                return self._fail(400, 'invalid-candidates', 'candidate id and text must be strings')
            ids.append(candidate_id)
            texts.append(text)
        embedder = self.server.embedder
        try:
            query_vector = embedder.embed([query], 'query')[0]
            candidate_vectors = embedder.embed(texts, 'passage')
        except Exception as exc:  # noqa: BLE001
            log('rerank failed: %s' % type(exc).__name__)
            return self._fail(500, 'rerank-failed', type(exc).__name__)
        scores = [sum(q * c for q, c in zip(query_vector, vector)) for vector in candidate_vectors]
        self._send_json(
            200,
            [
                {'id': candidate_id, 'score': round(score, 6)}
                for candidate_id, score in zip(ids, scores)
            ],
        )


def main(argv):
    args = parse_args(argv)
    if args.host not in LOOPBACK_HOSTS:
        raise SystemExit('the endpoint must be loopback (127.0.0.1 or ::1); got ' + args.host)
    model_dir = str(Path(args.model_dir).expanduser())
    if not Path(model_dir, 'config.json').is_file():
        raise SystemExit('no model at %s; run tools/embed-server/setup.sh first' % model_dir)
    logging.getLogger('transformers').setLevel(logging.ERROR)
    embedder = Embedder(
        model_dir,
        args.device,
        args.max_tokens,
        args.chunk,
        attn=args.attn,
        query_instruction=not args.no_query_instruction,
    )
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    httpd.embedder = embedder
    httpd.model_name = args.model_name
    log('listening on http://%s:%d (model name %s)' % (args.host, args.port, args.model_name))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main(sys.argv[1:])
