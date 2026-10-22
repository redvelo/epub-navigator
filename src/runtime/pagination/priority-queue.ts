interface Item {
  readonly occurrence: number;
  readonly priority: number;
}

export class OccurrencePriorityQueue {
  static from(occurrences: readonly number[], current: number | null): OccurrencePriorityQueue {
    const queue = new OccurrencePriorityQueue();
    queue.#heap.push(
      ...occurrences.map((occurrence) => ({ occurrence, priority: priority(occurrence, current) })),
    );
    for (let index = Math.floor(queue.#heap.length / 2) - 1; index >= 0; index -= 1) {
      queue.#siftDown(index);
    }
    return queue;
  }

  readonly #heap: Item[] = [];

  push(occurrence: number, current: number | null): void {
    const item = { occurrence, priority: priority(occurrence, current) };
    this.#heap.push(item);
    let index = this.#heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!higher(item, this.#heap[parent]!)) break;
      this.#heap[index] = this.#heap[parent]!;
      index = parent;
    }
    this.#heap[index] = item;
  }

  pop(): number | null {
    const first = this.#heap[0];
    const last = this.#heap.pop();
    if (first === undefined || last === undefined) return null;
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.#siftDown(0);
    }
    return first.occurrence;
  }

  #siftDown(start: number): void {
    const item = this.#heap[start];
    if (item === undefined) return;
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.#heap.length) break;
      let child = left;
      if (right < this.#heap.length && higher(this.#heap[right]!, this.#heap[left]!)) {
        child = right;
      }
      if (!higher(this.#heap[child]!, item)) break;
      this.#heap[index] = this.#heap[child]!;
      index = child;
    }
    this.#heap[index] = item;
  }
}

function priority(occurrence: number, current: number | null): number {
  if (current === null) return occurrence;
  const distance = occurrence - current;
  if (distance === 0) return 0;
  return distance > 0 ? distance * 2 - 1 : -distance * 2;
}

function higher(left: Item, right: Item): boolean {
  return (
    left.priority < right.priority ||
    (left.priority === right.priority && left.occurrence < right.occurrence)
  );
}
