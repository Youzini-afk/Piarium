import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const deployScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'deploy-cloud-runtime.sh'), 'utf8');
const developmentHelper = fs.readFileSync(path.join(repoRoot, 'scripts', 'oc-dev.mjs'), 'utf8');
const configExample = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'scripts', 'oc-dev.config.example.json'),
  'utf8',
));

describe('Piarium remote cloud deployment', () => {
  it('uploads the canonical runtime archive instead of an incomplete npm package', () => {
    expect(developmentHelper).toContain('packageCloudRuntime()');
    expect(developmentHelper).toContain('scripts/build-cloud-runtime.mjs');
    expect(developmentHelper).toContain('deploy-cloud-runtime.sh');
    expect(developmentHelper).not.toContain("npm pack");
    expect(developmentHelper).not.toContain("npm install ./releases");
    expect(developmentHelper).not.toContain('node_modules/@piarium/web/bin/cli.js');
  });

  it('installs target-platform dependencies before atomically switching releases', () => {
    expect(deployScript).toContain('sha256_file');
    expect(deployScript).toContain('--production');
    expect(deployScript).toContain('--frozen-lockfile');
    expect(deployScript).toContain('mv -Tf "$temporary_link" "$link_path"');
    expect(deployScript).toContain('"${ROOT}/current"');
    expect(deployScript).toContain('"${ROOT}/previous"');
    expect(deployScript).toContain('rolling back');
  });

  it('installs the Windows local runtime only after its final directory is active', () => {
    const activateCandidate = developmentHelper.indexOf('renameSync(stagingDirectory, targetDirectory);');
    const installCandidate = developmentHelper.indexOf('installCloudRuntimeDependencies(', activateCandidate);
    const startCandidate = developmentHelper.indexOf('startInstalledInstance(targetDirectory, port);', installCandidate);

    expect(activateCandidate).toBeGreaterThanOrEqual(0);
    expect(installCandidate).toBeGreaterThan(activateCandidate);
    expect(startCandidate).toBeGreaterThan(installCandidate);
    expect(developmentHelper).toContain('previousStopped && existsSync(targetDirectory)');
    expect(developmentHelper).toContain('waitForInstalledInstance(targetDirectory, port, metadata.version)');
  });

  it('switches the current link before stopping the active runtime and tracks rollback state', () => {
    const rollbackTrap = deployScript.indexOf('trap rollback ERR');
    const rollbackArmed = deployScript.indexOf('ROLLBACK_REQUIRED="true"', rollbackTrap);
    const switchCurrent = deployScript.indexOf('atomic_link "$RELEASE_DIR" "${ROOT}/current"', rollbackArmed);
    const linkSwitched = deployScript.indexOf('CURRENT_LINK_SWITCHED="true"', switchCurrent);
    const stopPrevious = deployScript.indexOf('stop_runtime "$PREVIOUS_TARGET"', linkSwitched);
    const previousStopped = deployScript.indexOf('PREVIOUS_RUNTIME_STOPPED="true"', stopPrevious);
    const candidateAttempted = deployScript.indexOf('CANDIDATE_START_ATTEMPTED="true"', previousStopped);

    expect(rollbackTrap).toBeGreaterThanOrEqual(0);
    expect(rollbackArmed).toBeGreaterThan(rollbackTrap);
    expect(switchCurrent).toBeGreaterThan(rollbackArmed);
    expect(linkSwitched).toBeGreaterThan(switchCurrent);
    expect(stopPrevious).toBeGreaterThan(linkSwitched);
    expect(previousStopped).toBeGreaterThan(stopPrevious);
    expect(candidateAttempted).toBeGreaterThan(previousStopped);
    expect(deployScript).toContain('if [[ "$CANDIDATE_START_ATTEMPTED" = "true" ]]');
    expect(deployScript).toContain('if [[ "$PREVIOUS_RUNTIME_STOPPED" = "true" ]]');
    expect(deployScript).toContain('start_runtime "$PREVIOUS_TARGET"');
  });

  it('serializes deploys and binds an immutable release id to the full archive digest', () => {
    expect(deployScript).toContain('set -o noclobber');
    expect(deployScript).toContain('Another Piarium deployment is already running');
    expect(deployScript).toContain('.archive-sha256');
    expect(deployScript).toContain('already belongs to a different archive');
  });

  it('waits for the bundled Pi runtime identity, not just an open port', () => {
    expect(deployScript).toContain("body.status === 'ok'");
    expect(deployScript).toContain('body.piariumVersion === expectedVersion');
    expect(deployScript).toContain('body.releaseId === expectedReleaseId');
    expect(deployScript).toContain('body.piRuntime?.ready === true');
    expect(deployScript).toContain("body.piRuntime?.source === 'bundled'");
    expect(deployScript).toContain('local health_host="$BIND_HOST"');
    expect(deployScript).toContain('health_host="[${health_host}]"');
    expect(deployScript).not.toContain('lsof -ti');
    expect(deployScript).not.toContain('sleep 0.5');
  });

  it('loads secrets from a remote environment file without command-line password injection', () => {
    expect(deployScript).toContain('~/.config/piarium/deploy.env');
    expect(deployScript).toContain('source "$ENV_FILE"');
    expect(deployScript).toContain('PIARIUM_UI_PASSWORD must be set');
    expect(deployScript).toContain('must use mode 600 or 400');
    expect(deployScript).toContain("stat -c '%u'");
    expect(deployScript).toContain('is not owned by the deployment user');
    expect(developmentHelper).not.toContain("grep '^export PIARIUM_UI_PASSWORD='");
    expect(developmentHelper).not.toContain('~/.bashrc');
  });

  it('documents Piarium-owned data and secret paths for each remote target', () => {
    for (const deployment of configExample.remoteDeployments) {
      expect(deployment.dir).toContain('piarium');
      expect(deployment.dataDir).toContain('piarium');
      expect(deployment.envFile).toContain('piarium');
      expect(deployment.bindHost).toBe('0.0.0.0');
    }
  });

  it('contains no OpenChamber runtime naming', () => {
    expect(deployScript.toLowerCase()).not.toContain('openchamber');
    expect(developmentHelper.toLowerCase()).not.toContain('openchamber');
  });
});
