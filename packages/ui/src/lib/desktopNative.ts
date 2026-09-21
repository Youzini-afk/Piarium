import { hasDesktopInvoke, invokeDesktop, isDesktopShell } from '@/lib/desktop';
import type {
  VarinDesktopCommand,
  VarinDesktopCommandInvocation,
  VarinDesktopCommandResult,
} from '@varin/application-client';

export const invokeDesktopCommand = async <K extends VarinDesktopCommand>(
  command: K,
  ...invocation: VarinDesktopCommandInvocation<K>
): Promise<VarinDesktopCommandResult<K> | null> => {
  if (!hasDesktopInvoke()) {
    throw new Error('Desktop runtime is not available');
  }
  return invokeDesktop(command, ...invocation);
};

export const startDesktopWindowDrag = async (): Promise<void> => {
  if (!isDesktopShell()) {
    return;
  }

  try {
    await invokeDesktopCommand('desktop_start_window_drag');
  } catch {
    // ignore
  }
};

export const setDesktopWindowTitle = async (title: string): Promise<void> => {
  if (!isDesktopShell()) {
    return;
  }

  try {
    await invokeDesktopCommand('desktop_set_window_title', { title });
  } catch {
    // ignore
  }
};

export const setDesktopWindowTheme = async (
  themeMode?: string,
  themeVariant?: string,
): Promise<void> => {
  if (!isDesktopShell()) {
    return;
  }

  try {
    await invokeDesktopCommand('desktop_set_window_theme', { themeMode, themeVariant });
  } catch {
    // ignore
  }
};

export const getDesktopAppVersion = async (): Promise<string | null> => {
  if (!isDesktopShell()) {
    return null;
  }

  try {
    const version = await invokeDesktopCommand('desktop_get_app_version');
    return typeof version === 'string' && version.trim().length > 0 ? version : null;
  } catch {
    return null;
  }
};
