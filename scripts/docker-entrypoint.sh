#!/usr/bin/env sh
set -eu

HOME="/home/varin"
export HOME

VARIN_DATA_DIR="${VARIN_DATA_DIR:-${HOME}/.config/varin}"
export VARIN_DATA_DIR

VARIN_WORKSPACE_ROOT="${VARIN_WORKSPACE_ROOT:-${HOME}/workspaces}"
export VARIN_WORKSPACE_ROOT

VARIN_VALIDATION_NODE_MODULES="${VARIN_VALIDATION_NODE_MODULES:-${HOME}/.varin-validation/node_modules}"
export VARIN_VALIDATION_NODE_MODULES

if [ -z "${VARIN_RELEASE_ID:-}" ] && [ -f "/home/varin/app/cloud-runtime.json" ]; then
  VARIN_SOURCE_REVISION="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(value.sourceRevision||""));' /home/varin/app/cloud-runtime.json)"
  if [ -n "${VARIN_SOURCE_REVISION}" ]; then
    VARIN_RELEASE_ID="image-${VARIN_SOURCE_REVISION}"
    export VARIN_RELEASE_ID
  fi
fi

SSH_DIR="${HOME}/.ssh"
SSH_PRIVATE_KEY_PATH="${SSH_DIR}/id_ed25519"
SSH_PUBLIC_KEY_PATH="${SSH_PRIVATE_KEY_PATH}.pub"

mkdir -p "${VARIN_DATA_DIR}" "${VARIN_WORKSPACE_ROOT}" "${SSH_DIR}"
if ! chmod 700 "${SSH_DIR}" 2>/dev/null; then
  echo "[varin-entrypoint] warning: cannot chmod ${SSH_DIR}; continuing with existing permissions" >&2
fi

if [ ! -f "${SSH_PRIVATE_KEY_PATH}" ]; then
  if [ ! -w "${SSH_DIR}" ]; then
    echo "[varin-entrypoint] warning: SSH key is missing and ${SSH_DIR} is not writable; continuing without one" >&2
  else
    echo "[varin-entrypoint] generating SSH key..."
    if ! ssh-keygen -t ed25519 -N "" -f "${SSH_PRIVATE_KEY_PATH}" >/dev/null 2>&1; then
      echo "[varin-entrypoint] warning: failed to generate SSH key; continuing without one" >&2
    fi
  fi
elif [ ! -f "${SSH_PUBLIC_KEY_PATH}" ] && [ -w "${SSH_DIR}" ]; then
  if ! ssh-keygen -y -f "${SSH_PRIVATE_KEY_PATH}" > "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null; then
    rm -f "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null || true
    echo "[varin-entrypoint] warning: failed to recover the SSH public key" >&2
  fi
fi

if [ -f "${SSH_PRIVATE_KEY_PATH}" ] && ! chmod 600 "${SSH_PRIVATE_KEY_PATH}" 2>/dev/null; then
  echo "[varin-entrypoint] warning: cannot chmod ${SSH_PRIVATE_KEY_PATH}; continuing" >&2
fi

if [ -f "${SSH_PUBLIC_KEY_PATH}" ] && ! chmod 644 "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null; then
  echo "[varin-entrypoint] warning: cannot chmod ${SSH_PUBLIC_KEY_PATH}; continuing" >&2
fi

if [ -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  echo "[varin-entrypoint] SSH public key:"
  cat "${SSH_PUBLIC_KEY_PATH}"
fi

# Make the base image's validation-only TypeScript/Vitest tools available to
# mounted workspaces without installing or mutating project dependencies.
if [ -d "${VARIN_VALIDATION_NODE_MODULES}" ]; then
  WORKSPACE_NODE_MODULES="${VARIN_WORKSPACE_ROOT}/node_modules"
  if mkdir -p "${WORKSPACE_NODE_MODULES}/@types" "${WORKSPACE_NODE_MODULES}/.bin" 2>/dev/null; then
    if [ ! -e "${WORKSPACE_NODE_MODULES}/@types/node" ] && [ -e "${VARIN_VALIDATION_NODE_MODULES}/@types/node" ]; then
      ln -s "${VARIN_VALIDATION_NODE_MODULES}/@types/node" "${WORKSPACE_NODE_MODULES}/@types/node" 2>/dev/null || true
    fi
    if [ ! -e "${WORKSPACE_NODE_MODULES}/.bin/vitest" ] && [ -e "${VARIN_VALIDATION_NODE_MODULES}/.bin/vitest" ]; then
      ln -s "${VARIN_VALIDATION_NODE_MODULES}/.bin/vitest" "${WORKSPACE_NODE_MODULES}/.bin/vitest" 2>/dev/null || true
    fi
  else
    echo "[varin-entrypoint] warning: cannot prepare validation fallback modules under ${VARIN_WORKSPACE_ROOT}" >&2
  fi
fi

if [ -n "${VARIN_UI_PASSWORD:-}" ]; then
  echo "[varin-entrypoint] UI authentication is enabled"
fi

# Published containers bind on all interfaces so the mapped port is reachable.
VARIN_HOST="${VARIN_HOST:-0.0.0.0}"
export VARIN_HOST

# The data directory can survive while the PID namespace does not. Remove only
# Varin CLI registry state so recycled container PIDs cannot block startup.
if [ -d "${VARIN_DATA_DIR}/run" ]; then
  rm -f "${VARIN_DATA_DIR}"/run/varin-*.pid "${VARIN_DATA_DIR}"/run/varin-*.json 2>/dev/null || true
fi

echo "[varin-entrypoint] starting Varin..."

if [ "$#" -eq 0 ]; then
  set -- node packages/web/bin/cli.js serve --foreground
fi

exec "$@"
