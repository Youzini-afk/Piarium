import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  Theme,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionUiMethod,
  ExtensionUiRequest,
  ExtensionUiResponse,
  HostEvent,
  HostEventData,
  JsonValue,
} from "@piarium/protocol";
import { createDeferred, type Deferred } from "./deferred.js";
import { toJsonValue } from "./json.js";

type EventEmitter = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

interface PendingRequest {
  abortHandler?: () => void;
  deferred: Deferred<JsonValue | undefined>;
  sessionId: string;
  timeout?: NodeJS.Timeout;
}

function identity(text: string): string {
  return text;
}

const neutralTheme = {
  bg: (_color: unknown, text: string) => text,
  bold: identity,
  fg: (_color: unknown, text: string) => text,
  getBashModeBorderColor: () => identity,
  getBgAnsi: () => "",
  getColorMode: () => "dark",
  getFgAnsi: () => "",
  getThinkingBorderColor: () => identity,
  inverse: identity,
  italic: identity,
  name: "piarium-neutral",
  strikethrough: identity,
  underline: identity,
} as unknown as Theme;

export class ExtensionUiBridge {
  readonly #emit: EventEmitter;
  readonly #getSessionId: () => string;
  readonly #pending = new Map<string, PendingRequest>();
  #editorText = "";

  constructor(emit: EventEmitter, getSessionId: () => string) {
    this.#emit = emit;
    this.#getSessionId = getSessionId;
  }

  createContext(): ExtensionUIContext {
    const custom: ExtensionUIContext["custom"] = async (factory, options) => {
      const inertUi = new Proxy({}, {
        get: () => () => {},
      });
      const resolvedOverlayOptions = typeof options?.overlayOptions === "function"
        ? options.overlayOptions()
        : options?.overlayOptions;
      const requestedWidth = resolvedOverlayOptions?.width;
      const width = typeof requestedWidth === "number" && Number.isFinite(requestedWidth) && requestedWidth > 0
        ? Math.round(requestedWidth)
        : 100;
      const component = await factory(
        inertUi as never,
        neutralTheme,
        inertUi as never,
        () => {},
      );
      try {
        const lines = component.render(width).map((line) => stripVTControlCharacters(line));
        await this.request(
          "custom",
          {
            lines,
            title: "Extension panel",
          },
          undefined,
          undefined,
        );
        return undefined as never;
      } finally {
        component.dispose?.();
      }
    };

    return {
      select: async (title, options, dialogOptions) => {
        const value = await this.request("select", { options, title }, dialogOptions, undefined);
        return typeof value === "string" ? value : undefined;
      },
      confirm: async (title, message, dialogOptions) => {
        const value = await this.request("confirm", { message, title }, dialogOptions, false);
        return value === true;
      },
      input: async (title, placeholder, dialogOptions) => {
        const value = await this.request(
          "input",
          { placeholder: placeholder ?? null, title },
          dialogOptions,
          undefined,
        );
        return typeof value === "string" ? value : undefined;
      },
      notify: (message, type) => {
        this.fire("notify", { message, type: type ?? "info" });
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        this.fire("setStatus", { key, text: text ?? null });
      },
      setWorkingMessage: (message) => {
        this.fire("setWorkingMessage", { message: message ?? null });
      },
      setWorkingVisible: (visible) => {
        this.fire("setWorkingVisible", { visible });
      },
      setWorkingIndicator: (options?: WorkingIndicatorOptions) => {
        this.fire("setWorkingIndicator", toJsonValue(options ?? null));
      },
      setHiddenThinkingLabel: (label) => {
        this.fire("setHiddenThinkingLabel", { label: label ?? null });
      },
      setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) => {
        if (content === undefined || Array.isArray(content)) {
          this.fire("setWidget", {
            key,
            lines: content ?? null,
            placement: options?.placement ?? "aboveEditor",
          });
        }
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => this.fire("setTitle", { title }),
      custom,
      pasteToEditor: (text) => {
        this.#editorText = text;
        this.fire("setEditorText", { text });
      },
      setEditorText: (text) => {
        this.#editorText = text;
        this.fire("setEditorText", { text });
      },
      getEditorText: () => this.#editorText,
      editor: async (title, prefill) => {
        const value = await this.request(
          "editor",
          { prefill: prefill ?? null, title },
          undefined,
          undefined,
        );
        return typeof value === "string" ? value : undefined;
      },
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: neutralTheme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is owned by Piarium" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    } as ExtensionUIContext;
  }

  async request(
    method: Extract<ExtensionUiMethod, "select" | "confirm" | "input" | "editor" | "custom">,
    payload: JsonValue,
    options?: ExtensionUIDialogOptions,
    fallback?: JsonValue,
  ): Promise<JsonValue | undefined> {
    const id = randomUUID();
    const sessionId = this.#getSessionId();
    const deferred = createDeferred<JsonValue | undefined>();
    const pending: PendingRequest = { deferred, sessionId };
    const cleanup = () => {
      if (pending.timeout) clearTimeout(pending.timeout);
      if (pending.abortHandler && options?.signal) {
        options.signal.removeEventListener("abort", pending.abortHandler);
      }
      this.#pending.delete(id);
    };
    pending.abortHandler = () => {
      cleanup();
      this.#emit("extension.ui.dismiss", { requestId: id, sessionId });
      deferred.resolve(fallback);
    };
    if (options?.signal?.aborted) return fallback;
    if (options?.signal) {
      options.signal.addEventListener("abort", pending.abortHandler, { once: true });
    }
    if (options?.timeout !== undefined && options.timeout > 0) {
      pending.timeout = setTimeout(pending.abortHandler, options.timeout);
    }
    this.#pending.set(id, pending);
    this.#emit("extension.ui.request", {
      id,
      method,
      ...(options?.timeout === undefined ? {} : { options: { timeout: options.timeout } }),
      payload,
      sessionId,
    });
    try {
      return await deferred.promise;
    } finally {
      cleanup();
    }
  }

  respond(response: ExtensionUiResponse): boolean {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return false;
    pending.deferred.resolve(response.cancelled ? undefined : response.value);
    return true;
  }

  cancelAll(): void {
    for (const [requestId, pending] of this.#pending) {
      this.#emit("extension.ui.dismiss", { requestId, sessionId: pending.sessionId });
      pending.deferred.resolve(undefined);
    }
    this.#pending.clear();
  }

  setEditorState(text: string): void {
    this.#editorText = text;
  }

  fire(method: ExtensionUiMethod, payload: JsonValue): void {
    const request: ExtensionUiRequest = {
      method,
      payload: toJsonValue(payload),
      sessionId: this.#getSessionId(),
    };
    this.#emit("extension.ui.request", request);
  }
}
