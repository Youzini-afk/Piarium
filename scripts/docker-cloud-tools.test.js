import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const readRepoFile = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const appDockerfile = readRepoFile('Dockerfile');
const runtimeBaseDockerfile = readRepoFile('Dockerfile.base');
const dockerBuildOnlyWrapper = readRepoFile('scripts/docker-build-only-wrapper.sh');
const dockerEntrypoint = readRepoFile('scripts/docker-entrypoint.sh');
const dockerCompose = readRepoFile('docker-compose.yml');
const dockerIgnore = readRepoFile('.dockerignore');
const dockerWorkflow = readRepoFile('.github/workflows/docker.yml');

const containerSources = {
  Dockerfile: appDockerfile,
  'Dockerfile.base': runtimeBaseDockerfile,
  'docker-compose.yml': dockerCompose,
  '.dockerignore': dockerIgnore,
  'scripts/docker-build-only-wrapper.sh': dockerBuildOnlyWrapper,
  'scripts/docker-entrypoint.sh': dockerEntrypoint,
  '.github/workflows/docker.yml': dockerWorkflow,
};

const getAptInstallPackages = () => {
  const matches = runtimeBaseDockerfile.matchAll(/apt-get install\s+-y\s+--no-install-recommends\s+([\s\S]*?)(?=\s+&&)/g);
  return new Set(Array.from(matches).flatMap((match) => (
    match[1]
      .replace(/\\/g, ' ')
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
  )));
};

const aptInstallPackages = getAptInstallPackages();

