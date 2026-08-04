#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy-cloud-runtime.sh \
  --root <remote-root> \
  --archive <runtime.tgz> \
  --sha256 <digest> \
  --release-id <id> \
  --port <port> \
  [--bind-host <host>] \
  [--data-dir <path>] \
  [--env-file <path>] \
  [--api-only]

The environment file is sourced on the remote host and should contain secrets
such as PIARIUM_UI_PASSWORD. Secrets are never accepted as command arguments.
EOF
}

ROOT_INPUT=""
ARCHIVE_INPUT=""
EXPECTED_SHA256=""
RELEASE_ID=""
PORT=""
BIND_HOST="0.0.0.0"
DATA_DIR_INPUT=""
ENV_FILE_INPUT=""
API_ONLY="false"
HEALTH_TIMEOUT_SECONDS="45"

require_value() {
  local option_name="$1"
  local option_value="${2:-}"
  if [[ -z "$option_value" ]]; then
    echo "${option_name} requires a value" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      require_value "$1" "${2:-}"
      ROOT_INPUT="$2"
      shift 2
      ;;
    --archive)
      require_value "$1" "${2:-}"
      ARCHIVE_INPUT="$2"
      shift 2
      ;;
    --sha256)
      require_value "$1" "${2:-}"
      EXPECTED_SHA256="$2"
      shift 2
      ;;
    --release-id)
      require_value "$1" "${2:-}"
      RELEASE_ID="$2"
      shift 2
      ;;
    --port)
      require_value "$1" "${2:-}"
      PORT="$2"
      shift 2
      ;;
    --bind-host)
      require_value "$1" "${2:-}"
      BIND_HOST="$2"
      shift 2
      ;;
    --data-dir)
      require_value "$1" "${2:-}"
      DATA_DIR_INPUT="$2"
      shift 2
      ;;
    --env-file)
      require_value "$1" "${2:-}"
      ENV_FILE_INPUT="$2"
      shift 2
      ;;
    --health-timeout)
      require_value "$1" "${2:-}"
      HEALTH_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --api-only)
      API_ONLY="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for required in ROOT_INPUT ARCHIVE_INPUT EXPECTED_SHA256 RELEASE_ID PORT; do
  if [[ -z "${!required}" ]]; then
    echo "Missing required deployment value: ${required}" >&2
    usage >&2
    exit 2
  fi
done

