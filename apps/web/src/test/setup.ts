import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

/**
 * jsdom 缺失的浏览器 API 补齐，供 antd 与组件在测试环境正常工作。
 */

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverMock,
    writable: true,
  });
}

// URL.createObjectURL / revokeObjectURL：jsdom 未实现，默认占位；
// 需要断言释放行为的用例可在各自测试中 mock。
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
}

// 模拟窗口滚动等常用但 jsdom 不关心的 API
if (typeof window.scrollTo !== 'function') {
  window.scrollTo = () => undefined;
}

/**
 * React Router v7 在导航时内部执行 `new Request(url, { signal })`，
 * 其中 signal 来自 jsdom 的 AbortController。Node/undici 的 Request
 * 构造函数会校验 `signal instanceof AbortSignal`（Node 原生），jsdom
 * 的 AbortSignal 不满足，导致 TypeError。这里包装全局 Request：
 * 构造前先剥离 signal，构造后再把原 signal 挂回实例，使
 * `request.signal` 在测试中仍然可用，同时绕过 undici 的校验。
 */
const NativeRequest = globalThis.Request;
if (typeof NativeRequest === 'function') {
  class SafeRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      const { signal, ...rest } = init ?? {};
      super(input, rest);
      if (signal != null) {
        Object.defineProperty(this, 'signal', {
          value: signal,
          configurable: true,
        });
      }
    }
  }
  Object.defineProperty(globalThis, 'Request', {
    value: SafeRequest,
    configurable: true,
  });
}