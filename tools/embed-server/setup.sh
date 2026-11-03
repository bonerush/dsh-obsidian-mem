#!/usr/bin/env bash
# One-time setup for the loopback Qwen3-Embedding server dsh-obsidian-mem's
# hybrid retrieval provider talks to.
#
# Idempotent: makes the venv when missing, installs the pinned Python deps,
# downloads the model only when its weights are absent, copies serve.py next to
# the venv, and with --launchd installs a per-user LaunchAgent so the endpoint is
# already listening when DSH starts. It never touches DSH configuration, the
# plugin, or the vault: enabling the provider is a separate, explicit edit of
# $DSH_HOME/cordis.patch.yml described in README.md.
#
# Overridable environment:
#   EMBED_HOME      install root            (~/.dsh/obsidian-mem-embed)
#   EMBED_MODEL_ID  Hugging Face repo id    (Qwen/Qwen3-Embedding-0.6B)
#   EMBED_MODEL_DIR model directory         ($EMBED_HOME/models/Qwen3-Embedding-0.6B)
#   EMBED_PORT      endpoint port           (8790)
#   EMBED_PYTHON    interpreter for the venv (python3)
#   EMBED_MAX_TOKENS per-text truncation    (512)
#   EMBED_CHUNK     texts per forward pass  (4)
#   EMBED_ATTN      attention implementation (sdpa; falls back to eager)
#   EMBED_QUERY_INSTRUCTION  official query prefix for kind=query (1)
#   PIP_INDEX_URL   package index           (https://pypi.org/simple)
#   HF_ENDPOINT     model download endpoint (https://huggingface.co)
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
EMBED_HOME=${EMBED_HOME:-$HOME/.dsh/obsidian-mem-embed}
MODEL_ID=${EMBED_MODEL_ID:-Qwen/Qwen3-Embedding-0.6B}
MODEL_DIR=${EMBED_MODEL_DIR:-$EMBED_HOME/models/Qwen3-Embedding-0.6B}
PORT=${EMBED_PORT:-8790}
MAX_TOKENS=${EMBED_MAX_TOKENS:-512}
CHUNK=${EMBED_CHUNK:-4}
ATTN=${EMBED_ATTN:-sdpa}
QUERY_INSTRUCTION=${EMBED_QUERY_INSTRUCTION:-1}
INSTRUCTION_ARGS=''
INSTRUCTION_FLAG=''
case "$(printf '%s' "$QUERY_INSTRUCTION" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off)
    INSTRUCTION_ARGS='    <string>--no-query-instruction</string>'
    INSTRUCTION_FLAG='--no-query-instruction'
    ;;
esac
INDEX_URL=${PIP_INDEX_URL:-https://pypi.org/simple}
PYTHON=${EMBED_PYTHON:-python3}
VENV="$EMBED_HOME/venv"
AGENT_LABEL=com.dsh.obsidian-mem-embed
PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"

mkdir -p "$EMBED_HOME/logs" "$(dirname "$MODEL_DIR")"

echo "embed home: $EMBED_HOME"
if [ ! -x "$VENV/bin/python" ]; then
  echo "creating venv at $VENV"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python "$PYTHON" "$VENV"
  else
    "$PYTHON" -m venv "$VENV"
  fi
fi

echo "installing pinned dependencies (index: $INDEX_URL)"
if command -v uv >/dev/null 2>&1; then
  uv pip install --python "$VENV/bin/python" --index-url "$INDEX_URL" -r "$HERE/requirements.txt"
else
  "$VENV/bin/python" -m pip install --quiet --index-url "$INDEX_URL" -r "$HERE/requirements.txt"
fi

if [ ! -s "$MODEL_DIR/model.safetensors" ]; then
  echo "downloading $MODEL_ID (about 1.2 GB) into $MODEL_DIR"
  "$VENV/bin/python" - "$MODEL_ID" "$MODEL_DIR" <<'PY'
import sys

from huggingface_hub import snapshot_download

repo_id, local_dir = sys.argv[1], sys.argv[2]
snapshot_download(
    repo_id=repo_id,
    local_dir=local_dir,
    allow_patterns=[
        'config.json',
        'config_sentence_transformers.json',
        'generation_config.json',
        'modules.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'vocab.json',
        'merges.txt',
        'model.safetensors',
        '1_Pooling/config.json',
    ],
)
PY
else
  echo "model present: $MODEL_DIR"
fi

cp "$HERE/serve.py" "$EMBED_HOME/serve.py"
chmod +x "$EMBED_HOME/serve.py"

if [ "${1:-}" = "--launchd" ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENV/bin/python</string>
    <string>$EMBED_HOME/serve.py</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--model-dir</string>
    <string>$MODEL_DIR</string>
    <string>--max-tokens</string>
    <string>$MAX_TOKENS</string>
    <string>--chunk</string>
    <string>$CHUNK</string>
    <string>--attn</string>
    <string>$ATTN</string>
$INSTRUCTION_ARGS
  </array>
  <key>WorkingDirectory</key><string>$EMBED_HOME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$EMBED_HOME/logs/embed-server.log</string>
  <key>StandardErrorPath</key><string>$EMBED_HOME/logs/embed-server.err.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "LaunchAgent installed: $PLIST"
  echo "health: curl http://127.0.0.1:$PORT/health   (the model needs a few seconds to load)"
else
  echo
  echo "run manually:"
  echo "  $VENV/bin/python $EMBED_HOME/serve.py --port $PORT --model-dir $MODEL_DIR --max-tokens $MAX_TOKENS --chunk $CHUNK --attn $ATTN $INSTRUCTION_FLAG"
  echo "or re-run this script with --launchd to autostart at login."
fi
