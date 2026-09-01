export const createSerialQueues = () => {
  const queues = new Map<string, Promise<unknown>>();

  const run = <Result>(key: string, work: () => Promise<Result>): Promise<Result> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }).catch(() => undefined);
    return next as Promise<Result>;
  };

  const runMany = <Result>(keys: readonly string[], work: () => Promise<Result>): Promise<Result> => {
    const unique = [...new Set(keys)].sort();
    const execute = async (): Promise<Result> => work();
    return unique.reduceRight(
      (nested: () => Promise<Result>, key: string) => () => run(key, nested),
      execute,
    )();
  };

  return { run, runMany };
};
