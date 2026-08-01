const savedDescriptors = new Map();

export function installGlobalStub(name, value) {
  if (!savedDescriptors.has(name)) {
    savedDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }

  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

export function restoreGlobalStubs() {
  for (const [name, descriptor] of savedDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
  savedDescriptors.clear();
}
