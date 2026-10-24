import { createRoot } from 'react-dom/client';
import { Providers } from './app/providers';
import App from './app/App';
import './index.css';
// GS-DESKTOP-02：官方 PlayCanvas PCUI 样式（平台创作工作区 + Saved Views 扩展入口）。
// Styles only need to be imported once per project (official PCUI guidance).
import '@playcanvas/pcui/styles';

// GS-DESKTOP-02：不启用 React StrictMode。
//
// `@playcanvas/pcui/react` 6.1.4 的挂载模型是「React 渲染一个宿主节点，PCUI 在
// componentDidMount 里把官方元素（Panel 头部、TextInput 内部 input 等）**追加**
// 到该节点，且不实现卸载清理」。StrictMode 在开发模式下会 mount → unmount →
// mount，这些追加节点就会重复一份（实测：每个 Panel 出现两个标题、每个
// TextInput 出现两个 input），导致开发模式下的 DOM 与生产不一致，也会让真实
// 输入落在一个 PCUI 不读取的重复 input 上。
//
// 生产构建本就不会双挂载；这里去掉 StrictMode 让开发模式与生产 DOM 一致。
// 其他 React 严格性检查（lint、类型、Vitest）不受影响。
createRoot(document.getElementById('root')!).render(
  <Providers>
    <App />
  </Providers>,
);
