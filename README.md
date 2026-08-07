# NetCatcher

一个功能强大的 Chrome 网络请求抓包扩展，支持 HTTP 请求捕获、WebSocket 抓包、请求重放、Mock 响应、时间线分析等功能。

## 功能特性

### 🔍 请求捕获
- 拦截 fetch 和 XMLHttpRequest
- 通过 `webRequest` 补充页面导航、脚本、样式、图片等网络层请求元数据
- 捕获 EventSource/SSE 消息和 `sendBeacon` 请求
- 捕获 WebSocket 连接和消息
- WebSocket 二进制消息提供 Base64/Hex 摘要和重放
- 显示请求/响应详情（Headers、Body）
- 响应预览（JSON、HTML、图片）

### 🔄 请求重放
- 一键重发请求，方便接口调试
- 导入 HAR 和 cURL 请求
- 批量重放选中的请求并返回逐条结果
- 查看重放结果（状态码、响应内容）

### 🎭 Mock 响应
- 自定义 URL 匹配规则（支持正则）
- 支持 Query、请求头、请求体条件匹配和规则优先级
- 返回自定义状态码、Headers、Body
- 支持模拟网络错误、响应延迟
- 快速启用/禁用规则

### 📊 时间线分析
- 甘特图展示请求时间分布
- 识别串行/并行请求
- 分析页面加载瓶颈
- JSON 响应支持树形查看
- 自动识别 GraphQL 操作

### 🔎 过滤与搜索
- 按 URL、HTTP 方法、状态码、类型过滤
- 按当前标签页或全部标签页查看
- 保存/加载常用过滤器
- 请求分组（按域名折叠）
- 收藏筛选、标签管理、WebSocket 消息搜索

### ⚡ 性能优化
- 全局唯一 ID 精确关联请求与响应
- WebSocket 消息数量限制
- 内存自动清理
- 响应体异步采集（单条最多保留 1 MB，不阻塞流式响应）

### 📋 其他功能
- 请求对比（Ctrl+Click 多选两个请求）
- 导出 HAR 文件
- 复制 cURL 命令
- 收藏重要请求
- 键盘快捷键
- 敏感请求头和 JSON 字段自动脱敏
- Mock 支持 HTTP 方法和响应延迟
- 命名抓包会话，可创建、切换和删除独立记录
- WebSocket 消息重放
- 保存响应断言和可重复执行的测试场景
- Chrome Side Panel 持久化查看
- 从捕获结果导出基础 OpenAPI 3.0 文档

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
2. 打开「重放结果」标签，编辑方法、Headers、Body
3. 点击详情面板的「🔄 重放」按钮
4. 在「重放结果」标签查看响应

### Mock 响应

1. 切换到「Mock」标签页
2. 点击「+ 添加规则」
3. 填写 URL 匹配模式和自定义响应
4. 开启规则后，匹配的请求将返回自定义内容

### 过滤器

1. 设置过滤条件（URL、方法、状态码等）
2. 点击「💾」按钮保存
3. 从下拉菜单快速加载已保存的过滤器

### 导入与批量重放

- 点击工具栏的「导入 HAR」按钮选择 HAR/JSON 文件
- 点击「导入 cURL」并粘贴常见 cURL 命令
- 使用 Ctrl + 点击选中多个请求，再点击「批量重放」

### 断言与测试场景

- 在请求详情中保存状态码、最大耗时和 JSON 路径断言
- 选中多个请求后保存为测试场景
- 从工具栏选择场景并运行，查看通过数量

### OpenAPI 与侧边栏

- 点击「API↓」导出当前范围的 OpenAPI 3.0 文档
- 点击「◧」在 Chrome Side Panel 中持续查看抓包结果

### 会话管理

- 使用工具栏的会话下拉菜单切换记录集合
- 点击「+」创建新的命名会话
- 会话数据会按当前会话独立保存，并保留有限的请求和响应体大小

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

### 精确请求关联

每个页面和 frame 使用全局唯一 ID 关联请求与响应，避免并发请求、跨标签页请求相互覆盖：

```javascript
const captureId = crypto.randomUUID();
```

### 时间线可视化

用 CSS 定位实现瀑布图：
- 计算请求的相对起始时间和持续时间
- 转换为百分比定位
- 颜色编码表示状态

## 版本历史

| 版本 | 日期 | 更新内容 |
|------|------|---------|
| 2.3.0 | 2026-08-07 | 增加二进制 WebSocket 分析、GraphQL 识别、JSON 树、响应断言、测试场景、Side Panel 和 OpenAPI 导出 |
| 2.2.0 | 2026-08-07 | 增加网络层捕获、EventSource、命名会话、HAR/cURL 导入、批量重放、条件 Mock 和 WebSocket 重放 |
| 2.1.0 | 2026-07-23 | 增加标签页范围、脱敏、可编辑重放、方法级 Mock 和 WebSocket 搜索 |
| 2.0.1 | 2026-07-17 | 修复 Mock、WebSocket 事件、跨页面关联和消息权限问题 |
| 2.0.0 | 2026-06-17 | 重放、Mock、时间线、对比、分组、过滤器保存 |
| 1.2.0 | 2026-06-17 | WebSocket 抓包 |
| 1.1.1 | 2026-06-17 | 修复列表渲染 Bug |
| 1.1.0 | 2026-06-17 | 侧边栏模式（已移除）|
| 1.0.0 | 2026-06-16 | 初始版本 |

## 许可证

MIT License

## 开发检查

```bash
npm run check
npm test
npm run coverage
```

覆盖率命令覆盖 Service Worker、MAIN world 和 Bridge 的 VM 测试代码，并要求总体行覆盖率不低于 70%。
