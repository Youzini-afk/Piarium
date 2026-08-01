import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  AppPreferences,
  ProjectDescriptor,
  RecoveryDefaultMode,
} from "../shared/desktop-api.js";

interface AppState {
  preferences: AppPreferences;
  recentProjects: ProjectDescriptor[];
  version: 1;
}

const DEFAULT_PREFERENCES: AppPreferences = { recoveryDefault: "ask" };
const EMPTY_STATE: AppState = {
  preferences: DEFAULT_PREFERENCES,
  recentProjects: [],
  version: 1,
};

export class AppStore {
  readonly #path: string;
  #state: AppState = structuredClone(EMPTY_STATE);
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<AppState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.recentProjects)) return;
      this.#state = {
        preferences: {
          recoveryDefault:
            parsed.preferences?.recoveryDefault === "conversation" ||
            parsed.preferences?.recoveryDefault === "both" ||
            parsed.preferences?.recoveryDefault === "ask"
              ? parsed.preferences.recoveryDefault
              : DEFAULT_PREFERENCES.recoveryDefault,
        },
        recentProjects: parsed.recentProjects
          .filter(
            (entry): entry is ProjectDescriptor =>
              typeof entry === "object" &&
              entry !== null &&
              typeof entry.path === "string" &&
              typeof entry.name === "string" &&
              typeof entry.lastOpenedAt === "string",
          )
          .slice(0, 12),
        version: 1,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  getRecentProjects(): ProjectDescriptor[] {
    return structuredClone(this.#state.recentProjects);
  }

  getPreferences(): AppPreferences {
    return structuredClone(this.#state.preferences);
  }

  async setRecoveryDefault(recoveryDefault: RecoveryDefaultMode): Promise<AppPreferences> {
    this.#state.preferences = { recoveryDefault };
    await this.#persist();
    return this.getPreferences();
  }

  async openProject(path: string): Promise<ProjectDescriptor> {
    const projectPath = resolve(path);
    const information = await stat(projectPath);
    if (!information.isDirectory()) throw new Error("Project path must be a directory");
    const descriptor: ProjectDescriptor = {
      lastOpenedAt: new Date().toISOString(),
      name: basename(projectPath) || projectPath,
      path: projectPath,
    };
    this.#state.recentProjects = [
      descriptor,
      ...this.#state.recentProjects.filter(
        (entry) => entry.path.toLowerCase() !== projectPath.toLowerCase(),
      ),
    ].slice(0, 12);
    await this.#persist();
    return structuredClone(descriptor);
  }

  async #persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`;
    this.#writeQueue = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#path);
    });
    return this.#writeQueue;
  }
}
