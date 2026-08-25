type MonacoPerformanceMark =
  | 'editor.runtime.import.start'
  | 'editor.runtime.import.end'
  | 'editor.worker.created'
  | 'editor.model.ready'
  | 'editor.first.paint';

export const markMonacoPerformance = (name: MonacoPerformanceMark): void => {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  performance.mark(`piarium.${name}`);
};
