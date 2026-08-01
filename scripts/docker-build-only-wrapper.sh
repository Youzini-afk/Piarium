#!/usr/bin/env bash
set -euo pipefail

PROGRAM_NAME="docker"

print_build_only_notice() {
  cat >&2 <<'EOF'
OpenChamber Docker build-only mode is active.
This container does not expose a Docker daemon or host Docker socket.
Supported: docker build / docker buildx build (daemonless BuildKit).
Rejected: docker run, docker compose, docker ps, docker exec, docker pull/push, and daemon control commands.
EOF
}

print_version() {
  cat <<'EOF'
Docker build-only compatibility wrapper for OpenChamber
Backend: daemonless BuildKit (no Docker daemon, no /var/run/docker.sock)
EOF
  if command -v buildctl >/dev/null 2>&1; then
    buildctl --version || true
  fi
}

usage() {
  print_version
  cat <<'EOF'

Usage:
  docker build [OPTIONS] PATH
  docker buildx build [OPTIONS] PATH
  docker version
  docker --version

Common supported build options:
  -f, --file FILE
  -t, --tag TAG               Accepted for compatibility; no daemon image is created.
      --build-arg KEY=VALUE
      --target STAGE
      --platform PLATFORM
      --no-cache
      --pull
      --progress MODE
      --label KEY=VALUE
  -o, --output OUTPUT         BuildKit output, e.g. type=oci,dest=/tmp/image.tar
      --secret SPEC
      --ssh SPEC
      --network default|none  host networking is refused

Without --output, the wrapper uses BuildKit cache-only output. This validates the
Dockerfile build but does not create a local image usable by docker run.
EOF
}

reject_command() {
  local command_name="${1:-unknown}"
  cat >&2 <<EOF
Docker command '${command_name}' is disabled in this OpenChamber container.

Reason: this is a shared-host safe build-only environment. The host Docker daemon
and /var/run/docker.sock are intentionally unavailable.

Use 'docker build ...' to validate Dockerfiles with daemonless BuildKit. To run
containers, use a separate trusted runner/VM or a private self-hosted deployment
where you explicitly accept Docker host access risks.
EOF
  exit 125
}

require_value() {
  local option_name="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "${PROGRAM_NAME}: option '${option_name}' requires a value" >&2
    exit 125
  fi
}

normalize_path() {
  local value="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$value"
  else
    python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$value"
  fi
}

add_network_frontend_opt() {
  local value="$1"
  case "$value" in
    default|"")
      ;;
    none)
      frontend_opts+=("--opt" "force-network-mode=none")
      ;;
    host)
      echo "${PROGRAM_NAME}: --network=host is disabled in build-only mode" >&2
      exit 125
      ;;
    *)
      echo "${PROGRAM_NAME}: unsupported network mode '${value}' in build-only mode; use default or none" >&2
      exit 125
      ;;
  esac
}

add_output_arg() {
  local spec="$1"
  local type=""

  if [[ "$spec" == type=* ]]; then
    type="${spec#type=}"
    type="${type%%,*}"
  else
    echo "${PROGRAM_NAME}: --output must include an explicit type=... value in build-only mode" >&2
    exit 125
  fi

  if [[ "$spec" == *"push=true"* ]]; then
    echo "${PROGRAM_NAME}: registry push outputs are disabled in build-only mode" >&2
    exit 125
  fi

  case "$type" in
    cacheonly)
      ;;
    oci|docker|tar|local)
      if [[ "$spec" != *",dest="* ]]; then
        echo "${PROGRAM_NAME}: --output type=${type} requires dest=... in build-only mode" >&2
        exit 125
      fi
      ;;
    image|registry)
      echo "${PROGRAM_NAME}: --output type=${type} is disabled in build-only mode" >&2
      exit 125
      ;;
    *)
      echo "${PROGRAM_NAME}: unsupported --output type=${type} in build-only mode" >&2
      exit 125
      ;;
  esac

  buildctl_args+=("--output" "$spec")
}

