import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '../test/utils';
import { SceneCard } from '../components/SceneCard';
import { sceneFixtures } from '../fixtures/scenes';
import { formatOriginalFormat, formatUploadTime } from '../utils/provenance';

const base = sceneFixtures[0];

describe('GS-UI-01 作品卡片真实上传元数据', () => {
  it('按 YYYY-MM-DD HH:mm 与原始扩展名大写展示', () => {
    renderWithRouter(
      <SceneCard
        scene={{
          ...base,
          uploadedAt: '2026-03-04T05:06:00Z',
          originalFormat: 'ply',
        }}
      />,
    );
    // Format is timezone-independent.
    expect(screen.getByTestId(`scene-format-${base.id}`)).toHaveTextContent('PLY');
    // Local time still uses the required shape (YYYY-MM-DD HH:mm).
    const time = screen.getByTestId(`scene-upload-time-${base.id}`).textContent ?? '';
    expect(time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('没有真实上传记录的旧作品不显示任何伪造值', () => {
    renderWithRouter(
      <SceneCard scene={{ ...base, uploadedAt: null, originalFormat: null }} />,
    );
    expect(screen.queryByTestId(`scene-upload-time-${base.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`scene-format-${base.id}`)).not.toBeInTheDocument();
  });

  it('格式化助手对空值/非法值返回 null（不猜测）', () => {
    expect(formatUploadTime(null)).toBeNull();
    expect(formatUploadTime('not-a-date')).toBeNull();
    expect(formatOriginalFormat('')).toBeNull();
    expect(formatOriginalFormat('.zip')).toBe('ZIP');
    expect(formatOriginalFormat('sog')).toBe('SOG');
  });
});
