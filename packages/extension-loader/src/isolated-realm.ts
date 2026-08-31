import type {
  JsonValue,
  PiariumContextValue,
  PiariumExtensionAssetPayload,
  PiariumExtensionStaticContribution,
} from "@piarium/extension-contract";

interface IsolatedContributionImplementationBase {
  readonly realmId: string;
  readonly viewId: string;
  postMessage(message: JsonValue): void;
}

export interface IsolatedIframeContributionImplementation extends IsolatedContributionImplementationBase {
  readonly kind: "isolated-iframe";
  mount(container: HTMLElement): () => void;
}

export interface IsolatedWorkerContributionImplementation extends IsolatedContributionImplementationBase {
  readonly kind: "isolated-worker";
}

export type IsolatedContributionImplementation =
  | IsolatedIframeContributionImplementation
  | IsolatedWorkerContributionImplementation;

export interface IsolatedRealmActivationContext {
  callCapability(capability: string, method: string, params: JsonValue): Promise<JsonValue>;
  callService(serviceId: string, version: number, providerId: string | undefined, method: string, args: JsonValue[]): Promise<JsonValue>;
  contribute(descriptor: PiariumExtensionStaticContribution, implementation: IsolatedContributionImplementation): void;
  deleteContext(key: string): boolean;
  grantedCapabilities: readonly string[];
  hasService(serviceId: string, version: number, providerId?: string): boolean;
  readAsset(path: string): Promise<PiariumExtensionAssetPayload>;
  setContext(key: string, value: PiariumContextValue): boolean;
}

export interface IsolatedRealmIdentity {
  entrypointId: string;
  extensionId: string;
  integrity: string;
  kind: "iframe" | "worker";
  realmId: string;
}

export interface IsolatedSurfaceRealm {
  readonly disposed: boolean;
  activate(context: IsolatedRealmActivationContext): Promise<void>;
  dispose(reason?: unknown): void;
}

export interface IsolatedSurfaceRealmFactory {
  create(source: string, styles: readonly string[], identity: IsolatedRealmIdentity): IsolatedSurfaceRealm;
}

interface RealmRequest {
  id: string;
  method: string;
  params?: unknown;
  type: "request";
}

interface RealmResponse {
  error?: string;
  id: string;
  result?: unknown;
  success: boolean;
  type: "response";
}

interface RealmEvent {
  descriptor?: unknown;
  error?: string;
  nonce?: string;
  type: "contribute" | "fatal" | "hello" | "ready";
  version?: number;
  viewId?: string;
}

type RealmMessage = RealmRequest | RealmResponse | RealmEvent;

const ISOLATED_REALM_PROTOCOL_VERSION = 1;