run_build() {
  local dockerfile="Dockerfile"
  local context="."
  local progress="auto"
  local has_output="0"
  local -a frontend_opts=()
  local -a buildctl_args=()
  local -a tags=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--file)
        require_value "$1" "${2:-}"
        dockerfile="$2"
        shift 2
        ;;
      --file=*)
        dockerfile="${1#--file=}"
        shift
        ;;
      -t|--tag)
        require_value "$1" "${2:-}"
        tags+=("$2")
        shift 2
        ;;
      --tag=*)
        tags+=("${1#--tag=}")
        shift
        ;;
      --build-arg)
        require_value "$1" "${2:-}"
        frontend_opts+=("--opt" "build-arg:${2}")
        shift 2
        ;;
      --build-arg=*)
        frontend_opts+=("--opt" "build-arg:${1#--build-arg=}")
        shift
        ;;
      --target)
        require_value "$1" "${2:-}"
        frontend_opts+=("--opt" "target=${2}")
        shift 2
        ;;
      --target=*)
        frontend_opts+=("--opt" "target=${1#--target=}")
        shift
        ;;
      --platform)
        require_value "$1" "${2:-}"
        frontend_opts+=("--opt" "platform=${2}")
        shift 2
        ;;
      --platform=*)
        frontend_opts+=("--opt" "platform=${1#--platform=}")
        shift
        ;;
      --label)
        require_value "$1" "${2:-}"
        frontend_opts+=("--opt" "label:${2}")
        shift 2
        ;;
      --label=*)
        frontend_opts+=("--opt" "label:${1#--label=}")
        shift
        ;;
      --network)
        require_value "$1" "${2:-}"
        add_network_frontend_opt "$2"
        shift 2
        ;;
      --network=*)
        add_network_frontend_opt "${1#--network=}"
        shift
        ;;
      --no-cache)
        buildctl_args+=("--no-cache")
        shift
        ;;
      --pull)
        frontend_opts+=("--opt" "image-resolve-mode=force-pull")
        shift
        ;;
      --progress)
        require_value "$1" "${2:-}"
        progress="$2"
        shift 2
        ;;
      --progress=*)
        progress="${1#--progress=}"
        shift
        ;;
      -o|--output)
        require_value "$1" "${2:-}"
        add_output_arg "$2"
        has_output="1"
        shift 2
        ;;
      --output=*)
        add_output_arg "${1#--output=}"
        has_output="1"
        shift
        ;;
      --secret)
        require_value "$1" "${2:-}"
        buildctl_args+=("--secret" "$2")
        shift 2
        ;;
      --secret=*)
        buildctl_args+=("--secret" "${1#--secret=}")
        shift
        ;;
      --ssh)
        require_value "$1" "${2:-}"
        buildctl_args+=("--ssh" "$2")
        shift 2
        ;;
      --ssh=*)
        buildctl_args+=("--ssh" "${1#--ssh=}")
        shift
        ;;
      --load|--push)
        echo "${PROGRAM_NAME}: ${1} is disabled; no Docker daemon or registry push is available in build-only mode" >&2
        exit 125
        ;;
      --rm|--force-rm|--compress)
        # Docker compatibility no-op for BuildKit.
        shift
        ;;
      --)
        shift
        if [[ $# -gt 0 ]]; then
          context="$1"
          shift
        fi
        ;;
      -*)
        echo "${PROGRAM_NAME}: unsupported build option '${1}' in build-only mode" >&2
        exit 125
        ;;
      *)
        context="$1"
        shift
        ;;
    esac
  done

  local context_path
  context_path="$(normalize_path "$context")"
  local dockerfile_path
  if [[ "$dockerfile" = /* ]]; then
    dockerfile_path="$(normalize_path "$dockerfile")"
  else
    dockerfile_path="$(normalize_path "${context_path}/${dockerfile}")"
  fi
  local dockerfile_dir
  dockerfile_dir="$(dirname "$dockerfile_path")"
  local dockerfile_name
  dockerfile_name="$(basename "$dockerfile_path")"

  if [[ ! -d "$context_path" ]]; then
    echo "${PROGRAM_NAME}: build context does not exist or is not a directory: ${context}" >&2
    exit 125
  fi
  if [[ ! -f "$dockerfile_path" ]]; then
    echo "${PROGRAM_NAME}: Dockerfile not found: ${dockerfile}" >&2
    exit 125
  fi

  if [[ "$has_output" == "0" ]]; then
    buildctl_args+=("--output" "type=cacheonly")
  fi

  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/openchamber-buildkit-${UID}}"
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

  export BUILDKITD_FLAGS="${BUILDKITD_FLAGS:---oci-worker-no-process-sandbox --oci-worker-snapshotter=native}"
  # Keep the default compatible with restricted Docker build/runtime environments
  # that disallow rootlesskit's user namespace setup. buildctl-daemonless.sh will
  # start buildkitd directly as the non-root openchamber user when ROOTLESSKIT is
  # empty. Operators who know their runtime supports rootlesskit can override this
  # env var, for example:
  #   ROOTLESSKIT='rootlesskit --net=slirp4netns --copy-up=/etc --disable-host-loopback'
  export ROOTLESSKIT="${ROOTLESSKIT:-}"

  print_build_only_notice
  if [[ ${#tags[@]} -gt 0 && "$has_output" == "0" ]]; then
    printf 'Note: tag(s) accepted for compatibility only; no local Docker image will be created: %s\n' "${tags[*]}" >&2
  fi

  exec buildctl-daemonless.sh build \
    --frontend=dockerfile.v0 \
    --local "context=${context_path}" \
    --local "dockerfile=${dockerfile_dir}" \
    --opt "filename=${dockerfile_name}" \
    --progress "$progress" \
    "${frontend_opts[@]}" \
    "${buildctl_args[@]}"
}

if [[ $# -eq 0 ]]; then
  usage
  exit 0
fi

case "${1:-}" in
  --version|-v)
    print_version
    exit 0
    ;;
  --help|-h|help)
    usage
    exit 0
    ;;
  version)
    print_version
    exit 0
    ;;
  build)
    shift
    run_build "$@"
    ;;
  buildx)
    shift
    case "${1:-}" in
      build)
        shift
        run_build "$@"
        ;;
      version|--version|-v)
        print_version
        ;;
      *)
        reject_command "buildx ${1:-}"
        ;;
    esac
    ;;
  run|compose|ps|exec|pull|push|login|logout|images|container|volume|network|system|info|context)
    reject_command "$1"
    ;;
  image)
    shift
    if [[ "${1:-}" == "build" ]]; then
      shift
      run_build "$@"
    fi
    reject_command "image ${1:-}"
    ;;
  *)
    reject_command "$1"
    ;;
esac