describe('Piarium cloud container runtime', () => {
  it('builds the canonical four-package runtime tree before the target-platform install', () => {
    const runtimeArg = 'ARG RUNTIME_BASE_IMAGE=ghcr.io/youzini-afk/piarium-runtime-base:main';
    expect(appDockerfile.indexOf(runtimeArg)).toBeGreaterThanOrEqual(0);
    expect(appDockerfile.indexOf('FROM ')).toBeGreaterThan(appDockerfile.indexOf(runtimeArg));
    expect(appDockerfile).toContain('FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS builder');

    for (const packageDirectory of [
      'extension-builtins',
      'extension-contract',
      'extension-host',
      'extension-loader',
      'extension-sdk',
      'extension-surface',
      'protocol',
      'pi-host',
      'runtime-broker',
      'web',
    ]) {
      expect(appDockerfile).toContain(`COPY packages/${packageDirectory}/package.json ./packages/${packageDirectory}/package.json`);
    }

    expect(appDockerfile).toContain('bun run build:cloud-runtime -- --output /app/artifacts/cloud-runtime --no-archive');
    expect(appDockerfile).toContain('COPY --from=builder --chown=piarium:piarium /app/artifacts/cloud-runtime/ ./');
    expect(appDockerfile).toContain('FROM ${RUNTIME_BASE_IMAGE} AS runtime');
    expect(appDockerfile).toContain('WORKDIR /home/piarium/app');
    expect(appDockerfile).toContain('bun install --production --frozen-lockfile');
    expect(appDockerfile).toContain("import('./packages/web/node_modules/@piarium/runtime-broker/dist/index.js')");
    expect(appDockerfile).toContain("typeof broker.resolveBundledPiHostEntry !== 'function'");
    expect(appDockerfile).not.toMatch(/COPY --from=(?:deps|builder) \/app\/node_modules/);
  });

  it('runs the published server with Node and exposes a real health check', () => {
    expect(appDockerfile).toContain('ENV HOME=/home/piarium');
    expect(appDockerfile).toContain('PIARIUM_DATA_DIR=/home/piarium/.config/piarium');
    expect(appDockerfile).toContain('COPY --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/piarium-entrypoint');
    expect(appDockerfile).toContain('ENTRYPOINT ["/usr/local/bin/piarium-entrypoint"]');
    expect(appDockerfile).toContain('CMD ["node", "packages/web/bin/cli.js", "serve", "--foreground"]');
    expect(appDockerfile).toContain('HEALTHCHECK');
    expect(appDockerfile).toContain('http://127.0.0.1:3000/health');
    expect(appDockerfile).not.toContain('apt-get install');
    expect(appDockerfile).not.toContain('rustup.rs');
    expect(appDockerfile).not.toContain('playwright install --with-deps chrome');
  });

  it('applies repository patches before building', () => {
    expect(appDockerfile).toContain('COPY bun-patches ./bun-patches');
    expect(appDockerfile).toContain('COPY patches ./patches');
    expect(appDockerfile).toContain('COPY fix-deprecation.js ./');
    expect(appDockerfile).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(appDockerfile).toContain('node ./fix-deprecation.js');
    expect(appDockerfile).toContain('node ./node_modules/patch-package/index.js');
    expect(appDockerfile).not.toContain('repair-pi-shrinkwrap');
  });

  it('uses one Piarium container identity and only the canonical password variable', () => {
    expect(runtimeBaseDockerfile).toContain('groupadd -g 1000 piarium');
    expect(runtimeBaseDockerfile).toContain('useradd -u 1000 -g 1000 -m -s /bin/bash piarium');
    expect(runtimeBaseDockerfile).toContain('USER piarium');
    expect(runtimeBaseDockerfile).toContain('ENV HOME=/home/piarium');
    expect(runtimeBaseDockerfile).toContain('PIARIUM_VALIDATION_NODE_MODULES=/home/piarium/.piarium-validation/node_modules');
    expect(runtimeBaseDockerfile).toContain("echo 'piarium:100000:65536' >> /etc/subuid");
    expect(runtimeBaseDockerfile).toContain("echo 'piarium:100000:65536' >> /etc/subgid");

    expect(dockerEntrypoint).toContain('HOME="/home/piarium"');
    expect(dockerEntrypoint).toContain('${HOME}/.config/piarium');
    expect(dockerEntrypoint).toContain('${HOME}/.piarium-validation/node_modules');
    expect(dockerEntrypoint).toContain('/run/piarium-*.pid');
    expect(dockerEntrypoint).toContain('/run/piarium-*.json');
    expect(dockerEntrypoint).toContain('set -- node packages/web/bin/cli.js serve --foreground');
    expect(dockerEntrypoint).toContain('PIARIUM_UI_PASSWORD');

    const withoutCanonicalPassword = dockerEntrypoint.replaceAll('PIARIUM_UI_PASSWORD', '');
    expect(withoutCanonicalPassword).not.toContain('UI_PASSWORD');
  });

  it('retains the complete multi-architecture cloud toolbelt', () => {
    expect(runtimeBaseDockerfile).toContain('FROM oven/bun:1.3.14 AS runtime-base');

    for (const packageName of [
      'build-essential',
      'cmake',
      'default-jdk-headless',
      'maven',
      'python3',
      'python3-dev',
      'python3-pip',
      'python3-venv',
      'ripgrep',
      'slirp4netns',
      'uidmap',
    ]) {
      expect(aptInstallPackages.has(packageName), `${packageName} is installed`).toBe(true);
    }

    expect(runtimeBaseDockerfile).toContain('https://cli.github.com/packages');
    expect(runtimeBaseDockerfile).toContain('apt-get install -y --no-install-recommends gh');
    expect(runtimeBaseDockerfile).toContain('ARG GO_VERSION=1.26.3');
    expect(runtimeBaseDockerfile).toContain('ARG GOPLS_VERSION=v0.21.1');
    expect(runtimeBaseDockerfile).toContain('go install golang.org/x/tools/gopls@${GOPLS_VERSION}');
    expect(runtimeBaseDockerfile).toContain('ARG NODE_VERSION=24.15.0');
    expect(runtimeBaseDockerfile).toContain('ARG NODE_TYPES_VERSION=24.12.4');
    expect(runtimeBaseDockerfile).toContain('ARG VITEST_VERSION=4.1.6');
    expect(runtimeBaseDockerfile).toContain('npm install -g pnpm tsx typescript typescript-language-server yarn');
    expect(runtimeBaseDockerfile).toContain('https://sh.rustup.rs');
    expect(runtimeBaseDockerfile).toContain('rustup component add rust-analyzer rustfmt');
    expect(runtimeBaseDockerfile).toContain('npx --yes playwright install --with-deps chrome');
    expect(runtimeBaseDockerfile).toContain('Google Chrome for Linux is only available on amd64');
    expect(runtimeBaseDockerfile).toContain('amd64|x86_64)');
    expect(runtimeBaseDockerfile).toContain('arm64|aarch64)');
    expect(runtimeBaseDockerfile).toContain('COPY --from=cloudflare/cloudflared@sha256:');
    expect(runtimeBaseDockerfile).toContain('RUN cloudflared --version');
  });

  it('keeps daemonless BuildKit build-only and refuses daemon access', () => {
    expect(runtimeBaseDockerfile).toContain('moby/buildkit@sha256:0ffa2fcf6b8757c47d569b3ef0f03f9d5eb3b9ff5ce68d858f994f89b749da0c');
    expect(runtimeBaseDockerfile).toContain('v0.26.2 rootless/daemonless');
    expect(runtimeBaseDockerfile).toContain('/usr/bin/rootlesskit /usr/local/bin/rootlesskit');
    expect(runtimeBaseDockerfile).toContain('COPY --chmod=0755 scripts/docker-build-only-wrapper.sh /usr/local/bin/docker');

    expect(dockerBuildOnlyWrapper).toContain('Piarium Docker build-only mode is active.');
    expect(dockerBuildOnlyWrapper).toContain('buildctl-daemonless.sh build');
    expect(dockerBuildOnlyWrapper).toContain('--output" "type=cacheonly');
    expect(dockerBuildOnlyWrapper).toContain('registry push outputs are disabled');
    expect(dockerBuildOnlyWrapper).toContain('force-network-mode=none');
    expect(dockerBuildOnlyWrapper).toContain("export ROOTLESSKIT=\"${ROOTLESSKIT:-}\"");
    expect(dockerBuildOnlyWrapper).toContain('run|compose|ps|exec|pull|push');
    expect(dockerBuildOnlyWrapper).toContain('/var/run/docker.sock');
  });

  it('provides persistent Piarium data, SSH, workspace, and tunnel configuration in Compose', () => {
    expect(dockerCompose).toContain('image: ${PIARIUM_IMAGE:-ghcr.io/youzini-afk/piarium:latest}');
    expect(dockerCompose).toContain('RUNTIME_BASE_IMAGE: ${PIARIUM_RUNTIME_BASE_IMAGE:-ghcr.io/youzini-afk/piarium-runtime-base:main}');
    expect(dockerCompose).toContain('user: "1000:1000"');
    expect(dockerCompose).toContain('./data/piarium:/home/piarium/.config/piarium');
    expect(dockerCompose).toContain('./data/ssh:/home/piarium/.ssh');
    expect(dockerCompose).toContain('./data/cloudflared:/home/piarium/.cloudflared');
    expect(dockerCompose).toContain('./workspaces:/home/piarium/workspaces');
    expect(dockerCompose).toContain('PIARIUM_UI_PASSWORD: ${PIARIUM_UI_PASSWORD:?');
    expect(dockerCompose).toContain('PIARIUM_TUNNEL_PROVIDER:');
    expect(dockerCompose).toContain('PIARIUM_TUNNEL_MODE:');
    expect(dockerCompose).toContain('PIARIUM_TUNNEL_HOSTNAME:');
    expect(dockerCompose).toContain('PIARIUM_TUNNEL_TOKEN:');
    expect(dockerCompose).toContain('PIARIUM_TUNNEL_CONFIG:');
  });

  it('keeps local caches and generated artifacts out of the build context', () => {
    for (const ignoredPath of ['.bun-cache', '**/.bun-cache', '.agents', '.opencode', '.openchamber', 'artifacts', '**/artifacts', 'data', 'workspaces']) {
      expect(dockerIgnore.split(/\r?\n/)).toContain(ignoredPath);
    }
  });

  it('contains no retired product names in the container contract', () => {
    const retiredNames = [
      ['open', 'chamber'].join(''),
      ['open', 'code'].join(''),
    ];
    for (const [sourceName, source] of Object.entries(containerSources)) {
      if (sourceName === '.dockerignore') continue;
      for (const retiredName of retiredNames) {
        expect(source.toLowerCase(), `${sourceName} contains ${retiredName}`).not.toContain(retiredName);
      }
    }
  });
});