const bootstrapSource = (nonce: string): string => `
(() => {
  const nonce = ${JSON.stringify(nonce)};
  const pending = new Map();
  const disposers = [];
  const controller = new AbortController();
  let counter = 0;
  let port = null;
  const send = (message) => port.postMessage(message);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = 'realm-' + (++counter);
    pending.set(id, { resolve, reject });
    send({ type: 'request', id, method, params });
  });
  const handlePortMessage = async (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'response') {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.success) waiting.resolve(message.result);
      else waiting.reject(new Error(String(message.error || 'Isolated realm request failed')));
      return;
    }
    if (message.type === 'dispose') {
      controller.abort(message.reason);
      while (disposers.length > 0) {
        try { await disposers.pop()(); } catch {}
      }
      port.close();
      return;
    }
    if (message.type === 'message') globalThis.dispatchEvent(new MessageEvent('piarium-message', { data: message.value }));
  };
  const begin = async (nextPort, grants) => {
    if (port) return;
    port = nextPort;
    port.onmessage = handlePortMessage;
    port.start?.();
    send({ type: 'hello', nonce, version: ${ISOLATED_REALM_PROTOCOL_VERSION} });
    const moduleValue = globalThis.PiariumIsolatedModule || {};
    const candidate = moduleValue.default || moduleValue;
    const activate = typeof candidate === 'function' ? candidate : candidate.activate;
    if (typeof activate !== 'function') throw new Error('Isolated Surface module must export activate or a default extension definition');
    const context = {
      assets: { read: (path) => request('asset.read', { path }) },
      capabilities: {
        call: (capability, method, params) => request('capability.call', { capability, method, params }),
        has: (capability) => grants.includes(capability),
      },
      contribute: (descriptor, options = {}) => send({ type: 'contribute', descriptor, viewId: options.viewId || 'main' }),
      context: {
        delete: (key) => request('context.delete', { key }),
        set: (key, value) => request('context.set', { key, value }),
      },
      effect: (disposer) => {
        if (typeof disposer !== 'function') throw new Error('Isolated effect disposer must be a function');
        disposers.push(disposer);
      },
      services: {
        call: (serviceId, version, method, args, providerId) => request('service.invoke', { args, method, providerId, serviceId, version }),
        has: (serviceId, version, providerId) => request('service.available', { providerId, serviceId, version }),
        use: (serviceId, version, providerId) => new Proxy({}, {
          get: (_target, property) => property === 'then' || typeof property !== 'string'
            ? undefined
            : (...args) => request('service.invoke', { args, method: property, providerId, serviceId, version }),
        }),
      },
      signal: controller.signal,
    };
    const returned = await activate.call(candidate, context);
    if (typeof returned === 'function') disposers.push(returned);
    send({ type: 'ready', version: ${ISOLATED_REALM_PROTOCOL_VERSION} });
  };
  const receiveInit = (event) => {
    const message = event.data;
    if (!message || message.type !== 'piarium-isolated-init' || message.version !== ${ISOLATED_REALM_PROTOCOL_VERSION} || message.nonce !== nonce || !event.ports?.[0]) return;
    globalThis.removeEventListener('message', receiveInit);
    void begin(event.ports[0], Array.isArray(message.grants) ? message.grants : []).catch((error) => {
      try { send({ type: 'fatal', error: error instanceof Error ? error.message : String(error) }); } catch {}
    });
  };
  globalThis.addEventListener('message', receiveInit);
})();`;

const safeInlineScript = (source: string): string => source.replace(/<\/script/gi, "<\\/script");

const workerAmbientNetworkBlock = `
for (const name of ['fetch', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts']) {
  if (!(name in globalThis)) continue;
  Object.defineProperty(globalThis, name, {
    configurable: false,
    value: () => { throw new Error('Ambient network access is unavailable in an isolated Piarium realm; use a granted capability'); },
    writable: false,
  });
}`;

class BrowserIsolatedSurfaceRealm implements IsolatedSurfaceRealm {
  readonly #identity: IsolatedRealmIdentity;
  readonly #nonce: string;
  readonly #source: string;
  readonly #styles: readonly string[];
  #activation: IsolatedRealmActivationContext | null = null;
  #blobUrl: string | null = null;
  #disposed = false;
  #iframe: HTMLIFrameElement | null = null;
  #handshakeAccepted = false;
  #port: MessagePort | null = null;
  #worker: Worker | null = null;

  constructor(source: string, styles: readonly string[], identity: IsolatedRealmIdentity) {
    this.#source = source;
    this.#styles = [...styles];
    this.#identity = identity;
    this.#nonce = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async activate(context: IsolatedRealmActivationContext): Promise<void> {
    if (this.#disposed) throw new Error("Isolated Surface realm is disposed");
    if (this.#activation) throw new Error("Isolated Surface realm is already active");
    this.#activation = context;
    const channel = new MessageChannel();
    this.#port = channel.port1;
    let rejectActivation: (error: Error) => void = () => undefined;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      rejectActivation = rejectReady;
      this.#port!.onmessage = (event: MessageEvent<RealmMessage>) => {
        void this.#onMessage(event.data, resolveReady, rejectReady);
      };
      this.#port!.start();
    });
    if (this.#identity.kind === "worker") this.#startWorker(channel.port2, rejectActivation);
    else this.#startIframe(channel.port2, rejectActivation);
    await ready;
  }

