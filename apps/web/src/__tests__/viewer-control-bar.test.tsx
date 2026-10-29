import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Providers } from '../app/providers';
import { ViewerControlBar, type ViewerControlBarProps } from '../features/viewer-shell/ViewerControlBar';

function setup(overrides: Partial<ViewerControlBarProps> = {}) {
  const props: ViewerControlBarProps = {
    cameraMode: 'orbit',
    performanceMode: false,
    moveSpeedMultiplier: 1,
    showAnnotations: true,
    isFullscreen: false,
    walkAllowed: false,
    hasAnimation: false,
    canStartVR: false,
    onReset: vi.fn(),
    onCameraMode: vi.fn(),
    onMoveSpeed: vi.fn(),
    onPerformanceMode: vi.fn(),
    onFrame: vi.fn(),
    onToggleAnnotations: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleHelp: vi.fn(),
    onToggleAnimation: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onEnterVR: vi.fn(),
    onSelectAnnotation: vi.fn(),
    ...overrides,
  };
  render(
    <Providers>
      <ViewerControlBar {...props} />
    </Providers>,
  );
  return props;
}

describe('GS-UI-01 底部控制栏：四组真实控制', () => {
  it('① 回到起点调用现有 resetCamera 处理器', async () => {
    const props = setup();
    await userEvent.click(screen.getByTestId('ov2-reset'));
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it('② 查看方式反映当前官方 cameraMode；无碰撞时地面行走不可用但入口仍在', async () => {
    const props = setup({ cameraMode: 'fly', walkAllowed: false });
    // fly 选项当前选中
    expect(screen.getByText('自由飞行').closest('.ant-segmented-item')).toHaveClass(
      'ant-segmented-item-selected',
    );
    // walk 入口存在但禁用（不是死按钮伪装可用）
    const walkLabel = screen.getByText('地面行走（不可用）');
    expect(walkLabel.closest('.ant-segmented-item')).toHaveClass('ant-segmented-item-disabled');
    await userEvent.click(screen.getByText('环绕'));
    expect(props.onCameraMode).toHaveBeenCalledWith('orbit');
  });

  it('② 碰撞/尺度可用时地面行走可切换', async () => {
    const props = setup({ walkAllowed: true });
    await userEvent.click(screen.getByText('地面行走'));
    expect(props.onCameraMode).toHaveBeenCalledWith('walk');
  });

  it('③ 速度按钮显示官方基准速度；1× 时自由飞行 4.0 m/s', () => {
    setup({ cameraMode: 'fly', moveSpeedMultiplier: 1 });
    expect(screen.getByTestId('ov2-speed')).toHaveTextContent('4.0 m/s');
  });

  it('③ 行走模式显示官方 7.0 m/s 基准', () => {
    setup({ cameraMode: 'walk', moveSpeedMultiplier: 2 });
    expect(screen.getByTestId('ov2-speed')).toHaveTextContent('14.0 m/s');
  });

  it('④ 画质模式：高清 → 关闭性能模式，流畅 → 开启', async () => {
    const hd = setup({ performanceMode: true });
    await userEvent.click(screen.getByText('高清'));
    expect(hd.onPerformanceMode).toHaveBeenCalledWith(false);
  });

  it('④ 画质模式：流畅选项开启性能模式', async () => {
    const smooth = setup({ performanceMode: false });
    await userEvent.click(screen.getByText('流畅'));
    expect(smooth.onPerformanceMode).toHaveBeenCalledWith(true);
  });

  it('官方能力入口：设置 / 帮助转发到官方面板，不复制实现', async () => {
    const props = setup();
    await userEvent.click(screen.getByTestId('ov2-settings'));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('ov2-help'));
    expect(props.onToggleHelp).toHaveBeenCalledTimes(1);
  });

  it('未就绪时全部入口禁用（不提供假可用状态）', () => {
    setup({ disabled: true });
    expect(screen.getByTestId('ov2-reset')).toBeDisabled();
    expect(screen.getByTestId('ov2-speed')).toBeDisabled();
    expect(screen.getByTestId('ov2-settings')).toBeDisabled();
  });
});

describe('GS-UI-01 修复：标记点快速切换（官方 annotationNav 的 Prev/Next 语义）', () => {
  const annotations = [
    { id: 'a1', title: '正门' },
    { id: 'a2', title: '客厅' },
    { id: 'a3', title: '阳台' },
  ];

  it('无标记点时不渲染该组', () => {
    setup();
    expect(screen.queryByTestId('ov2-annotation-current')).toBeNull();
  });

  it('即使只有 1 个标记点也显示入口（官方 <2 会隐藏 annotationNav）', () => {
    setup({ annotations: [annotations[0]], selectedAnnotationId: null });
    expect(screen.getByTestId('ov2-annotation-current')).toBeInTheDocument();
    expect(screen.getByTestId('ov2-annotation-current')).toHaveTextContent('标记点 (1)');
  });

  it('未选中时「下一个」选中第一个，「上一个」选中最后一个', async () => {
    const props = setup({ annotations, selectedAnnotationId: null });
    await userEvent.click(screen.getByTestId('ov2-annotation-next'));
    expect(props.onSelectAnnotation).toHaveBeenLastCalledWith('a1');
    await userEvent.click(screen.getByTestId('ov2-annotation-prev'));
    expect(props.onSelectAnnotation).toHaveBeenLastCalledWith('a3');
  });

  it('选中项显示序号/总数与标题；前后环切调用官方 selectAnnotation（数据库 ID，不是下标）', async () => {
    const props = setup({ annotations, selectedAnnotationId: 'a2' });
    expect(screen.getByTestId('ov2-annotation-current')).toHaveTextContent('2/3 · 客厅');
    await userEvent.click(screen.getByTestId('ov2-annotation-next'));
    expect(props.onSelectAnnotation).toHaveBeenLastCalledWith('a3');
    await userEvent.click(screen.getByTestId('ov2-annotation-prev'));
    expect(props.onSelectAnnotation).toHaveBeenLastCalledWith('a1');
  });

  it('点标题下的列表项直接选择该标记点', async () => {
    const props = setup({ annotations, selectedAnnotationId: 'a1' });
    await userEvent.click(screen.getByTestId('ov2-annotation-current'));
    await userEvent.click(await screen.findByText('阳台'));
    expect(props.onSelectAnnotation).toHaveBeenCalledWith('a3');
  });

  it('viewer 未就绪时标记点入口禁用', () => {
    setup({ annotations, disabled: true });
    expect(screen.getByTestId('ov2-annotation-prev')).toBeDisabled();
    expect(screen.getByTestId('ov2-annotation-current')).toBeDisabled();
    expect(screen.getByTestId('ov2-annotation-next')).toBeDisabled();
  });
});
