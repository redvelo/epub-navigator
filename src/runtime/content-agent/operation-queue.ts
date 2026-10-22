export interface AgentWork {
  readonly key: string;
  readonly controller: AbortController;
}

export class OperationCancelled extends Error {}

export function ensureActive(work: AgentWork): void {
  if (work.controller.signal.aborted) throw new OperationCancelled();
}

export function createOperationQueue(maximumCompletedOperations = 256): {
  enqueue(task: () => void | PromiseLike<void>): void;
  begin(type: string, operation: number): AgentWork | null;
  cancel(type: string, operation: number): void;
  complete(work: AgentWork): void;
} {
  const operations = new Map<string, AgentWork>();
  const completedOperations = new Set<string>();
  const completedOperationOrder: string[] = [];
  let queue = Promise.resolve();

  const operationKey = (type: string, operation: number): string => `${type}:${operation}`;
  const rememberCompletedOperation = (key: string): void => {
    if (completedOperations.has(key)) return;
    completedOperations.add(key);
    completedOperationOrder.push(key);
    if (completedOperationOrder.length > maximumCompletedOperations) {
      const expired = completedOperationOrder.shift();
      if (expired !== undefined) completedOperations.delete(expired);
    }
  };

  return {
    enqueue(task): void {
      queue = queue.then(task);
    },
    begin(type, operation): AgentWork | null {
      const key = operationKey(type, operation);
      if (operations.has(key) || completedOperations.has(key)) return null;
      const work = { key, controller: new AbortController() };
      operations.set(key, work);
      return work;
    },
    cancel(type, operation): void {
      const key = operationKey(type, operation);
      operations.get(key)?.controller.abort();
      rememberCompletedOperation(key);
    },
    complete(work): void {
      operations.delete(work.key);
      rememberCompletedOperation(work.key);
    },
  };
}
