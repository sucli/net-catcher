# NetCatcher

一个功能强大的 Chrome 网络请求抓包扩展，支持 HTTP 请求捕获、WebSocket 抓包、请求重放、Mock 响应、时间线分析等功能。

## 功能特性

### 🔍 请求捕获
- 拦截 fetch 和 XMLHttpRequest
- 捕获 WebSocket 连接和消息
- 显示请求/响应详情（Headers、Body）
- 响应预览（JSON、HTML、图片）

### 🔄 请求重放
- 一键重发请求，方便接口调试
- 查看重放结果（状态码、响应内容）

### 🎭 Mock 响应
- 自定义 URL 匹配规则（支持正则）
- 返回自定义状态码、Headers、Body
- 快速启用/禁用规则

### 📊 时间线分析
- 甘特图展示请求时间分布
- 识别串行/并行请求
- 分析页面加载瓶颈

### 🔎 过滤与搜索
- 按 URL、HTTP 方法、状态码、类型过滤
- 保存/加载常用过滤器
- 请求分组（按域名折叠）

### ⚡ 性能优化
- 请求去重（避免轮询刷屏）
- WebSocket 消息数量限制
- 内存自动清理

### 📋 其他功能
- 请求对比（Ctrl+Click 多选两个请求）
- 导出 HAR 文件
- 复制 cURL 命令
- 收藏重要请求
- 键盘快捷键

## 安装

```bash
git clone https://github.com/sucli/net-catcher.git
```

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `net-catcher` 文件夹

## 使用方式

### 基本操作

| 操作 | 说明 |
|------|------|
| 点击图标 | 打开弹窗查看请求 |
| 点击请求 | 查看详情 |
| Ctrl + 点击 | 多选请求（选 2 个自动对比） |
| ↑ / ↓ 键 | 快速切换请求 |
| Esc | 关闭弹窗 |

### 视图切换

弹窗顶部有 4 个标签页：
- **HTTP**：显示 fetch/XHR 请求列表
- **WS**：显示 WebSocket 连接
- **时间线**：瀑布图展示请求时间
- **Mock**：管理 Mock 规则

### 请求重放

1. 点击选中一个请求
2. 点击详情面板的「🔄 重放」按钮
3. 切换到「重放结果」标签查看响应

### Mock 响应

1. 切换到「Mock」标签页
2. 点击「+ 添加规则」
3. 填写 URL 匹配模式和自定义响应
4. 开启规则后，匹配的请求将返回自定义内容

### 过滤器

1. 设置过滤条件（URL、方法、状态码等）
2. 点击「💾」按钮保存
3. 从下拉菜单快速加载已保存的过滤器

## 文件结构

```
net-catcher/
├── manifest.json              # 扩展配置
├── background.js              # Service Worker（核心逻辑）
├── content_script_main.js     # MAIN world（拦截 fetch/XHR/WebSocket）
├── content_script_bridge.js   # ISOLATED world（消息中转）
├── popup.html                 # 弹窗页面
├── popup.js                   # 弹窗逻辑（~1000 行）
├── popup.css                  # 样式
├── README.md                  # 说明文档
└── icons/
    ├── icon16.svg
    ├── icon48.svg
    └── icon128.svg
```

## 技术亮点

### 双脚本架构

Chrome MV3 的 Content Script 有两种 world：
- **MAIN world**：能拦截页面 JS，但不能用扩展 API
- **ISOLATED world**：能用扩展 API，但不能拦截页面 JS

解决方案：两个脚本配合
- `content_script_main.js`（MAIN）拦截请求 → `postMessage`
- `content_script_bridge.js`（ISOLATED）接收 → `chrome.runtime.sendMessage`

### 请求去重

同一 URL 短时间内多次请求（如轮询），自动去重避免刷屏：

```javascript
function isDuplicateRequest(url, startTime) {
  const threshold = 50; // 50ms
  return requests.some(r =>
    r.url === url &&
    Math.abs(r.startTime - startTime) < threshold
  );
}
```

### 时间线可视化

用 CSS 定位实现瀑布图：
- 计算请求的相对起始时间和持续时间
- 转换为百分比定位
- 颜色编码表示状态

## 版本历史

| 版本 | 日期 | 更新内容 |
|------|------|---------|
| 2.0.0 | 2026-06-17 | 重放、Mock、时间线、对比、分组、过滤器保存 |
| 1.2.0 | 2026-06-17 | WebSocket 抓包 |
| 1.1.1 | 2026-06-17 | 修复列表渲染 Bug |
| 1.1.0 | 2026-06-17 | 侧边栏模式（已移除）|
| 1.0.0 | 2026-06-16 | 初始版本 |

## 许可证

MIT License
