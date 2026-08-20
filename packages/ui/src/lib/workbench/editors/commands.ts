export type WorkbenchCommandHandler = () => void | Promise<void>;

type CommandRecord = {
  id: string;
  ownerId: string;
  handler: WorkbenchCommandHandler;
};

const commands = new Map<string, CommandRecord>();

export const registerWorkbenchCommand = (
  id: string,
  ownerId: string,
  handler: WorkbenchCommandHandler,
): (() => void) => {
  commands.set(id, { id, ownerId, handler });
  return () => {
    const current = commands.get(id);
    if (current?.ownerId === ownerId) commands.delete(id);
  };
};

export const executeWorkbenchCommand = async (id: string): Promise<boolean> => {
  const record = commands.get(id);
  if (!record) return false;
  await record.handler();
  return true;
};

export const listWorkbenchCommands = (): string[] => [...commands.keys()].sort();

export const resetWorkbenchCommands = (): void => {
  commands.clear();
};
