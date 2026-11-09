# embed-gateway — a loopback embedding shim for hybrid retrieval

`dsh-obsidian-mem` deliberately ships no embedding provider. When

```yaml
retrievalProvider:
  enabled: true
  endpoint: http://127.0.0.1:8790
  model: qwen3.7-text-embedding
  dimensions: 1024
  timeoutMs: 5000
```

is set, the plugin speaks one small contract to a **literal loopback** address
(`127.0.0.1` or `::1` — see `LOOPBACK_HOSTS` in `lib/retrieval-provider.js`).
This shim is that address. It translates the plugin's contract into an
OpenAI-compatible `/embeddings` call, so an internal gateway can serve the
hybrid index without the plugin growing a network client of its own.

Zero dependencies. Node 18+ (tested on Node 24.20.0 / Windows 11). ESM only.

## Files

| File | Purpose |
| --- | --- |
| `shim.mjs` | The gateway. Starts a loopback HTTP server; `loadConfig`, `startShim`, `l2Normalize` are exported for tests. |
| `smoke.mjs` | Offline self-test with a built-in stub upstream. No network, no key. |
| `start.cmd` | Windows convenience launcher (reads the key from the environment). |

## Quick start (Windows 11)

PowerShell — the key is placed in the **process environment only**, never in a file:

```powershell
$env:DOCUMIND_API_KEY = '<your-key>'          # placeholder — never commit a real key
$env:EMBED_UPSTREAM_BASE = 'https://llms.documind.bosch-app.com/v1'
$env:EMBED_UPSTREAM_MODEL = 'qwen3.7-text-embedding'
node tools/embed-gateway/shim.mjs
```

Or with the bundled launcher:

```powershell
$env:DOCUMIND_API_KEY = '<your-key>'
.\tools\embed-gateway\start.cmd
```

Then check it:

```powershell
curl.exe http://127.0.0.1:8790/health
```

```json
{"status":"ok","model":"qwen3.7-text-embedding","dimensions":1024,"upstream":"https://llms.documind.bosch-app.com/v1","upstreamModel":"qwen3.7-text-embedding","style":"openai","queryInstruction":true}
```

Point the plugin at the same URL and give `retrievalProvider.model` **any
non-empty fingerprint you like** — the shim echoes whatever the plugin sent
verbatim, so the two model names need not match. `dimensions` must equal
`EMBED_DIMENSIONS` (1024 by default).

## The contract (authoritative source: `lib/retrieval-provider.js`)

### `POST /embed`

Request:

```json
{"model": "plugin-fingerprint", "texts": ["...", "..."], "kind": "query"}
```

`kind` is optional and is either `"query"` or `"passage"`. When omitted the
plugin sends no `kind` field at all, and the wire body stays byte-identical to
a caller that has no query/passage distinction.

Response `200`:

```json
{"model": "plugin-fingerprint", "dimensions": 1024, "vectors": [[0.01, -0.02, "..."]]}
```

* `model` is the **request's** `model`, echoed verbatim. The plugin compares it
  with `retrievalProvider.model` and refuses the reply with `provider-model` on
  any difference.
* `dimensions` must equal `retrievalProvider.dimensions`.
* `vectors` carries exactly one vector per requested text, each with exactly
  `dimensions` finite components. Every vector is **L2-normalised** here (the
  plugin does not renormalise, so cosine similarity is a dot product).

Bounds — all answered with `4xx`, never silently narrowed:

| Bound | Value | Status |
| --- | --- | --- |
| `texts` length | ≤ 16 (`EMBED_MAX_TEXTS`) | 400 `too-many-texts` |
| one text, in code points | ≤ 1,200 (`EMBED_MAX_CHARS`) | 400 `text-too-long` |
| request body | ≤ 4 MiB | 413 `body-too-large` |

Other request errors: 400 `bad-json`, `bad-model`, `bad-texts`, `bad-kind`;
404 `not-found`; 405 `method-not-allowed`.

### `GET /health`

```json
{"status":"ok","model":"...","dimensions":1024,"upstream":"...","upstreamModel":"...","style":"openai","queryInstruction":true}
```

The first five fields are the contract from the task; `style` and
`queryInstruction` are extra diagnostics. The credential never appears here.

### Failures

Every failure is `{"error": "<message>", "code": "<code>"}` with a `4xx`/`5xx`
status. `error` names the rule that failed and never echoes the query text,
chunks, embeddings or the key. Upstream problems map to `502`
(`upstream-status`, `upstream-unreachable`, `upstream-shape`,
`upstream-count`, `upstream-bad-json`, `upstream-vector`) and `504`
(`upstream-timeout`).

## Prefix rule (the server owns it)

The plugin sends `kind` instead of rewriting text. This shim applies the Qwen3
convention:

| `kind` | Sent upstream as |
| --- | --- |
| `"query"` | `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:` + text |
| `"passage"` | the text, unchanged |
| omitted | the text, unchanged |

