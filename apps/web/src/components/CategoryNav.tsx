import { sceneCategories } from '../fixtures/scenes';

export interface CategoryNavProps {
  active: string;
  onChange: (category: string) => void;
}

const ITEMS = ['发现', ...sceneCategories] as const;

/**
 * 顶部分类导航：语义化按钮 + aria-pressed 标识选中态，键盘可操作。
 */
export function CategoryNav({ active, onChange }: CategoryNavProps) {
  return (
    <nav className="gs-category-nav" aria-label="场景分类">
      {ITEMS.map((category) => (
        <button
          key={category}
          type="button"
          className="gs-category-nav__item"
          aria-pressed={active === category}
          onClick={() => onChange(category)}
        >
          {category}
        </button>
      ))}
    </nav>
  );
}