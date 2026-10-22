interface Node {
  readonly left: Node | null;
  readonly right: Node | null;
  readonly sum: number;
  readonly known: number;
  readonly blocked: number;
}

export class PagePrefixIndex {
  static empty(length: number): PagePrefixIndex {
    return new PagePrefixIndex(length, null);
  }

  readonly #length: number;
  readonly #root: Node | null;

  private constructor(length: number, root: Node | null) {
    this.#length = length;
    this.#root = root;
  }

  set(index: number, pageCount: number, known: boolean, blocked = false): PagePrefixIndex {
    if (index < 0 || index >= this.#length || this.#length === 0) return this;
    return new PagePrefixIndex(
      this.#length,
      setNode(this.#root, 0, this.#length, index, pageCount, known ? 1 : 0, blocked ? 1 : 0),
    );
  }

  pageStart(occurrence: number): number | "pending" | null {
    if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= this.#length) return null;
    const prefix = query(this.#root, 0, this.#length, occurrence);
    if (prefix.blocked > 0) return null;
    return prefix.known === occurrence ? prefix.sum : "pending";
  }
}

function setNode(
  node: Node | null,
  start: number,
  end: number,
  index: number,
  sum: number,
  known: number,
  blocked: number,
): Node {
  if (end - start === 1) return { left: null, right: null, sum, known, blocked };
  const middle = start + Math.floor((end - start) / 2);
  const left =
    index < middle
      ? setNode(node?.left ?? null, start, middle, index, sum, known, blocked)
      : (node?.left ?? null);
  const right =
    index >= middle
      ? setNode(node?.right ?? null, middle, end, index, sum, known, blocked)
      : (node?.right ?? null);
  return {
    left,
    right,
    sum: (left?.sum ?? 0) + (right?.sum ?? 0),
    known: (left?.known ?? 0) + (right?.known ?? 0),
    blocked: (left?.blocked ?? 0) + (right?.blocked ?? 0),
  };
}

function query(node: Node | null, start: number, end: number, exclusiveEnd: number): Node {
  if (node === null || exclusiveEnd <= start) {
    return { left: null, right: null, sum: 0, known: 0, blocked: 0 };
  }
  if (end <= exclusiveEnd) return node;
  const middle = start + Math.floor((end - start) / 2);
  const left = query(node.left, start, middle, exclusiveEnd);
  const right = query(node.right, middle, end, exclusiveEnd);
  return {
    left: null,
    right: null,
    sum: left.sum + right.sum,
    known: left.known + right.known,
    blocked: left.blocked + right.blocked,
  };
}
