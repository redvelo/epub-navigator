function requestUrl(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : new Request(request).url;
}

export class MemoryCache {
  readonly responses = new Map<string, Response>();
  keyCalls = 0;
  entryMatchCalls = 0;
  indexPutCalls = 0;
  deleteCalls = 0;
  failBeforeIndexPut: number | null = null;
  failBeforeDelete: number | null = null;

  readonly #failPut: (url: string) => boolean;

  constructor(failPut: (url: string) => boolean) {
    this.#failPut = failPut;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = requestUrl(request);
    if (url.includes("/entries/")) this.entryMatchCalls += 1;
    return this.responses.get(url)?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const url = requestUrl(request);
    if (this.#failPut(url)) throw new Error("injected write failure");
    if (url.endsWith("/index.json")) {
      this.indexPutCalls += 1;
      if (this.failBeforeIndexPut === this.indexPutCalls) throw new Error("injected index failure");
    }
    this.responses.set(url, response.clone());
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    this.deleteCalls += 1;
    if (this.failBeforeDelete === this.deleteCalls) throw new Error("injected delete failure");
    return this.responses.delete(requestUrl(request));
  }

  async keys(): Promise<Request[]> {
    this.keyCalls += 1;
    return [...this.responses.keys()].map((url) => new Request(url));
  }
}

export class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();
  failPut: (url: string) => boolean = () => false;

  async open(name: string): Promise<Cache> {
    let cache = this.stores.get(name);
    if (cache === undefined) {
      cache = new MemoryCache((url) => this.failPut(url));
      this.stores.set(name, cache);
    }
    return cache as unknown as Cache;
  }

  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
}
