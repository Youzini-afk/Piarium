#!/usr/bin/env sh
set -eu

HOME="/home/openchamber"

PIARIUM_DATA_DIR="${PIARIUM_DATA_DIR:-${HOME}/.config/openchamber}"
export PIARIUM_DATA_DIR

PIARIUM_WORKSPACE_ROOT="${PIARIUM_WORKSPACE_ROOT:-${HOME}/workspaces}"
export PIARIUM_WORKSPACE_ROOT

PIARIUM_VALIDATION_NODE_MODULES="${PIARIUM_VALIDATION_NODE_MODULES:-${HOME}/.openchamber-validation/node_modules}"
export PIARIUM_VALIDATION_NODE_MODULES

SSH_DIR="${HOME}/.ssh"
SSH_PRIVATE_KEY_PATH="${SSH_DIR}/id_ed25519"
SSH_PUBLIC_KEY_PATH="${SSH_PRIVATE_KEY_PATH}.pub"

mkdir -p "${SSH_DIR}"
if ! chmod 700 "${SSH_DIR}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_DIR}, continuing with existing permissions"
fi

if [ ! -f "${SSH_PRIVATE_KEY_PATH}" ] || [ ! -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  if [ ! -w "${SSH_DIR}" ]; then
    echo "[entrypoint] warning: ssh key missing and ${SSH_DIR} is not writable, continuing without SSH key" >&2
  else
    echo "[entrypoint] generating SSH key..."
    if ! ssh-keygen -t ed25519 -N "" -f "${SSH_PRIVATE_KEY_PATH}" >/dev/null 2>&1; then
      echo "[entrypoint] warning: failed to generate SSH key, continuing without SSH key" >&2
    fi
  fi
fi

if ! chmod 600 "${SSH_PRIVATE_KEY_PATH}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_PRIVATE_KEY_PATH}, continuing"
fi

if ! chmod 644 "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_PUBLIC_KEY_PATH}, continuing"
fi

if [ -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  echo "[entrypoint] SSH public key:"
  cat "${SSH_PUBLIC_KEY_PATH}"
fi

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
    echo "[entrypoint] warning: cannot prepare validation fallback node_modules under ${PIARIUM_WORKSPACE_ROOT}" >&2
  fi
fi

# Handle UI password environment variables. UI_PASSWORD is kept as a legacy
# alias; PIARIUM_UI_PASSWORD is the canonical runtime variable.
if [ -z "${PIARIUM_UI_PASSWORD:-}" ] && [ -n "${UI_PASSWORD:-}" ]; then
  PIARIUM_UI_PASSWORD="$UI_PASSWORD"
  export PIARIUM_UI_PASSWORD
fi

if [ -n "${PIARIUM_UI_PASSWORD:-}" ]; then
  echo "[entrypoint] UI password set, enabling authentication"
fi

# Docker containers need to listen on all interfaces for port mapping to work.
PIARIUM_HOST="${PIARIUM_HOST:-0.0.0.0}"
export PIARIUM_HOST

echo "[entrypoint] starting..."

# PID/instance files are runtime state. In container deployments the data dir can
# be persisted across pod restarts while the PID namespace is recreated, so an
# old PID can point at an unrelated process in the new container and make the CLI
# think OpenChamber is already running. Clear stale runtime files before start.
if [ -d "${PIARIUM_DATA_DIR}/run" ]; then
  rm -f "${PIARIUM_DATA_DIR}"/run/openchamber-*.pid "${PIARIUM_DATA_DIR}"/run/openchamber-*.json 2>/dev/null || true
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

set -- bun packages/web/bin/cli.js --foreground
if [ -n "${PIARIUM_UI_PASSWORD:-}" ]; then
  set -- "$@" --ui-password "$PIARIUM_UI_PASSWORD"
fi
exec "$@"
