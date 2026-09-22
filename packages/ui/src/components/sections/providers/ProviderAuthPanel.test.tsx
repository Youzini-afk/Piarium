import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProviderAuthPrompt } from '@varin/protocol';
import type { PiProviderLoginOptions } from '@/lib/pi-runtime/providers';
import { ProviderAuthPanel } from './ProviderAuthPanel';

type LoginResolve = (value: { authenticated: boolean }) => void;

const mocks = vi.hoisted(() => ({
  activeOptions: null as PiProviderLoginOptions | null,
  authenticated: vi.fn(),
  login: vi.fn(),
  resolve: null as LoginResolve | null,
}));

vi.mock('@/lib/pi-runtime/providers', () => ({
  loginPiProvider: mocks.login,
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
vi.mock('@/components/ui/input', () => ({
  Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => <input ref={ref} {...props} />),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, onValueChange, value }: { children: React.ReactNode; onValueChange(value: string): void; value: string }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/url', () => ({ openExternalUrl: vi.fn(async () => undefined) }));

const prompt = (overrides: Record<string, unknown> & Pick<ProviderAuthPrompt, 'type'>): ProviderAuthPrompt => ({
  message: 'Prompt',
  requestId: `request-${Math.random()}`,
  ...overrides,
} as ProviderAuthPrompt);

const renderPrompt = async (
  container: HTMLDivElement,
  authPrompt: ProviderAuthPrompt,
  value: string,
  signal = new AbortController().signal,
): Promise<string | undefined> => {
  const options = mocks.activeOptions;
  expect(options).not.toBeNull();
  let answer!: Promise<string | undefined>;
  await act(async () => {
    answer = options!.onPrompt(authPrompt, signal);
    await Promise.resolve();
  });
  const input = container.querySelector<HTMLInputElement>('input:not([readonly])');
  expect(input).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input!.value = value;
    input!.dispatchEvent(new window.Event('input', { bubbles: true }));
    input!.dispatchEvent(new window.Event('change', { bubbles: true }));
    if ('InputEvent' in window) input!.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    // React's controlled field should retain the value before the prompt is completed.
    expect(input!.value).toBe(value);
  });
  const complete = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'settings.providers.page.actions.complete',
  );
  expect(complete).toBeDefined();
  await act(async () => {
    complete!.click();
    await Promise.resolve();
  });
  return answer;
};

describe('Pi provider auth panel', () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (providerId: string, cwd = '/repo', type: 'api_key' | 'oauth' = 'api_key') => {
    await act(async () => {
      root.render(
        <ProviderAuthPanel
          cwd={cwd}
          methods={[{ label: type === 'oauth' ? 'Browser login' : 'API key', type }]}
          onAuthenticated={mocks.authenticated}
          providerId={providerId}
        />,
      );
    });
  };

  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === label);
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.activeOptions = null;
    mocks.authenticated.mockReset();
    mocks.login.mockReset();
    mocks.login.mockImplementation((options: PiProviderLoginOptions) => {
      mocks.activeOptions = options;
      return new Promise<{ authenticated: boolean }>((resolve) => {
        mocks.resolve = resolve;
      });
    });
    mocks.resolve = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('answers API key, account, and gateway prompts one at a time', async () => {
    await render('provider-a');
    await click('API key');
    const account = await renderPrompt(container, prompt({ type: 'secret' }), 'sk-real');
    expect(account).toBe('sk-real');
    const accountId = await renderPrompt(container, prompt({ type: 'text' }), 'account-123');
    expect(accountId).toBe('account-123');
    const gatewayId = await renderPrompt(container, prompt({ type: 'text' }), 'gateway-456');
    expect(gatewayId).toBe('gateway-456');

    mocks.resolve?.({ authenticated: true });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.authenticated).toHaveBeenCalledWith('provider-a');
  });

  test('keeps an OAuth login alive when Pi withdraws a manual-code prompt', async () => {
    await render('provider-oauth', '/repo', 'oauth');
    await click('Browser login');
    expect(mocks.activeOptions!.type).toBe('oauth');
    const signalController = new AbortController();
    let answer!: Promise<string | undefined>;
    await act(async () => {
      answer = mocks.activeOptions!.onPrompt(prompt({ type: 'manual_code' }), signalController.signal);
      await Promise.resolve();
    });
    await act(async () => { signalController.abort(); });
    await expect(answer).resolves.toBeUndefined();

    mocks.resolve?.({ authenticated: true });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.authenticated).toHaveBeenCalledWith('provider-oauth');
  });

  test('offers cancellation while the login is waiting without a prompt', async () => {
    await render('provider-browser', '/repo', 'oauth');
    await click('Browser login');
    await click('settings.providers.page.actions.cancel');
    mocks.resolve?.({ authenticated: true });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.authenticated).not.toHaveBeenCalled();
  });

  test('clears an old run on provider change so the new provider can authenticate', async () => {
    await render('provider-old', '/old');
    await click('API key');
    const oldOptions = mocks.activeOptions;
    const resolveOld = mocks.resolve;
    await render('provider-new', '/new');
    await act(async () => { await Promise.resolve(); });
    expect(mocks.authenticated).not.toHaveBeenCalled();

    await click('API key');
    expect(mocks.activeOptions).not.toBe(oldOptions);
    expect(oldOptions!.signal!.aborted).toBe(true);
    await act(async () => { resolveOld?.({ authenticated: true }); });
    expect(mocks.authenticated).not.toHaveBeenCalled();
    mocks.resolve?.({ authenticated: true });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.authenticated).toHaveBeenCalledWith('provider-new');
  });
});
