interface PwaInstallToastDecisionInput {
  readonly dismissed: string | null;
  readonly sessionShown: string | null;
  readonly hasActiveToast: boolean;
}

export const shouldShowPwaInstallToast = (
  input: PwaInstallToastDecisionInput,
): boolean => {
  if (input.dismissed === 'true') return false;
  if (input.sessionShown === 'true') return false;
  if (input.hasActiveToast) return false;
  return true;
};
