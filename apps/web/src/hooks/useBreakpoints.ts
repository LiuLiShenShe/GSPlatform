import { useEffect, useState } from 'react';

/**
 * 基于 window.innerWidth 的视口宽度 Hook。
 * 使用 resize 事件而非 matchMedia，便于 jsdom 测试中通过
 * 修改 window.innerWidth 后 dispatch resize 事件来驱动。
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() => window.innerWidth);

  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return width;
}

export function useIsMobile(): boolean {
  return useViewportWidth() < 992;
}

/** 纯函数：按视口宽度返回内容区 SceneCard 列数（用于 5/3/2/1 列规则测试）。 */
export function calcColumnCount(width: number): number {
  if (width >= 1200) return 5;
  if (width >= 768) return 3;
  if (width >= 480) return 2;
  return 1;
}

export function useResponsiveColumns(): number {
  return calcColumnCount(useViewportWidth());
}

/** 同步设置文档标题，卸载时恢复前一标题。 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    if (title) {
      document.title = `${title} - GSPlatform`;
    }
    return () => {
      document.title = previous;
    };
  }, [title]);
}