  dispose(reason?: unknown): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try { this.#port?.postMessage({ type: "dispose", reason: reason instanceof Error ? reason.message : String(reason ?? "disposed") }); }
    catch { /* The realm may already have closed its port. */ }
    this.#port?.close();
    this.#port = null;
    this.#worker?.terminate();
    this.#worker = null;
    this.#iframe?.remove();
    this.#iframe = null;
    if (this.#blobUrl) URL.revokeObjectURL(this.#blobUrl);
    this.#blobUrl = null;
    this.#activation = null;
  }

  #startWorker(port: MessagePort, rejectReady: (error: Error) => void): void {
    if (typeof Worker === "undefined") throw new Error("This Surface does not support isolated Workers");
    const source = `${workerAmbientNetworkBlock}\n${this.#source}\n${bootstrapSource(this.#nonce)}`;
    this.#blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    this.#worker = new Worker(this.#blobUrl);
    this.#worker.addEventListener("error", (event) => {
      rejectReady(new Error(event.message || "Isolated Worker failed to start"));
      this.dispose("worker failed");
    }, { once: true });
    this.#worker.postMessage({ type: "piarium-isolated-init", version: ISOLATED_REALM_PROTOCOL_VERSION, nonce: this.#nonce, grants: this.#activation?.grantedCapabilities ?? [] }, [port]);
  }

  #startIframe(port: MessagePort, rejectReady: (error: Error) => void): void {
    if (typeof document === "undefined") throw new Error("This Surface does not support isolated iframes");
    const iframe = document.createElement("iframe");
    iframe.dataset.piariumIsolatedRealm = this.#identity.realmId;
    iframe.sandbox.add("allow-scripts");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
    const styles = this.#styles.map((css) => `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`).join("");
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    iframe.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}">${styles}</head><body><div id="root"></div><script>${safeInlineScript(this.#source)}</script><script>${safeInlineScript(bootstrapSource(this.#nonce))}</script></body></html>`;
    iframe.addEventListener("load", () => {
      if (!iframe.contentWindow) {
        rejectReady(new Error("Isolated iframe content window is unavailable"));
        this.dispose("iframe unavailable");
        return;
      }
      iframe.contentWindow.postMessage({
        type: "piarium-isolated-init",
        version: ISOLATED_REALM_PROTOCOL_VERSION,
        nonce: this.#nonce,
        grants: this.#activation?.grantedCapabilities ?? [],
      }, "*", [port]);
    }, { once: true });
    iframe.addEventListener("error", () => {
      rejectReady(new Error("Isolated iframe failed to start"));
      this.dispose("iframe failed");
    }, { once: true });
    document.body.appendChild(iframe);
    this.#iframe = iframe;
  }

  async #onMessage(
    message: RealmMessage,
    resolveReady: () => void,
    rejectReady: (error: Error) => void,
  ): Promise<void> {
    if (this.#disposed || !this.#activation || !message || typeof message !== "object") return;
    if (message.type === "hello") {
      if (message.version !== ISOLATED_REALM_PROTOCOL_VERSION || message.nonce !== this.#nonce) {
        rejectReady(new Error("Isolated Surface handshake nonce does not match"));
        this.dispose("handshake rejected");
      } else {
        this.#handshakeAccepted = true;
      }
      return;
    }
    if (message.type === "ready") {
      if (!this.#handshakeAccepted || message.version !== ISOLATED_REALM_PROTOCOL_VERSION) {
        rejectReady(new Error("Isolated Surface protocol version does not match"));
        this.dispose("protocol rejected");
        return;
      }
      resolveReady();
      return;
    }
    if (message.type === "fatal") { rejectReady(new Error(message.error || "Isolated Surface activation failed")); this.dispose("activation failed"); return; }
    if (message.type === "contribute") {
      if (this.#identity.kind === "worker") {
        rejectReady(new Error("Isolated Workers are background-only and cannot register visual Surface contributions"));
        this.dispose("worker contribution rejected");
        return;
      }
      try {
        this.#activation.contribute(message.descriptor as PiariumExtensionStaticContribution, this.#implementation(message.viewId ?? "main"));
      } catch (error) {
        rejectReady(error instanceof Error ? error : new Error(String(error)));
        this.dispose("contribution rejected");
      }
      return;
    }
    if (message.type !== "request") return;
    try {
      const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? message.params as Record<string, unknown>
        : {};
      let result: unknown;
      if (message.method === "asset.read") result = await this.#activation.readAsset(String(params.path ?? ""));
      else if (message.method === "context.delete") {
        const key = String(params.key ?? "");
        if (!key.trim()) throw new Error("Isolated Surface context key is required");
        result = this.#activation.deleteContext(key);
      }
      else if (message.method === "context.set") {
        const key = String(params.key ?? "");
        const value = params.value;
        if (!key.trim()) throw new Error("Isolated Surface context key is required");
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          throw new Error("Isolated Surface context value must be a string, number, or boolean");
        }
        result = this.#activation.setContext(key, value);
      }
      else if (message.method === "capability.call") result = await this.#activation.callCapability(
        String(params.capability ?? ""),
        String(params.method ?? ""),
        params.params as JsonValue,
      );
      else if (message.method === "service.invoke") result = await this.#activation.callService(
        String(params.serviceId ?? ""),
        Number(params.version),
        typeof params.providerId === "string" ? params.providerId : undefined,
        String(params.method ?? ""),
        Array.isArray(params.args) ? params.args as JsonValue[] : [],
      );
      else if (message.method === "service.available") result = this.#activation.hasService(
        String(params.serviceId ?? ""),
        Number(params.version),
        typeof params.providerId === "string" ? params.providerId : undefined,
      );
      else throw new Error(`Unknown isolated Surface request: ${message.method}`);
      this.#respond({ id: message.id, result, success: true, type: "response" });
    } catch (error) {
      this.#respond({
        error: error instanceof Error ? error.message : String(error),
        id: message.id,
        success: false,
        type: "response",
      });
    }
  }

  #implementation(viewId: string): IsolatedContributionImplementation {
    const base = {
      realmId: this.#identity.realmId,
      viewId,
      postMessage: (message: JsonValue) => this.#port?.postMessage({ type: "message", value: message }),
    };
    if (this.#identity.kind === "worker") return { ...base, kind: "isolated-worker" };
    return {
      ...base,
      kind: "isolated-iframe",
      mount: (container: HTMLElement) => {
        if (!this.#iframe || this.#disposed) throw new Error("Isolated iframe realm is unavailable");
        const previousParent = this.#iframe.parentElement;
        const previousStyle = this.#iframe.style.cssText;
        this.#iframe.removeAttribute("aria-hidden");
        this.#iframe.style.cssText = "width:100%;height:100%;border:0;display:block";
        container.appendChild(this.#iframe);
        return () => {
          if (!this.#iframe || this.#disposed) return;
          this.#iframe.setAttribute("aria-hidden", "true");
          this.#iframe.style.cssText = previousStyle;
          previousParent?.appendChild(this.#iframe);
        };
      },
    };
  }

  #respond(message: RealmResponse): void {
    if (!this.#disposed) this.#port?.postMessage(message);
  }
}

export const browserIsolatedSurfaceRealmFactory: IsolatedSurfaceRealmFactory = {
  create: (source, styles, identity) => new BrowserIsolatedSurfaceRealm(source, styles, identity),
};
