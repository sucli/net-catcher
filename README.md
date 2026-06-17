# NetCatcher

一个轻量级的 Chrome 网络请求抓包扩展，用于捕获和检查网页的 fetch / XMLHttpRequest 请求。

## 功能特性

- 🔍 **捕获网络请求**：拦截 fetch 和 XMLHttpRequest
- 🔌 **WebSocket 抓包**：捕获 WebSocket 连接和消息
- 📋 **请求详情**：查看 Headers、请求体、响应体
- 🔎 **过滤搜索**：按 URL、HTTP 方法、状态码过滤
- 📊 **请求统计**：2xx / 3xx / 4xx / 5xx 数量统计
- 📥 **导出 HAR**：导出为标准 HAR 格式文件
- 📋 **复制 cURL**：一键复制为 cURL 命令
- ⏸ **暂停/恢复**：随时暂停或恢复抓包
- 💾 **持久化存储**：关闭弹窗后数据不丢失

## 安装方式

### 1. 下载代码

```bash
git clone https://github.com/sucli/net-catcher.git
```

或者直接下载 ZIP 压缩包解压。

### 2. 加载到 Chrome

1. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions`
2. 开启右上角的 **「开发者模式」**
3. 点击 **「加载已解压的扩展程序」**
4. 选择下载的 `net-catcher` 文件夹
5. 扩展图标会出现在浏览器工具栏

## 使用方式

### 基本使用

1. 点击浏览器工具栏的 **NetCatcher** 图标
2. 弹窗会显示当前页面捕获的网络请求
3. 在页面上触发操作（点击按钮、刷新页面等），请求会实时显示

### 切换视图

弹窗顶部有 **HTTP** 和 **WebSocket** 两个标签页：
- **HTTP**：显示 fetch 和 XMLHttpRequest 请求
- **WebSocket**：显示 WebSocket 连接和消息

### 查看请求详情

点击任意一条 HTTP 请求，可以查看：

- **Headers**：请求头和响应头
- **请求体**：POST / PUT 请求的 body
- **响应体**：服务器返回的内容

### 查看 WebSocket 详情

点击任意一条 WebSocket 连接，可以查看：

- **连接信息**：URL、状态、协议、关闭代码等
- **消息列表**：所有发送和接收的消息
- **消息方向**：蓝色表示发送（↑），绿色表示接收（↓）
- **导出消息**：点击「📥 导出」保存为 JSON 文件

### 过滤和搜索

- **URL 搜索**：输入关键词过滤请求
- **HTTP 方法**：按 GET / POST / PUT / DELETE 等筛选
- **状态码**：按 2xx / 3xx / 4xx / 5xx 筛选
- **排序**：按时间、耗时、大小排序

### 导出数据

- **导出 HAR**：点击「📥 导出」按钮，下载为 `.har` 文件，可导入 Chrome DevTools
- **复制 cURL**：在请求详情中点击「📋 复制 cURL」，粘贴到终端直接执行

### 快捷键

在弹窗打开时：

- `↑` / `↓`：选择上一条/下一条请求
- `Enter`：打开选中请求的详情
- `Esc`：关闭详情面板
- `Ctrl+C` / `⌘+C`：复制选中请求的 cURL 命令

## 能捕获什么

| 类型 | 能否捕获 | 说明 |
|------|---------|------|
| fetch 请求 | ✅ | 通过拦截 `window.fetch` |
| XMLHttpRequest | ✅ | 通过拦截 `XHR.prototype` |
| 页面跳转 | ❌ | 整页刷新会丢失状态 |
| 静态资源 | ❌ | 图片、脚本、CSS 等 |
| WebSocket | ✅ | 捕获连接、消息收发、关闭事件 |

> 💡 如果需要捕获页面跳转或静态资源，建议使用 Chrome DevTools 的 Network 面板。

## 技术实现

采用**双脚本架构**解决 Manifest V3 的限制：

```
┌─────────────────────────────────────────────────────────┐
│  页面 (MAIN world)                                       │
│  content_script_main.js                                  │
│  - 拦截 fetch / XMLHttpRequest                           │
│  - 通过 postMessage 发送数据                              │
└─────────────────────┬───────────────────────────────────┘
                      │ window.postMessage
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Content Script (ISOLATED world)                         │
│  content_script_bridge.js                                │
│  - 监听 postMessage                                      │
│  - 通过 chrome.runtime.sendMessage 转发                   │
└─────────────────────┬───────────────────────────────────┘
                      │ chrome.runtime.sendMessage
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Background (Service Worker)                             │
│  background.js                                           │
│  - 存储请求数据                                           │
│  - 匹配请求和响应                                         │
│  - 通知 popup 更新                                        │
└─────────────────────────────────────────────────────────┘
```

### 为什么需要双脚本？

Chrome 扩展的 Content Script 有两个运行世界：

- **MAIN world**：可以访问页面的 JS（拦截 fetch/XHR），但不能使用扩展 API
- **ISOLATED world**：可以使用扩展 API（chrome.runtime），但无法拦截页面代码

为了同时实现「拦截请求」和「发送消息给 background」，需要两个脚本配合工作。

## 项目结构

```
net-catcher/
├── manifest.json              # 扩展配置
├── background.js              # Service Worker
├── content_script_main.js     # MAIN world - 拦截请求
├── content_script_bridge.js   # ISOLATED world - 消息中转
├── popup.html                 # 弹窗页面
├── popup.js                   # 弹窗逻辑
├── popup.css                  # 样式
├── README.md                  # 说明文档
└── icons/
    ├── icon16.svg
    ├── icon48.svg
    └── icon128.svg
```

## 常见问题

### Q: 打开弹窗后没有显示任何请求？

A: 确保：
1. 扩展已正确加载（chrome://extensions 页面显示绿色开关）
2. 在当前页面触发了网络请求（刷新页面、点击按钮等）
3. 检查是否有报错（点击「错误」按钮查看）

### Q: 某些请求没有被捕获？

A: 可能的原因：
- 页面跳转（整页刷新）无法捕获
- 静态资源（图片、CSS、JS）无法捕获
- WebSocket 连接无法捕获
- 某些使用 Service Worker 的请求可能无法捕获

### Q: 数据会保存多久？

A: 数据存储在浏览器本地，最多保存 500 条请求。关闭浏览器后数据不会丢失，但建议重要数据及时导出 HAR 文件。

## 开发相关

本地开发和调试：

1. 修改代码后，去 `chrome://extensions` 点击扩展的刷新按钮
2. 查看 Service Worker 日志：点击「Service Worker」链接
3. 查看弹窗日志：在弹窗内右键 → 检查

## 许可证

MIT License
