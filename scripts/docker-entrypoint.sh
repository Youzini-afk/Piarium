#!/usr/bin/env sh
set -eu

HOME="/home/piarium"
export HOME

PIARIUM_DATA_DIR="${PIARIUM_DATA_DIR:-${HOME}/.config/piarium}"
export PIARIUM_DATA_DIR

PIARIUM_WORKSPACE_ROOT="${PIARIUM_WORKSPACE_ROOT:-${HOME}/workspaces}"
export PIARIUM_WORKSPACE_ROOT

PIARIUM_VALIDATION_NODE_MODULES="${PIARIUM_VALIDATION_NODE_MODULES:-${HOME}/.piarium-validation/node_modules}"
export PIARIUM_VALIDATION_NODE_MODULES

if [ -z "${PIARIUM_RELEASE_ID:-}" ] && [ -f "/home/piarium/app/cloud-runtime.json" ]; then
  PIARIUM_SOURCE_REVISION="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(value.sourceRevision||""));' /home/piarium/app/cloud-runtime.json)"
  if [ -n "${PIARIUM_SOURCE_REVISION}" ]; then
    PIARIUM_RELEASE_ID="image-${PIARIUM_SOURCE_REVISION}"
    export PIARIUM_RELEASE_ID
  fi
fi

SSH_DIR="${HOME}/.ssh"
SSH_PRIVATE_KEY_PATH="${SSH_DIR}/id_ed25519"
SSH_PUBLIC_KEY_PATH="${SSH_PRIVATE_KEY_PATH}.pub"

mkdir -p "${PIARIUM_DATA_DIR}" "${PIARIUM_WORKSPACE_ROOT}" "${SSH_DIR}"
if ! chmod 700 "${SSH_DIR}" 2>/dev/null; then
  echo "[piarium-entrypoint] warning: cannot chmod ${SSH_DIR}; continuing with existing permissions" >&2
fi

if [ ! -f "${SSH_PRIVATE_KEY_PATH}" ]; then
  if [ ! -w "${SSH_DIR}" ]; then
    echo "[piarium-entrypoint] warning: SSH key is missing and ${SSH_DIR} is not writable; continuing without one" >&2
  else
    echo "[piarium-entrypoint] generating SSH key..."
    if ! ssh-keygen -t ed25519 -N "" -f "${SSH_PRIVATE_KEY_PATH}" >/dev/null 2>&1; then
      echo "[piarium-entrypoint] warning: failed to generate SSH key; continuing without one" >&2
    fi
  fi
elif [ ! -f "${SSH_PUBLIC_KEY_PATH}" ] && [ -w "${SSH_DIR}" ]; then
  if ! ssh-keygen -y -f "${SSH_PRIVATE_KEY_PATH}" > "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null; then
    rm -f "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null || true
    echo "[piarium-entrypoint] warning: failed to recover the SSH public key" >&2
  fi
fi

if [ -f "${SSH_PRIVATE_KEY_PATH}" ] && ! chmod 600 "${SSH_PRIVATE_KEY_PATH}" 2>/dev/null; then
  echo "[piarium-entrypoint] warning: cannot chmod ${SSH_PRIVATE_KEY_PATH}; continuing" >&2
fi

if [ -f "${SSH_PUBLIC_KEY_PATH}" ] && ! chmod 644 "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null; then
  echo "[piarium-entrypoint] warning: cannot chmod ${SSH_PUBLIC_KEY_PATH}; continuing" >&2
fi

if [ -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  echo "[piarium-entrypoint] SSH public key:"
  cat "${SSH_PUBLIC_KEY_PATH}"
fi

# Make the base image's validation-only TypeScript/Vitest tools available to
# mounted workspaces without installing or mutating project dependencies.
if [ -d "${PIARIUM_VALIDATION_NODE_MODULES}" ]; then
  WORKSPACE_NODE_MODULES="${PIARIUM_WORKSPACE_ROOT}/node_modules"
  if mkdir -p "${WORKSPACE_NODE_MODULES}/@types" "${WORKSPACE_NODE_MODULES}/.bin" 2>/dev/null; then
    if [ ! -e "${WORKSPACE_NODE_MODULES}/@types/node" ] && [ -e "${PIARIUM_VALIDATION_NODE_MODULES}/@types/node" ]; then
      ln -s "${PIARIUM_VALIDATION_NODE_MODULES}/@types/node" "${WORKSPACE_NODE_MODULES}/@types/node" 2>/dev/null || true
    fi
    if [ ! -e "${WORKSPACE_NODE_MODULES}/.bin/vitest" ] && [ -e "${PIARIUM_VALIDATION_NODE_MODULES}/.bin/vitest" ]; then
      ln -s "${PIARIUM_VALIDATION_NODE_MODULES}/.bin/vitest" "${WORKSPACE_NODE_MODULES}/.bin/vitest" 2>/dev/null || true
    fi
  else
    echo "[piarium-entrypoint] warning: cannot prepare validation fallback modules under ${PIARIUM_WORKSPACE_ROOT}" >&2
  fi
fi

if [ -n "${PIARIUM_UI_PASSWORD:-}" ]; then
  echo "[piarium-entrypoint] UI authentication is enabled"
fi

# Published containers bind on all interfaces so the mapped port is reachable.
PIARIUM_HOST="${PIARIUM_HOST:-0.0.0.0}"
export PIARIUM_HOST

# The data directory can survive while the PID namespace does not. Remove only
# Piarium CLI registry state so recycled container PIDs cannot block startup.
if [ -d "${PIARIUM_DATA_DIR}/run" ]; then
  rm -f "${PIARIUM_DATA_DIR}"/run/piarium-*.pid "${PIARIUM_DATA_DIR}"/run/piarium-*.json 2>/dev/null || true
fi

echo "[piarium-entrypoint] starting Piarium..."

if [ "$#" -eq 0 ]; then
  set -- node packages/web/bin/cli.js serve --foreground
fi

exec "$@"
