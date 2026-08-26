export const shouldRenderPiExtensionStatus = (key: string): boolean => (
  key !== 'mcp' && key !== 'pi-permission-system'
);