describe('Piarium container publication', () => {
  it('uses a single Docker workflow and publishes base before app', () => {
    const workflowDirectory = path.join(repoRoot, '.github', 'workflows');
    const dockerWorkflows = fs.readdirSync(workflowDirectory)
      .filter((fileName) => /\.ya?ml$/.test(fileName))
      .filter((fileName) => {
        const source = fs.readFileSync(path.join(workflowDirectory, fileName), 'utf8');
        return source.includes('docker/build-push-action') || /^\s*file:\s*Dockerfile(?:\.base)?\s*$/m.test(source);
      });

    expect(dockerWorkflows).toEqual(['docker.yml']);
    expect(dockerWorkflow).toContain('quality-gate:');
    expect(dockerWorkflow).toContain('build-runtime-base:');
    expect(dockerWorkflow).toContain('needs: [quality-gate, build-runtime-base]');
    expect(dockerWorkflow).toContain('digest: ${{ steps.build.outputs.digest }}');
    expect(dockerWorkflow).toContain('BASE_DIGEST: ${{ needs.build-runtime-base.outputs.digest }}');
    expect(dockerWorkflow).toContain('image=${REGISTRY}/${BASE_IMAGE_NAME}@${BASE_DIGEST}');
    expect(dockerWorkflow).toContain('- scripts/cloud-runtime.bun.lock');
  });

  it('builds multi-architecture candidates and promotes main, latest, sha, and semver tags with GHA caches', () => {
    expect(dockerWorkflow.match(/platforms: linux\/amd64,linux\/arm64/g)).toHaveLength(2);
    expect(dockerWorkflow).toContain('type=raw,value=main');
    expect(dockerWorkflow).toContain('type=raw,value=latest');
    expect(dockerWorkflow).toContain('type=sha,format=short,prefix=sha-');
    expect(dockerWorkflow).toContain('type=semver,pattern={{version}}');
    expect(dockerWorkflow).toContain('cache-from: type=gha,scope=piarium-runtime-base');
    expect(dockerWorkflow).toContain('cache-to: type=gha,scope=piarium-runtime-base,mode=max');
    expect(dockerWorkflow).toContain('cache-from: type=gha,scope=piarium-app');
    expect(dockerWorkflow).toContain('cache-to: type=gha,scope=piarium-app,mode=max');
    expect(dockerWorkflow.match(/provenance: mode=max/g)).toHaveLength(2);
    expect(dockerWorkflow.match(/sbom: true/g)).toHaveLength(2);
    expect(dockerWorkflow).toContain(':candidate-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(dockerWorkflow).toContain('promote:');
    expect(dockerWorkflow.match(/docker buildx imagetools create/g)).toHaveLength(2);
  });

  it('supports a manual base override without passing runtime secrets as build arguments', () => {
    expect(dockerWorkflow).toContain('workflow_dispatch:');
    expect(dockerWorkflow).toContain('runtime_base_image:');
    expect(dockerWorkflow).toContain("inputs.runtime_base_image == ''");
    expect(dockerWorkflow).toContain('docker buildx imagetools inspect "$BASE_OVERRIDE"');
    expect(dockerWorkflow).toContain('image=${base_repository}@${resolved_digest}');
    expect(dockerWorkflow).toContain('RUNTIME_BASE_IMAGE=${{ steps.runtime-base.outputs.image }}');
    expect(dockerWorkflow).not.toContain('PIARIUM_UI_PASSWORD=${{ secrets.');
    expect(dockerWorkflow).not.toContain('PIARIUM_TUNNEL_TOKEN=${{ secrets.');
  });

  it('smokes the immutable amd64 candidate before promoting any installable tag', () => {
    expect(dockerWorkflow).toContain('smoke-amd64:');
    expect(dockerWorkflow).toContain('docker pull --platform linux/amd64');
    expect(dockerWorkflow).toContain('docker run --detach');
    expect(dockerWorkflow).toContain('curl --fail --silent --show-error http://127.0.0.1:3000/health');
    expect(dockerWorkflow).toContain("import('./packages/web/node_modules/@piarium/runtime-broker/dist/index.js')");
    expect(dockerWorkflow).toContain('broker.resolveBundledPiHostEntry()');
    expect(dockerWorkflow).toContain("new URL('./index.js', pathToFileURL(entry))");
    expect(dockerWorkflow).not.toContain("require.resolve('@piarium/pi-host')");
    expect(dockerWorkflow).toContain('EXPECTED_RELEASE_ID: image-${{ github.sha }}');
    expect(dockerWorkflow).toContain('health.releaseId!==process.env.EXPECTED_RELEASE_ID');
    expect(dockerWorkflow.indexOf('smoke-amd64:')).toBeLessThan(dockerWorkflow.indexOf('promote:'));
    expect(dockerWorkflow).toContain("needs.smoke-amd64.result == 'success'");
  });

  it('builds and smokes the coupled base and app images on pull requests without publishing to GHCR', () => {
    expect(dockerWorkflow).toContain('pull_request:');
    expect(dockerWorkflow).toContain('verify-pr-image:');
    expect(dockerWorkflow).toContain('localhost:5000/piarium-runtime-base:pr-${{ github.sha }}');
    expect(dockerWorkflow).toContain('piarium:pr-${{ github.sha }}');
    expect(dockerWorkflow).toContain("github.event_name == 'pull_request'");
  });
});
