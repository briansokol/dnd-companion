#!/usr/bin/env bash
# Checks and prepares a Mac for local development. Safe to run repeatedly.
# Fixes only what is cheap and safe (pnpm via corepack, missing Ollama models);
# everything else is reported with an install hint.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
missing=0

ok() { printf '  \033[32mOK\033[0m       %s\n' "$1"; }
fixed() { printf '  \033[36mFIXED\033[0m    %s\n' "$1"; }
fail() {
  printf '  \033[31mMISSING\033[0m  %s\n' "$1"
  shift
  for hint in "$@"; do printf '           %s\n' "$hint"; done
  missing=1
}

# Same precedence as the config loader: real environment, then .env, then the
# profile. A variable already set to a non-empty value is never overwritten.
load_env() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    [ -n "${!key:-}" ] || export "$key=$value"
  done <"$file"
}
load_env "$ROOT/.env"
load_env "$ROOT/env/mac.env"

# True if version $1 >= version $2 (dotted numeric).
version_ge() {
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

echo "Checking Mac prerequisites"

# Node
want_node="$(tr -d '[:space:]v' <"$ROOT/.nvmrc")"
node_ok=0
if ! command -v node >/dev/null; then
  fail "Node (need $want_node)" "Install nvm (https://github.com/nvm-sh/nvm), then: nvm install && nvm use"
else
  have_node="$(node -v | tr -d v)"
  if version_ge "$have_node" "$want_node"; then
    ok "Node $have_node"
    node_ok=1
  else
    fail "Node $have_node is older than $want_node" "Run: nvm install && nvm use"
  fi
fi

# pnpm (provided by corepack at the version pinned in package.json)
if command -v pnpm >/dev/null; then
  ok "pnpm $(cd "$ROOT" && pnpm -v)"
elif [ "$node_ok" -eq 0 ]; then
  fail "pnpm" "Fix Node first, then re-run this script"
elif ! command -v corepack >/dev/null; then
  fail "pnpm (corepack not found)" "Run: npm install -g corepack && corepack enable"
elif corepack enable && command -v pnpm >/dev/null; then
  fixed "pnpm $(cd "$ROOT" && pnpm -v) (ran corepack enable)"
else
  fail "pnpm (corepack enable failed)" "Run: corepack enable"
fi

# Ollama
ollama_up=0
if ! command -v ollama >/dev/null; then
  fail "Ollama" "Run: brew install ollama   (or download from https://ollama.com/download)"
elif ! tags="$(curl -fsS --max-time 3 "$OLLAMA_BASE_URL/api/tags" 2>/dev/null)"; then
  fail "Ollama is installed but not running at $OLLAMA_BASE_URL" \
    "Start it: open -a Ollama   (or: ollama serve)" \
    "Then re-run this script to pull models"
else
  ok "Ollama at $OLLAMA_BASE_URL"
  ollama_up=1
fi

# Models
for model in "$CHAT_MODEL" "$EMBED_MODEL"; do
  # Ollama lists untagged models as name:latest.
  case "$model" in *:*) full="$model" ;; *) full="$model:latest" ;; esac
  if [ "$ollama_up" -eq 0 ]; then
    fail "Model $model" "Start Ollama, then re-run this script"
  elif printf '%s' "$tags" | grep -qF "\"name\":\"$full\""; then
    ok "Model $model"
  elif echo "Pulling $model" && OLLAMA_HOST="$OLLAMA_BASE_URL" ollama pull "$model"; then
    fixed "Model $model (pulled)"
  else
    fail "Model $model (pull failed)" "Run: ollama pull $model"
  fi
done

# whisper.cpp (running the server is covered by the STT setup, issue #18)
if command -v whisper-server >/dev/null; then
  ok "whisper.cpp (whisper-server)"
else
  fail "whisper.cpp (whisper-server)" "Run: brew install whisper-cpp"
fi

echo
if [ "$missing" -ne 0 ]; then
  echo "Some prerequisites are missing. Fix the items above and re-run."
  exit 1
fi
echo "All prerequisites are in place. Next: pnpm install"
