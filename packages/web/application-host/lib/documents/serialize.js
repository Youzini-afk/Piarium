export const createSerialQueues = () => {
  const queues = new Map();

  const run = (key, work) => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }).catch(() => undefined);
    return next;
  };

  const runMany = (keys, work) => {
    const unique = [...new Set(keys)].sort();
    const execute = async () => work();
    return unique.reduceRight((nested, key) => () => run(key, nested), execute)();
  };

  return { run, runMany };
};
