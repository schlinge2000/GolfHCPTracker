type PromiseWithResolversResult<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): PromiseWithResolversResult<T>;
    try<T>(callback: () => T | PromiseLike<T>): Promise<T>;
  }

  interface URLConstructor {
    parse?(input: string | URL, base?: string | URL): URL | null;
  }

  interface Array<T> {
    at?(index: number): T | undefined;
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
    at?(index: number): T | undefined;
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

  interface Map<K, V> {
    getOrInsertComputed?(key: K, callback: (key: K) => V): V;
  }

  interface String {
    at?(index: number): string | undefined;
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

if (typeof Promise.try !== "function") {
  Promise.try = function promiseTry<T>(callback: () => T | PromiseLike<T>) {
    return new Promise<T>((resolve, reject) => {
      try {
        resolve(callback());
      } catch (error) {
        reject(error);
      }
    });
  };
}

if (typeof Promise.allSettled !== "function") {
  (Promise as any).allSettled = function allSettled(values: Iterable<unknown>) {
    return Promise.all(
      Array.from(values, (value) =>
        Promise.resolve(value).then(
          (resolved) => ({ status: "fulfilled", value: resolved }),
          (reason) => ({ status: "rejected", reason }),
        ),
      ),
    ) as Promise<any>;
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

function normalizeAtIndex(length: number, index: number) {
  if (index < 0) return length + index;
  return index;
}

if (typeof Array.prototype.at !== "function") {
  Object.defineProperty(Array.prototype, "at", {
    value: function at<T>(this: T[], index: number) {
      const normalizedIndex = normalizeAtIndex(this.length, Math.trunc(index) || 0);
      return normalizedIndex >= 0 && normalizedIndex < this.length ? this[normalizedIndex] : undefined;
    },
    configurable: true,
    writable: true,
  });
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

if (typeof Map.prototype.getOrInsertComputed !== "function") {
  Object.defineProperty(Map.prototype, "getOrInsertComputed", {
    value: function getOrInsertComputed<K, V>(this: Map<K, V>, key: K, callback: (key: K) => V) {
      if (this.has(key)) return this.get(key);
      const value = callback(key);
      this.set(key, value);
      return value;
    },
    configurable: true,
    writable: true,
  });
}

if (typeof String.prototype.at !== "function") {
  Object.defineProperty(String.prototype, "at", {
    value: function at(index: number) {
      const input = String(this);
      const normalizedIndex = normalizeAtIndex(input.length, Math.trunc(index) || 0);
      return normalizedIndex >= 0 && normalizedIndex < input.length ? input.charAt(normalizedIndex) : undefined;
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

for (const typedArrayCtor of [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
 ] as any[]) {
  if (typeof typedArrayCtor === "undefined") continue;
  if (typeof typedArrayCtor.prototype.at === "function") continue;

  Object.defineProperty(typedArrayCtor.prototype, "at", {
    value: function at(index: number) {
      const normalizedIndex = normalizeAtIndex(this.length, Math.trunc(index) || 0);
      return normalizedIndex >= 0 && normalizedIndex < this.length ? this[normalizedIndex] : undefined;
    },
    configurable: true,
    writable: true,
  });
}

export {};