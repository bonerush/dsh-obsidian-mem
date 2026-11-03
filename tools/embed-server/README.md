# Qwen3-Embedding-0.6B loopback server

A local, loopback-only embedding service for the plugin's optional `hybrid` retrieval
engine. It speaks the provider contract in [`../../lib/retrieval-provider.js`](../../lib/retrieval-provider.js)
and runs [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
on Apple Silicon (MPS, float16).

This directory is **not shipped in the npm package** (`package.json` `files` does not
include `tools/`) and adds **no runtime dependency** to the plugin: the plugin still
talks to it over HTTP on 127.0.0.1, exactly like the research e5 server it was
validated against. It is here so a local install is reproducible instead of a
one-off command in a shell history.

## What it guarantees

- Binds `127.0.0.1` only (a non-loopback bind is refused), so the model is never
  reachable from the network and no text leaves the machine.
- `POST /embed` `{"model": "<any>", "texts": ["..."], "kind": "query"|"passage"}`
  → `{"model": "<echo of the request model>", "dimensions": 1024, "vectors": [[...]]}`,
  L2-normalised, float32 → JSON numbers.
  `kind: "query"` prepends the model card's instruction prefix
  (`Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:`);
  `kind: "passage"` (or omitting `kind`) adds no prefix. The plugin sends `kind` for
  both sides, so the server owns the prefix rule.
- Last-token pooling with left padding, as in the model card's reference code.
- Length-sorted chunking: every chunk pads its rows to its longest text, so the
  server sorts the request's texts by length before splitting it into
  `EMBED_CHUNK`-sized forwards and scatters the vectors back into request order.
  On a 16-text batch shaped like the real vault this cuts the padded token count
  from 1.41× to 1.13× the raw tokens (−19.6 % of forward-pass work) without
  changing any vector: alone-vs-batch cosine was measured at 1.000000.
- `POST /rerank` → a raw array `[{"id": ..., "score": ...}]` (the plugin's reserved
  contract; the hybrid engine does not call it yet).
- `GET /health` → model, dimensions, device, `maxTokens`, `attention`,
  `queryInstruction`, pid. Useful before a restart.
- Model load happens **before** the socket binds, so a `curl /health` 200 means the
  first embedding request will not pay the load cost.

## Requirements

- macOS on Apple Silicon (the setup was measured on an M2 / 16 GB; `EMBED_DEVICE=cpu`
  works, slower). Python 3.13 is created by `uv` if `uv` is present, otherwise an
  existing `python3 -m venv` is used.
- ~2 GB on disk (venv + float16 weights) and ~2.5 GB RAM while resident.
- One-time model download (1.19 GB `model.safetensors` plus tokenizer).

## Install

```sh
cd tools/embed-server
./setup.sh                 # venv, pinned deps, model, serve.py into $EMBED_HOME
./setup.sh --launchd       # same, plus a user LaunchAgent that starts it at login
```

`EMBED_HOME` defaults to `~/.dsh/obsidian-mem-embed`. The script is idempotent:
existing venv/model are reused, missing pieces are created.

Useful environment overrides:

| Variable | Default | Meaning |
|---|---|---|
| `EMBED_HOME` | `~/.dsh/obsidian-mem-embed` | venv, model and logs root |
| `EMBED_PORT` | `8790` | loopback port |
| `EMBED_MODEL_DIR` | `$EMBED_HOME/models/Qwen3-Embedding-0.6B` | weights |
| `EMBED_MODEL_NAME` | `Qwen/Qwen3-Embedding-0.6B` | string echoed in responses and used as the plugin's `model` field |
| `EMBED_MAX_TOKENS` | `512` | per-text truncation; see the next section |
| `EMBED_CHUNK` | `4` | texts per forward pass; lower keeps query latency low while a warm batch runs |
| `EMBED_ATTN` | `sdpa` | attention implementation (`sdpa`, `eager`, `auto`); `sdpa` falls back to `eager` when the kernel is unavailable |
| `EMBED_QUERY_INSTRUCTION` | `1` | prepend the model card's instruction to `kind: "query"` texts; set `0` to disable |
| `PIP_INDEX_URL` | `https://pypi.org/simple` | e.g. `https://mirrors.aliyun.com/pypi/simple` in mainland China |
| `HF_ENDPOINT` | huggingface.co | e.g. `https://hf-mirror.com` for the model download |

`EMBED_MAX_TOKENS`, `EMBED_CHUNK`, `EMBED_ATTN` and `EMBED_QUERY_INSTRUCTION` are
baked into the LaunchAgent as command-line arguments, so changing any of them means
re-running `./setup.sh --launchd` (it rewrites the plist and restarts the service);
the other variables only affect setup itself.

## Plugin configuration

The plugin ships with the provider disabled. The row below is the one this server
was configured against; it lives in `$DSH_HOME/cordis.patch.yml` (the home-level
patch layer) and is reproduced here only so the two halves stay in sync. Every
field is listed because a row's inline `config:` replaces the whole config object.

```yaml
- id: obsidian-mem
  config:
    enabled: true
    vaultPath: "~/Documents/dsh-memory"
    initGitOnCreate: true
    injectBrief: true
    bindHint: true
    briefBudgetChars: 6000
    briefConventionMode: summary
    recallBudgetChars: 900
    failureRecall: true
    hotCapacityChars: 9000
    hotArchiveRatio: 0.67
    autoCapture: true
    autoCurate: true
    captureIdleMs: 90000
    distill:
      provider: ""
      model: ""
      maxItems: 12
      minConfidence: 0.75
      maxInputChars: 24000
      maxOutputTokens: 4000
      timeoutMs: 60000
      maxRetries: 3
      dryRun: false
      learnHabits: true
    indexBackend: auto
    retrievalEngine: hybrid
    retrievalProvider:
      enabled: true
      endpoint: "http://127.0.0.1:8790"
      model: "Qwen/Qwen3-Embedding-0.6B"
      dimensions: 1024
      timeoutMs: 5000
      rerank: false
    ignoreGlobs: []
```

`endpoint` must be the literal loopback address (`127.0.0.1` or `::1`); a hostname
such as `localhost` is refused at config load. `dimensions` must match what the
server returns (1024). `timeoutMs` is capped at 5000 by the plugin.

## Verify

```sh
curl -s http://127.0.0.1:8790/health
curl -s -X POST http://127.0.0.1:8790/embed \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3-Embedding-0.6B","texts":["hello"],"kind":"query"}'
```

The first call returns 1024 numbers with an L2 norm of 1. The plugin's own contract
can be exercised end to end without a DSH restart:

```sh
cd ../..
node --input-type=module -e "
import { createRetrievalProvider } from './lib/retrieval-provider.js'
const client = createRetrievalProvider({
  enabled: true, endpoint: 'http://127.0.0.1:8790',
  model: 'Qwen/Qwen3-Embedding-0.6B', dimensions: 1024,
  timeoutMs: 5000, rerank: false,
})
const out = await client.embed({ texts: ['混合检索怎么配置'], kind: 'query' })
console.log(out.model, out.dimensions, out.vectors[0].length)
"
```

After a DSH restart the first hybrid search starts a background warm of the whole
vault; until it finishes, searches answer lexically and say so in the retrieval
diagnostic (`hybridFallback: "store-warming"`). The next process start reads the
store and needs no warm.

## Measured behaviour

Apple M2, 16 GB, macOS 27.2, torch 2.15.0 MPS float16, `EMBED_MAX_TOKENS=512`,
`EMBED_CHUNK=4`, `--attn sdpa`, service under launchd, measured 2026-11-03. Absolute
times drift with host load: the same 16-text request measured 4.1–5.0 s when the
machine was quiet but 10–16 s later the same session while memory compression sat
at 3.2 GB and swap was full (MPS matmul itself stayed at ~1.5 TFLOPS). Treat the
ratios in this file as the durable result, and re-measure before quoting a wall
clock to someone:

| Request | Time | Note |
|---|---|---|
| `GET /health` | instant | model already loaded |
| `/embed` 1 query, first call | 0.53 s | kernel/alloc warm-up |
| `/embed` 1 query, then | 0.059–0.070 s | steady state |
| `/embed` 8 × 1200-cp passages | 3.21–3.25 s | inside the 5 s plugin timeout |
| `/embed` 16 × 1200-cp passages | 6.42–6.71 s | **exceeds** 5 s → the plugin bisects to 8+8 |
| `/embed` 16 mixed-length passages (107–737 cp) | 4.1–5.0 s | after length-sorted chunking; before it, 5.0–5.6 s on the same payload |

Real vault distribution (1371 notes, frontmatter stripped, 1200 code points cap):
tokens p50 = 83, p75 = 142, p90 = 272, p95 = 546; 77 notes exceed 512 tokens,
144 exceed 256. Mixed real batches are therefore far shorter than the synthetic
16 × 1200-cp worst case; a long-note clump is the only case that hits the bisection
path. `EMBED_MAX_TOKENS` is the quality/latency dial: 512 truncates 5.6% of the
vault, 256 truncates 10.5% but keeps even the synthetic 16-text batch near 3.2 s.

### Chunk size

The same 16-text mixed-length payload against servers started with different
`EMBED_CHUNK` (3 rounds each, medians):

| `EMBED_CHUNK` | mixed order | sorted order | single 737-cp text |
|---|---|---|---|
| 2 | 6.557 s | 5.569 s | 0.562 s |
| **4** | **5.044 s** | **4.422 s** | **0.446 s** |
| 8 | 9.403 s | 7.525 s | 0.610 s |
| 16 | 9.816 s | 9.435 s | 0.709 s |

`4` is the sweet spot: `2` pays per-forward overhead, `8` and `16` pad more rows to
the longest text. With the server sorting internally, the mixed and sorted orders
converge (the remaining difference is run-to-run noise from background load).

### First warm, checkpoints and the 5 s timeout

The first warm embeds the whole vault, so it dominates the cost of turning hybrid
on. On 1389 notes before the checkpointing change, the plugin's `timeoutMs: 5000`
(the schema ceiling, so no config can lift it) sat right at the model's 16-text
cost: the warm took **8 min 10 s** in a re-run and **9 min 24 s** in the first
live run, with 135 passage requests for 111 batches, 24 timeouts, p50 3743 ms,
p95 5004 ms. `lib/embedding-store.js` now handles that boundary in two ways:

- **Checkpointing.** The store is written after every 8 completed top-level
  batches (or 30 s, whichever comes first) and again on failure if any vector
  landed. An interrupted or failed warm therefore resumes from disk and skips the
  notes it already embedded; a failure before the first new vector still leaves
  the previous store byte-identical. Because `rank()` reads the store on every
  call, a partial checkpoint also makes hybrid retrieval partially available
  during a long warm.
- **Adaptive batch size.** With no pinned `batchSize`, a request over 3.5 s
  shrinks the next top-level batch toward a ~2.8 s target (floor 4 texts); a 5 s
  timeout halves the failed slice before bisecting it, and the next top-level
  batch starts from that smaller size. Fast batches grow back one text at a time.

Both behaviours are covered by `test/embedding-store.test.js` (21 tests).

The first attempt to measure the full warm with this build on a loaded machine
failed after 96 notes when even a single-text request timed out; the checkpoint
file still held those 96 vectors. The second attempt completed **1404 notes in
13 min 17 s**: 300 batches, 318 requests, **18 timeouts (5.7 % of requests)**, a
request amplification of 1.06× (318/300), p50 1973 ms, p95 5002 ms. The same
machine was slower than in the earlier baseline (in-process MPS throughput had
fallen from ~1.5 to ~0.6 TFLOPS of effective matmul; the DSH renderer, Music and
memory compression kept the host busy), so the wall clock is not comparable to
the 8 min 10 s baseline -- but the structural numbers are: **timeout rate fell
from 17.8 % (24/135) to 5.7 % (18/318)** and request amplification from 1.22× to
1.06×. On a quiet host the adaptive sizer starts at 16 and only shrinks when a
batch actually runs slow, so it adds no cost to the fast path.

### Crash and outage behaviour

- `kill -9` of the server process: launchd replaced it in 0.27 s, `/health` ready
  again after 5.74 s (torch import + model load + warm-up).
- `launchctl bootout`: hybrid searches immediately answer lexically and record
  `fallback: "provider-error"` (measured 69 ms). Bootstrapping the agent again
  restores dense results in 2.7 s, and the persisted store means **no re-warm**:
  the first query after recovery already returns `semantic-score`/`hybrid-rank`.
- **Client timeout abandons work.** The plugin destroys the socket at its 5 s
  timeout, but a forward pass cannot be interrupted once started. The server
  checks the socket between chunks and stops the rest of an abandoned batch
  (`client gone; stopping embed after 4/16 chunk(s)`), so the queue does not
  fill with work nobody waits for. Without this, one slow batch became a
  cascade: each timed-out client retry queued behind the still-running forward
  of the request it had just abandoned, and on a loaded host even single-text
  requests started timing out.

### Instruction prefix

`kind: "query"` prepends the model card's prefix by default
(`--no-query-instruction` / `EMBED_QUERY_INSTRUCTION=0` disables it). Two probes on
the real vault (22 resolved paraphrase pairs over 1400 notes, and 30 title→self
queries) measured:

| Probe | with prefix | without prefix |
|---|---|---|
| paraphrase top-1 / top-5 / MRR@10 | 0.727 / 0.955 / 0.828 | 0.636 / 0.955 / 0.773 |
| title→self top-1 / MRR@10 | 0.900 / 0.950 | 0.933 / 0.961 |

The prefix wins where it matters most — paraphrased, natural-language retrieval
(+0.055 MRR) — and loses a little on verbatim title lookup (−0.011), so it stays ON
by default, matching the model card. The switch exists for a per-vault A/B: the
plugin always sends `kind: "query"`, so the server-side flag is the whole decision.
An earlier, smaller 12-pair probe had shown the opposite direction; the expanded
sample reversed it, which is why the switch is documented rather than hard-wired.

## Logs and lifecycle

The LaunchAgent writes to `$EMBED_HOME/logs/embed-server.log` and
`embed-server.err.log`; each request logs its text count and elapsed time, never text.

```sh
launchctl print gui/$(id -u)/com.dsh.obsidian-mem-embed | head -20
launchctl kickstart -k gui/$(id -u)/com.dsh.obsidian-mem-embed   # restart
tail -f ~/.dsh/obsidian-mem-embed/logs/embed-server.log
```

Without `--launchd`, run it directly:

```sh
~/.dsh/obsidian-mem-embed/venv/bin/python \
  ~/.dsh/obsidian-mem-embed/serve.py --port 8790 \
  --model-dir ~/.dsh/obsidian-mem-embed/models/Qwen3-Embedding-0.6B
```

### Uninstall

```sh
launchctl bootout gui/$(id -u)/com.dsh.obsidian-mem-embed 2>/dev/null
rm -f ~/Library/LaunchAgents/com.dsh.obsidian-mem-embed.plist
rm -rf ~/.dsh/obsidian-mem-embed
```

Then remove the `retrievalProvider` override (or set `enabled: false`) from
`$DSH_HOME/cordis.patch.yml`. The plugin falls back to lexical retrieval and says
`provider-disabled` in the search diagnostic.

## Why torch + transformers and not ONNX/MLX/GGUF

- **Official reference**: the model card's pooling and instruction-prefix code is
  a few lines; running the exact reference implementation keeps the vectors
  comparable to the published MTEB numbers and to the frozen hybrid design.
- **Rejected ONNX** (`onnx-community/Qwen3-Embedding-0.6B-ONNX`): fp32 is 2.09 GB;
  the small variants are int8/4-bit with an unmeasured quality cost, and they need
  a custom last-token-pool step anyway.
- **Rejected MLX variants**: only mxfp8 (fp8 Apple GPU, M2 risk) and 4-bit-DWQ are
  published; `mlx-embeddings` pulls `mlx-vlm` and `transformers>=5`, a heavy
  dependency tree for the same model.
- **Rejected GGUF/llama.cpp**: Q8_0 is smaller and faster, but it adds a second
  server binary, a bridge process and a second thing to keep alive.
- bfloat16 was measured slower than float16 on this M2 (load 1.4 s vs 7.5 s, but
  batch 16/8/4 = 15.5/9.9/4.9 s vs 17.1/7.1/2.8 s under MPS contention), so fp16
  stays.
