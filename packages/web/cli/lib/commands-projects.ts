import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { requestPiariumApi } from './cli-runtime.js';
import { isJsonMode, printJson } from '../cli-output.js';
import { recordOf, type CliOptions } from './cli-types.js';

interface ProjectSummary {
  id: string;
  label: string;
  path: string;
}

const formatProjectLine = (project: ProjectSummary): string => `- \`${project.label}\` — \`${project.id}\` — \`${project.path}\``;

async function projectsCommand(options: CliOptions = {}, action = 'list'): Promise<void> {
  if (action === 'help') {
    process.stdout.write(`Piarium Projects Commands\n\nUSAGE:\n  piarium projects [OPTIONS]\n\nOUTPUT OPTIONS:\n  -p, --port <port>       Piarium server port\n  --json                  Output machine-readable JSON\n`);
    return;
  }
  if (action !== 'list') {
    throw new TunnelCliError(`Unknown projects command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const port = await resolveTargetPort(options);
  const settings = await requestPiariumApi(port, '/api/config/settings', options);
  const projects = Array.isArray(settings.projects)
    ? settings.projects.map(recordOf).filter((project): project is Record<string, unknown> & ProjectSummary => (
        typeof project.id === 'string' && typeof project.label === 'string' && typeof project.path === 'string'
      ))
    : [];
  if (isJsonMode(options)) {
    printJson({ projects });
    return;
  }
  process.stdout.write(projects.length > 0
    ? `${projects.map(formatProjectLine).join('\n')}\n`
    : 'No projects found.\n');
}

export { projectsCommand, formatProjectLine };
