export interface SayVoice { locale: string; name: string }
export interface SayTtsCapability {
  available: boolean;
  reason?: string | undefined;
  voices: SayVoice[];
}

export const detectSayTtsCapability = async (
  processLike: Pick<NodeJS.Process, 'platform'>,
): Promise<SayTtsCapability> => {
  let sayTTSCapability: SayTtsCapability = { available: false, voices: [], reason: 'Not checked' };

  if (processLike.platform === 'darwin') {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const { stdout } = await execAsync('say -v "?"');
      const voices = stdout.split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const match = line.match(/^(.+?)\s+([a-zA-Z]{2}_[a-zA-Z]{2,3})\s+#/);
          const name = match?.[1]?.trim();
          const locale = match?.[2];
          if (name && locale) {
            return { name, locale };
          }
          return null;
        })
        .filter((voice): voice is SayVoice => Boolean(voice));
      sayTTSCapability = { available: true, voices };
      console.log(`macOS Say TTS available with ${voices.length} voices`);
    } catch (error) {
      sayTTSCapability = { available: false, voices: [], reason: 'say command not available' };
      console.log('macOS Say TTS not available:', error instanceof Error ? error.message : error);
    }
  } else {
    sayTTSCapability = { available: false, voices: [], reason: 'Not macOS' };
  }

  return sayTTSCapability;
};
