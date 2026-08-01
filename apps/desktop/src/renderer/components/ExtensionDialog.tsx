import type { ExtensionUiRequest, JsonValue } from "@piarium/protocol";
import { useEffect, useMemo, useRef, useState } from "react";

interface ExtensionDialogProps {
  onRespond(value?: JsonValue, cancelled?: boolean): void;
  request?: ExtensionUiRequest | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function ExtensionDialog({ onRespond, request }: ExtensionDialogProps) {
  const [value, setValue] = useState("");
  const payload = useMemo(() => record(request?.payload), [request?.payload]);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const requestId = request?.id;
  useEffect(() => {
    if (!requestId) return;
    setValue(typeof payload?.prefill === "string" ? payload.prefill : "");
    queueMicrotask(() => (inputRef.current ?? editorRef.current)?.focus());
  }, [payload, requestId]);
  if (!request?.id) return null;
  const title = String(payload?.title ?? payload?.message ?? "Pi 扩展请求");
  const message = typeof payload?.message === "string" ? payload.message : undefined;
  const options = Array.isArray(payload?.options) ? payload.options : [];

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-labelledby="extension-dialog-title"
        aria-modal="true"
        className="modal"
        role="dialog"
      >
        <div className="modal-kicker">EXTENSION UI</div>
        <h2 id="extension-dialog-title">{title}</h2>
        {message && message !== title ? <p>{message}</p> : null}

        {request.method === "confirm" ? (
          <div className="modal-actions">
            <button className="button ghost" onClick={() => onRespond(false, true)} type="button">
              取消
            </button>
            <button className="button primary" onClick={() => onRespond(true)} type="button">
              确认
            </button>
          </div>
        ) : null}

        {request.method === "select" ? (
          <div className="extension-options">
            {options.map((option) => {
              const optionRecord = record(option);
              const id =
                typeof option === "string"
                  ? option
                  : String(optionRecord?.id ?? optionRecord?.label ?? "option");
              const label = typeof option === "string" ? option : String(optionRecord?.label ?? id);
              const description =
                typeof optionRecord?.description === "string"
                  ? optionRecord.description
                  : undefined;
              return (
                <button key={id} onClick={() => onRespond(id)} type="button">
                  <strong>{label}</strong>
                  {description ? <small>{description}</small> : null}
                </button>
              );
            })}
            <button
              className="extension-cancel"
              onClick={() => onRespond(undefined, true)}
              type="button"
            >
              取消
            </button>
          </div>
        ) : null}

        {request.method === "input" || request.method === "editor" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onRespond(value);
            }}
          >
            {request.method === "editor" ? (
              <textarea
                onChange={(event) => setValue(event.target.value)}
                ref={editorRef}
                rows={8}
                value={value}
              />
            ) : (
              <input
                onChange={(event) => setValue(event.target.value)}
                placeholder={String(payload?.placeholder ?? "")}
                ref={inputRef}
                type={payload?.secret === true ? "password" : "text"}
                value={value}
              />
            )}
            <div className="modal-actions">
              <button
                className="button ghost"
                onClick={() => onRespond(undefined, true)}
                type="button"
              >
                取消
              </button>
              <button className="button primary" type="submit">
                提交
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