The instruct form is applied to queries only — applying it to passages
measurably hurts Qwen3 retrieval. Set `EMBED_QUERY_INSTRUCTION=0` to send
queries raw, e.g. when pointing at a model with no instruction convention.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMBED_PORT` | `8790` | Loopback port. `0` picks an ephemeral port (used by the smoke test). |
| `EMBED_HOST` | `127.0.0.1` | Bind address. **Literal `127.0.0.1` or `::1` only**; anything else (`0.0.0.0`, `localhost`, an IP) is refused at startup with `shim-config`. |
| `EMBED_UPSTREAM_BASE` | *(required)* | OpenAI-compatible base, e.g. `https://llms.documind.bosch-app.com/v1`. `/embeddings` is appended. |
| `EMBED_UPSTREAM_MODEL` | *(required)* | Model name sent upstream, e.g. `qwen3.7-text-embedding`. |
| `EMBED_UPSTREAM_KEY` | *(empty)* | Upstream bearer token. When empty, the variable named by `EMBED_UPSTREAM_KEY_ENV` is used. |
| `EMBED_UPSTREAM_KEY_ENV` | `DOCUMIND_API_KEY` | Name of the environment variable holding the key. |
| `EMBED_DIMENSIONS` | `1024` | Expected vector width. An upstream answer of any other width is a `502` — never truncated, never padded. |
| `EMBED_TIMEOUT_MS` | `4000` | Upstream budget. Must stay **below the plugin's 5000 ms** ceiling (`PROVIDER_MAX_TIMEOUT_MS`), otherwise the plugin gives up first; the shim warns at startup if it does not. |
| `EMBED_MAX_TEXTS` | `16` | Per-request text bound. |
| `EMBED_MAX_CHARS` | `1200` | Per-text bound, counted in code points (`[...text].length`), so CJK text is not penalised. |
| `EMBED_QUERY_INSTRUCTION` | `1` | `1`/`0`, `true`/`false`, `yes`/`no`, `on`/`off`. |
| `EMBED_API_STYLE` | `openai` | `openai` → `POST {base}/embeddings`, reads `data[].embedding` (honours `index` when the answer is out of order). `ollama` → `POST {base}/api/embed`, reads `embeddings`. |

## Security

* The key is read from the environment and used only in the `Authorization`
  header. It is never written to a file, never printed, and never appears in a
  response body — upstream error text is passed through `redact()`, which
  replaces any occurrence of the key with `***`. Startup prints `bearer *** (set)`
  or `unset`, never the value.
* The server refuses to bind anything that is not a literal loopback address;
  `startShim()` re-checks the same rule, so an embedding of this module cannot
  be talked into listening publicly.
* The plugin itself refuses non-loopback endpoints. Remote inference stays a
  separate, explicit egress decision — this shim does not make it.

## Self-test

```powershell
node tools/embed-gateway/smoke.mjs
```

The test starts a stub OpenAI-compatible upstream on an ephemeral loopback port,
starts the shim in-process against it (`EMBED_PORT=0`, so it never collides with
a real gateway on 8790), and asserts: the three `kind` paths and their prefixes,
model echo, dimension mismatch (768 and 1536), count mismatch, non-JSON and
unreachable and timed-out upstreams, all four request bounds, out-of-order
upstream indices, credential redaction in bodies and logs, and — the last group
— the real `lib/retrieval-provider.js` `createRetrievalProvider` driving the
shim, so the wire format is checked by the contract's own authority.

Expected tail:

```
------------------------------------------------------------
embed-gateway smoke: 78/78 checks passed
ALL CHECKS PASSED
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `EADDRINUSE ... :8790` | Another shim or service holds the port. Find it with `netstat -ano | findstr :8790`, or set `EMBED_PORT`. |
| Plugin error `provider-model` | The reply did not echo `retrievalProvider.model`. The shim always echoes it; check you are talking to this shim. |
| Plugin error `provider-response` | Status ≠ 200, or `dimensions`/`vectors` do not match. `GET /health` and the shim's stderr say why. |
| `504 upstream-timeout` | The gateway answered slower than `EMBED_TIMEOUT_MS`. Raising it past 5000 ms only moves the failure to the plugin side. |
| `502 upstream-dimensions` | The model returned a width ≠ `EMBED_DIMENSIONS`. Fix the configuration; do not "fix" it by truncating. |
| Plugin error `provider-timeout` but shim logged `504` | Expected: the shim's budget should be shorter than the plugin's. Lower `EMBED_TIMEOUT_MS`. |
## Windows autostart on this machine

This machine runs the gateway from the Windows Startup folder, so it is up before
any DSH session asks for it:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-embed-gateway.vbs
```

The .vbs script starts `launch.mjs --detach` (hidden, no console). `launch.mjs`
fills in this machine's defaults (port 8790, gateway base, `qwen3.7-text-embedding`,
1024 dimensions, 4000 ms upstream budget — below the plugin's 5000 ms ceiling) and
resolves the credential from:

1. `EMBED_UPSTREAM_KEY`
2. `DOCUMIND_API_KEY`
3. DSH's own secret store, `~/.dsh/.credentials.yaml` → `refs:` → `DOCUMIND_API_KEY`

That order means no key has to be exported or copied for the service to start: DSH
already holds it. Nothing is written back to a file.

Verify the autostart entry before relying on it:

```powershell
node tools/embed-gateway/launch.mjs --detach
Start-Sleep -Seconds 3
curl.exe http://127.0.0.1:8790/health
```

`launch.mjs --detach` refuses to start a second gateway on a port that is already
serving: the child exits with `EADDRINUSE` and the existing one keeps answering.

### Plugin side (DSH profile patch)

The plugin row is configured in
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` (the home-level
`~/.dsh/cordis.patch.yml` does not exist on this machine and is not read):

```yaml
- id: obsidian-mem
  config:
    enabled: true
    retrievalEngine: hybrid
    retrievalProvider:
      enabled: true
      endpoint: "http://127.0.0.1:8790"
      model: "qwen3.7-text-embedding"
      dimensions: 1024
      timeoutMs: 4500
      rerank: false
```

The host does not watch the patch file: **restart DSH** after changing it. The
model string is the vector-store key, so changing it rebuilds every vector in the
vault (386 notes on this machine; roughly 20 minutes through this gateway at the
measured 1–2 s per 4–16 texts). Until the first warm finishes, hybrid searches
answer lexically and say `fallback: "store-warming"`.
