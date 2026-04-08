type PromiseWithResolversResult<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

declare global {
  interface PromiseConstructor {
    withResolvers?<T>(): PromiseWithResolversResult<T>;
  }

  interface URLConstructor {
    parse?(input: string | URL, base?: string | URL): URL | null;
  }

  interface Array<T> {
    findLast?<S extends T>(
      predicate: (value: T, index: number, array: T[]) => value is S,
      thisArg?: unknown,
    ): S | undefined;
    findLast?(
      predicate: (value: T, index: number, array: T[]) => unknown,
      thisArg?: unknown,
    ): T | undefined;
    findLastIndex?(
      predicate: (value: T, index: number, array: T[]) => unknown,
      thisArg?: unknown,
    ): number;
  }

  interface ReadonlyArray<T> {
    findLast?<S extends T>(
      predicate: (value: T, index: number, array: readonly T[]) => value is S,
      thisArg?: unknown,
    ): S | undefined;
    findLast?(
      predicate: (value: T, index: number, array: readonly T[]) => unknown,
      thisArg?: unknown,
    ): T | undefined;
    findLastIndex?(
      predicate: (value: T, index: number, array: readonly T[]) => unknown,
      thisArg?: unknown,
    ): number;
  }

  interface String {
    replaceAll?(searchValue: string | RegExp, replaceValue: string): string;
  }
}

if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (typeof URL.parse !== "function") {
  URL.parse = function parse(input: string | URL, base?: string | URL) {
    try {
      return base !== undefined ? new URL(input, base) : new URL(input);
    } catch {
      return null;
    }
  };
}

if (typeof Array.prototype.findLast !== "function") {
  Object.defineProperty(Array.prototype, "findLast", {
    value: function findLast<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown) {
      for (let index = this.length - 1; index >= 0; index -= 1) {
        const value = this[index];
        if (predicate.call(thisArg, value, index, this)) return value;
      }
      return undefined;
    },
    configurable: true,
    writable: true,
  });
}

if (typeof Array.prototype.findLastIndex !== "function") {
  Object.defineProperty(Array.prototype, "findLastIndex", {
    value: function findLastIndex<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown) {
      for (let index = this.length - 1; index >= 0; index -= 1) {
        if (predicate.call(thisArg, this[index], index, this)) return index;
      }
      return -1;
    },
    configurable: true,
    writable: true,
  });
}

if (typeof String.prototype.replaceAll !== "function") {
  Object.defineProperty(String.prototype, "replaceAll", {
    value: function replaceAll(searchValue: string | RegExp, replaceValue: string) {
      if (searchValue instanceof RegExp) {
        const flags = searchValue.flags.includes("g") ? searchValue.flags : `${searchValue.flags}g`;
        return this.replace(new RegExp(searchValue.source, flags), replaceValue);
      }
      return this.split(String(searchValue)).join(replaceValue);
    },
    configurable: true,
    writable: true,
  });
}

export {};