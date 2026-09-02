interface StartupUrlProbeOptions {
  development: boolean;
  packagedUi: boolean;
  skipLocalServer?: boolean;
}

export const resolveStartupUrlProbePlan = ({ development, packagedUi, skipLocalServer }: StartupUrlProbeOptions) => ({
  probeHmrApi: development === true && packagedUi !== true && skipLocalServer !== true,
  probeHmrUi: development === true && packagedUi !== true,
});

export const shouldIgnoreLoopbackConnectionLimit = ({ development, packagedUi }: StartupUrlProbeOptions) => (
  development !== true || packagedUi === true
);
