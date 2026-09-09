import { useEffect, useRef } from 'react';

/**
 * 管理用户所选文件的 Object URL 生命周期：
 * - 同一文件（按 name+size 缓存）只创建一次；
 * - 文件被替换/移除时释放其 URL；
 * - 组件卸载时释放全部 URL。
 */
export function useObjectUrlPool() {
  const pool = useRef<Map<string, string>>(new Map());

  const keyOf = (file: File): string => `${file.name}:${file.size}`;

  const ensure = (file: File): string => {
    const key = keyOf(file);
    const existing = pool.current.get(key);
    if (existing) return existing;
    const url = URL.createObjectURL(file);
    pool.current.set(key, url);
    return url;
  };

  // 依赖 useRef，卸载时释放全部
  useEffect(() => {
    const current = pool.current;
    return () => {
      current.forEach((url) => URL.revokeObjectURL(url));
      current.clear();
    };
  }, []);

  /** 保留给定 keys，释放其余（用于替换文件场景）。 */
  const retain = (keys: string[]): void => {
    const keep = new Set(keys);
    pool.current.forEach((url, key) => {
      if (!keep.has(key)) {
        URL.revokeObjectURL(url);
        pool.current.delete(key);
      }
    });
  };

  return { ensure, retain, keyOf };
}