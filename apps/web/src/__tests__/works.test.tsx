import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

describe('我的作品页', () => {
  it('加载后显示作品总数与 Tabs', async () => {
    renderApp({ route: '/works' });
    expect(await screen.findByText('全部 12')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '已发布 7' })).toBeInTheDocument();
  });

  it('点击「草稿」Tab 仅显示草稿作品', async () => {
    renderApp({ route: '/works' });
    await screen.findByText('全部 12');
    await userEvent.click(screen.getByRole('tab', { name: /草稿 3/ }));
    expect(await screen.findByText('古建筑内饰扫描')).toBeInTheDocument();
    // 已发布作品不出现
    expect(screen.queryByText('我的街拍作品 A')).not.toBeInTheDocument();
  });

  it('编辑按钮禁用并说明阶段', async () => {
    renderApp({ route: '/works' });
    const card = await screen.findByTestId('works-card-work-01');
    // antd icons with aria-hidden prevent name pollution
    const editBtn = within(card).getByRole('button', { name: '编辑' });
    expect(editBtn).toBeDisabled();
  });

  it('删除按钮触发二次确认弹窗', async () => {
    renderApp({ route: '/works' });
    const card = await screen.findByTestId('works-card-work-01');
    // aria-hidden on antd icon ensures clean accessible name
    await userEvent.click(within(card).getByRole('button', { name: '删除' }));
    expect(
      await screen.findByText('确认删除「我的街拍作品 A」？'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(
      await screen.findByText(/已记录删除/),
    ).toBeInTheDocument();
  });

  it('空状态与恢复操作', async () => {
    renderApp({ route: '/works' });
    await screen.findByText('全部 12');
    await userEvent.click(screen.getByRole('tab', { name: /处理中 1/ }));
    // WorkCard prefix text + title are split; use regex
    expect(await screen.findByText(/自然场景重建中/)).toBeInTheDocument();
  });
});
