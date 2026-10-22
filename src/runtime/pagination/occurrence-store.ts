import type { OccurrencePagination } from "./types.js";

interface Node {
  readonly left: Node | null;
  readonly right: Node | null;
  readonly value: OccurrencePagination | null;
}

export class OccurrenceStore implements Iterable<OccurrencePagination> {
  static from(entries: readonly OccurrencePagination[]): OccurrenceStore {
    return new OccurrenceStore(entries.length, build(entries, 0, entries.length));
  }

  readonly length: number;
  readonly #root: Node | null;
  #view: readonly OccurrencePagination[] | null = null;

  private constructor(length: number, root: Node | null) {
    this.length = length;
    this.#root = root;
  }

  get(index: number): OccurrencePagination | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    return valueAt(this.#root, 0, this.length, index);
  }

  set(index: number, value: OccurrencePagination): OccurrenceStore {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return this;
    return new OccurrenceStore(this.length, setValue(this.#root, 0, this.length, index, value));
  }

  every(predicate: (entry: OccurrencePagination) => boolean): boolean {
    for (const entry of this) if (!predicate(entry)) return false;
    return true;
  }

  view(): readonly OccurrencePagination[] {
    if (this.#view !== null) return this.#view;
    this.#view = new Proxy([] as OccurrencePagination[], {
      get: (target, property, receiver) => {
        if (property === "length") return this.length;
        if (property === Symbol.iterator) return this[Symbol.iterator].bind(this);
        if (typeof property === "string" && /^(0|[1-9][0-9]*)$/u.test(property)) {
          return this.get(Number(property));
        }
        return Reflect.get(target, property, receiver);
      },
      has: (target, property) => {
        if (typeof property === "string" && /^(0|[1-9][0-9]*)$/u.test(property)) {
          const index = Number(property);
          return index >= 0 && index < this.length;
        }
        return Reflect.has(target, property);
      },
      ownKeys: () => [
        "length",
        ...Array.from({ length: this.length }, (_, index) => String(index)),
      ],
      getOwnPropertyDescriptor: (target, property) => {
        if (typeof property === "string" && /^(0|[1-9][0-9]*)$/u.test(property)) {
          const index = Number(property);
          if (index < this.length) {
            return {
              configurable: true,
              enumerable: true,
              writable: false,
              value: this.get(index),
            };
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      set: () => false,
      deleteProperty: () => false,
    });
    return this.#view;
  }

  *[Symbol.iterator](): Iterator<OccurrencePagination> {
    for (let index = 0; index < this.length; index += 1) {
      const entry = this.get(index);
      if (entry !== undefined) yield entry;
    }
  }
}

function build(entries: readonly OccurrencePagination[], start: number, end: number): Node | null {
  if (start >= end) return null;
  if (end - start === 1) return { left: null, right: null, value: entries[start] ?? null };
  const middle = start + Math.floor((end - start) / 2);
  return {
    left: build(entries, start, middle),
    right: build(entries, middle, end),
    value: null,
  };
}

function valueAt(
  node: Node | null,
  start: number,
  end: number,
  index: number,
): OccurrencePagination | undefined {
  if (node === null) return undefined;
  if (end - start === 1) return node.value ?? undefined;
  const middle = start + Math.floor((end - start) / 2);
  return index < middle
    ? valueAt(node.left, start, middle, index)
    : valueAt(node.right, middle, end, index);
}

function setValue(
  node: Node | null,
  start: number,
  end: number,
  index: number,
  value: OccurrencePagination,
): Node {
  if (end - start === 1) return { left: null, right: null, value };
  const middle = start + Math.floor((end - start) / 2);
  return index < middle
    ? {
        left: setValue(node?.left ?? null, start, middle, index, value),
        right: node?.right ?? null,
        value: null,
      }
    : {
        left: node?.left ?? null,
        right: setValue(node?.right ?? null, middle, end, index, value),
        value: null,
      };
}
