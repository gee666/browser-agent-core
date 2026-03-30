import { jest } from '@jest/globals';

// jsdom's crypto doesn't include randomUUID — polyfill it.
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  Object.defineProperty(globalThis.crypto ?? (globalThis.crypto = {}), 'randomUUID', {
    value: () => {
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
      return `${hex.slice(0,4).join('')}-${hex.slice(4,6).join('')}-${hex.slice(6,8).join('')}-${hex.slice(8,10).join('')}-${hex.slice(10).join('')}`;
    },
    configurable: true,
    writable: true,
  });
}

global.chrome = {
  runtime: {
    onMessage: { addListener: jest.fn() },
    sendMessage: jest.fn(),
    connectNative: jest.fn(),
  },
  tabs: {
    query: jest.fn(),
    sendMessage: jest.fn(),
    update: jest.fn(),
    captureVisibleTab: jest.fn(),
  },
  storage: {
    local: { get: jest.fn(), set: jest.fn() },
  },
  scripting: {
    executeScript: jest.fn(),
  },
  webNavigation: {
    onCompleted: { addListener: jest.fn(), removeListener: jest.fn() },
  },
};