if [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid release id: ${RELEASE_ID}" >&2
  exit 2
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: ${PORT}" >&2
  exit 2
fi
if [[ ! "$HEALTH_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( HEALTH_TIMEOUT_SECONDS < 1 )); then
  echo "Invalid health timeout: ${HEALTH_TIMEOUT_SECONDS}" >&2
  exit 2
fi
if [[ ! "$EXPECTED_SHA256" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "Invalid SHA-256 digest." >&2
  exit 2
fi

expand_home_path() {
  local value="$1"
  case "$value" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${value#\~/}" ;;
    /*) printf '%s\n' "$value" ;;
    *) printf '%s/%s\n' "$HOME" "$value" ;;
  esac
}

ROOT="$(expand_home_path "$ROOT_INPUT")"
if [[ "$ARCHIVE_INPUT" = /* ]]; then
  ARCHIVE="$ARCHIVE_INPUT"
else
  ARCHIVE="${ROOT}/${ARCHIVE_INPUT}"
fi
ENV_FILE="$(expand_home_path "${ENV_FILE_INPUT:-~/.config/piarium/deploy.env}")"

for command_name in bun id node stat tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required remote runtime is missing: ${command_name}" >&2
    exit 1
  fi
done

node --input-type=module -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    console.error(`Piarium requires Node.js >=22.19.0; found ${process.versions.node}`);
    process.exit(1);
  }
'

if [[ -f "$ENV_FILE" ]]; then
  permissions="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
  if [[ -n "$permissions" && "$permissions" != "600" && "$permissions" != "400" ]]; then
    echo "Refusing deployment because ${ENV_FILE} must use mode 600 or 400 (found ${permissions})." >&2
    exit 1
  fi
  env_owner_uid="$(stat -c '%u' "$ENV_FILE" 2>/dev/null || true)"
  if [[ -n "$env_owner_uid" && "$env_owner_uid" != "$(id -u)" ]]; then
    echo "Refusing deployment because ${ENV_FILE} is not owned by the deployment user." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PIARIUM_DATA_DIR="$(expand_home_path "${DATA_DIR_INPUT:-${PIARIUM_DATA_DIR:-~/.config/piarium}}")"
export PIARIUM_DATA_DIR
export PIARIUM_HOST="$BIND_HOST"
export PIARIUM_PORT="$PORT"
export NODE_ENV=production
if [[ "$API_ONLY" = "true" ]]; then
  export PIARIUM_API_ONLY=true
else
  unset PIARIUM_API_ONLY || true
fi

case "$BIND_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    if [[ -z "${PIARIUM_UI_PASSWORD:-}" ]]; then
      echo "PIARIUM_UI_PASSWORD must be set in ${ENV_FILE} before binding Piarium to ${BIND_HOST}." >&2
      exit 1
    fi
    ;;
esac

mkdir -p "$ROOT/incoming" "$ROOT/releases" "$ROOT/cache/bun" "$PIARIUM_DATA_DIR"
chmod 700 "$PIARIUM_DATA_DIR" 2>/dev/null || true

DEPLOY_LOCK_FILE="${ROOT}/.deploy.lock"
DEPLOY_LOCK_HELD="false"
STAGING_DIR=""
CANDIDATE_CREATED="false"
RELEASE_DIR=""

release_deploy_lock() {
  if [[ "$DEPLOY_LOCK_HELD" = "true" ]]; then
    if [[ "$(cat "$DEPLOY_LOCK_FILE" 2>/dev/null || true)" = "$$" ]]; then
      rm -f "$DEPLOY_LOCK_FILE"
    fi
    DEPLOY_LOCK_HELD="false"
  fi
}

cleanup_on_exit() {
  local status=$?
  set +e
  if [[ -n "$STAGING_DIR" ]]; then
    rm -rf "$STAGING_DIR"
  fi
  if [[ "$CANDIDATE_CREATED" = "true" && -n "$RELEASE_DIR" ]]; then
    rm -rf "$RELEASE_DIR"
  fi
  release_deploy_lock
  return "$status"
}
trap cleanup_on_exit EXIT

acquire_deploy_lock() {
  local attempt owner_pid
  for attempt in 1 2; do
    if (set -o noclobber; printf '%s\n' "$$" > "$DEPLOY_LOCK_FILE") 2>/dev/null; then
      DEPLOY_LOCK_HELD="true"
      return 0
    fi

    owner_pid="$(cat "$DEPLOY_LOCK_FILE" 2>/dev/null || true)"
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
      echo "Another Piarium deployment is already running for ${ROOT} (pid ${owner_pid})." >&2
      exit 1
    fi
    rm -f "$DEPLOY_LOCK_FILE"
  done

  echo "Unable to acquire the Piarium deployment lock for ${ROOT}." >&2
  exit 1
}

acquire_deploy_lock

sha256_file() {
  local file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
  else
    node -e 'const fs=require("fs");const crypto=require("crypto");const hash=crypto.createHash("sha256");hash.update(fs.readFileSync(process.argv[1]));console.log(hash.digest("hex"));' "$file_path"
  fi
}

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Cloud runtime archive not found: ${ARCHIVE}" >&2
  exit 1
fi
ACTUAL_SHA256="$(sha256_file "$ARCHIVE")"
if [[ "${ACTUAL_SHA256,,}" != "${EXPECTED_SHA256,,}" ]]; then
  echo "Cloud runtime archive checksum mismatch." >&2
  echo "expected: ${EXPECTED_SHA256}" >&2
  echo "actual:   ${ACTUAL_SHA256}" >&2
  exit 1
fi

RELEASE_DIR="${ROOT}/releases/${RELEASE_ID}"
STAGING_DIR="${ROOT}/releases/.${RELEASE_ID}.staging.$$"
rm -rf "$STAGING_DIR"

if [[ -d "$RELEASE_DIR" ]]; then
  RELEASE_SHA_FILE="${RELEASE_DIR}/.archive-sha256"
  if [[ ! -f "$RELEASE_SHA_FILE" ]]; then
    echo "Existing release ${RELEASE_ID} has no archive identity and cannot be reused safely." >&2
    exit 1
  fi
  RELEASE_SHA256="$(tr -d '[:space:]' < "$RELEASE_SHA_FILE")"
  if [[ "${RELEASE_SHA256,,}" != "${EXPECTED_SHA256,,}" ]]; then
    echo "Release id ${RELEASE_ID} already belongs to a different archive." >&2
    exit 1
  fi
else
  mkdir -p "$STAGING_DIR"

  tar -xzf "$ARCHIVE" -C "$STAGING_DIR"
  for required_path in \
    package.json \
    bun.lock \
    cloud-runtime.json \
    packages/web/bin/cli.js \
    packages/web/server/index.js \
    packages/web/dist \
    packages/protocol/dist/index.js \
    packages/pi-host/dist/main.js \
    packages/runtime-broker/dist/index.js; do
    if [[ ! -e "${STAGING_DIR}/${required_path}" ]]; then
      echo "Cloud runtime archive is missing ${required_path}" >&2
      exit 1
    fi
  done

  # Install only after the directory has its immutable final path. Bun workspace
  # links can be absolute junctions on Windows and must never point back to the
  # temporary extraction directory after the release is activated.
  mv "$STAGING_DIR" "$RELEASE_DIR"
  CANDIDATE_CREATED="true"

  install_runtime_dependencies() {
    (
      cd "$RELEASE_DIR"
      bun install \
        --production \
        --frozen-lockfile \
        --backend=hardlink \
        --cache-dir="${ROOT}/cache/bun"
    )
  }
  if ! install_runtime_dependencies; then
    echo "Retrying dependency installation after a partial cache/link failure..." >&2
    install_runtime_dependencies
  fi

  (
    cd "$RELEASE_DIR"
    node --input-type=module -e '
      import { createRequire } from "node:module";
      const broker = await import("./packages/web/node_modules/@piarium/runtime-broker/dist/index.js");
      const hostEntry = broker.resolveBundledPiHostEntry();
      if (!hostEntry) throw new Error("Pi host entry could not be resolved");
      const require = createRequire(new URL("./packages/web/package.json", import.meta.url));
      const pty = require("node-pty");
      if (typeof pty.spawn !== "function") throw new Error("node-pty is unavailable");
      require.resolve("sherpa-onnx-node");
      console.log(`Verified Pi host: ${hostEntry}`);
    '
  )

  printf '%s\n' "${EXPECTED_SHA256,,}" > "${RELEASE_DIR}/.archive-sha256"

  CANDIDATE_CREATED="false"
fi

EXPECTED_VERSION="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(value.version||""));' "${RELEASE_DIR}/cloud-runtime.json")"
if [[ -z "$EXPECTED_VERSION" ]]; then
  echo "Cloud runtime manifest has no version." >&2
  exit 1
fi

atomic_link() {
  local target="$1"
  local link_path="$2"
  local temporary_link="${ROOT}/.$(basename "$link_path").${RELEASE_ID}.$$"
  rm -f "$temporary_link"
  ln -s "$target" "$temporary_link"
  mv -Tf "$temporary_link" "$link_path"
}

current_target() {
  if [[ -L "${ROOT}/current" ]]; then
    readlink -f "${ROOT}/current" || true
  fi
}

run_cli() {
  local runtime_dir="$1"
  shift
  (
    cd "$runtime_dir"
    node packages/web/bin/cli.js "$@"
  )
}

stop_runtime() {
  local runtime_dir="$1"
  if [[ -f "${runtime_dir}/packages/web/bin/cli.js" ]]; then
    run_cli "$runtime_dir" stop --port "$PORT" >/dev/null 2>&1 || true
  fi
}

start_runtime() {
  local runtime_dir="$1"
  local -a args=(serve --host "$BIND_HOST" --port "$PORT")
  if [[ "$API_ONLY" = "true" ]]; then
    args+=(--api-only)
  fi
  (
    export PIARIUM_RELEASE_ID
    PIARIUM_RELEASE_ID="$(basename "$runtime_dir")"
    run_cli "$runtime_dir" "${args[@]}"
  )
}

wait_for_health() {
  local expected_version="$1"
  local expected_release_id="$2"
  local health_host="$BIND_HOST"
  case "$health_host" in
    0.0.0.0) health_host="127.0.0.1" ;;
    ::|\[::\]) health_host="::1" ;;
  esac
  health_host="${health_host#\[}"
  health_host="${health_host%\]}"
  if [[ "$health_host" == *:* ]]; then
    health_host="[${health_host}]"
  fi
  PIARIUM_HEALTH_URL="http://${health_host}:${PORT}/health" \
  PIARIUM_EXPECTED_VERSION="$expected_version" \
  PIARIUM_EXPECTED_RELEASE_ID="$expected_release_id" \
  PIARIUM_HEALTH_TIMEOUT_SECONDS="$HEALTH_TIMEOUT_SECONDS" \
  node --input-type=module <<'NODE'
const url = process.env.PIARIUM_HEALTH_URL;
const expectedVersion = process.env.PIARIUM_EXPECTED_VERSION;
const expectedReleaseId = process.env.PIARIUM_EXPECTED_RELEASE_ID;
const timeoutMs = Number(process.env.PIARIUM_HEALTH_TIMEOUT_SECONDS) * 1000;
const deadline = Date.now() + timeoutMs;
let lastError = 'no response';

while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    if (
      response.ok
      && body.status === 'ok'
      && body.piariumVersion === expectedVersion
      && body.releaseId === expectedReleaseId
      && body.piRuntime?.ready === true
      && body.piRuntime?.source === 'bundled'
    ) {
      console.log(`Piarium ${body.piariumVersion} is healthy with bundled Pi ${body.piRuntime.piVersion}.`);
      process.exit(0);
    }
    lastError = `status=${response.status} body=${JSON.stringify(body)}`;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.error(`Piarium health check timed out: ${lastError}`);
process.exit(1);
NODE
}

rollback() {
  local status=$?
  trap - ERR
  set +e
  if [[ "$ROLLBACK_REQUIRED" = "true" ]]; then
    echo "New Piarium release failed; rolling back." >&2
    stop_runtime "$RELEASE_DIR"
    if [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
      if ! atomic_link "$PREVIOUS_TARGET" "${ROOT}/current"; then
        echo "warning: failed to restore the current release link; restarting the previous runtime directly" >&2
      fi
      if ! start_runtime "$PREVIOUS_TARGET"; then
        echo "warning: failed to restart the previous Piarium runtime" >&2
      elif [[ -n "$PREVIOUS_VERSION" ]] && ! wait_for_health "$PREVIOUS_VERSION" "$(basename "$PREVIOUS_TARGET")"; then
        echo "warning: the previous Piarium runtime did not become healthy during rollback" >&2
      fi
    else
      rm -f "${ROOT}/current"
    fi
  fi
  exit "$status"
}

PREVIOUS_TARGET="$(current_target)"
PREVIOUS_VERSION=""
if [[ -n "$PREVIOUS_TARGET" && -f "${PREVIOUS_TARGET}/cloud-runtime.json" ]]; then
  PREVIOUS_VERSION="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(value.version||""));' "${PREVIOUS_TARGET}/cloud-runtime.json")"
fi

if [[ "$PREVIOUS_TARGET" = "$RELEASE_DIR" ]] && wait_for_health "$EXPECTED_VERSION" "$RELEASE_ID"; then
  rm -f "$ARCHIVE"
  echo "Piarium cloud deployment is already active: ${RELEASE_DIR}"
  exit 0
fi

ROLLBACK_REQUIRED="false"
trap rollback ERR
ROLLBACK_REQUIRED="true"

if [[ -n "$PREVIOUS_TARGET" ]]; then
  stop_runtime "$PREVIOUS_TARGET"
else
  stop_runtime "$RELEASE_DIR"
fi

atomic_link "$RELEASE_DIR" "${ROOT}/current"

start_runtime "$RELEASE_DIR"
wait_for_health "$EXPECTED_VERSION" "$RELEASE_ID"
ROLLBACK_REQUIRED="false"
trap - ERR

if [[ -n "$PREVIOUS_TARGET" && "$PREVIOUS_TARGET" != "$RELEASE_DIR" ]]; then
  atomic_link "$PREVIOUS_TARGET" "${ROOT}/previous"
fi

rm -f "$ARCHIVE"
echo "Piarium cloud deployment is active: ${RELEASE_DIR}"
