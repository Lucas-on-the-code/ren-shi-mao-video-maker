# 人是猫视频制作器

把 MIDI 文件变成「小人物唱歌」视频：每个轨道对应一个小人物，有音时张嘴、无音时闭嘴，并可叠加歌词、背景图，最终导出为 ProRes MOV。

## 功能特性

- **轨道 → 人物**：自动按 MIDI 轨道分配小人物，支持闭嘴图 / 张嘴图替换
- **实时预览**：浏览器内 Canvas 实时渲染 + Web Audio 合成预览音频
- **歌词浮动**：根据 MIDI 事件生成「喵」字歌词，带浮动 + 淡出动画
- **原生 GPU 渲染**：Swift（Metal + AVFoundation）原生渲染器高速导出 4K ProRes MOV
- **兼容回退**：未构建原生渲染器时，自动走 `@napi-rs/canvas` + `ffmpeg` 路径
- **透明导出**：支持导出带 Alpha 通道的透明视频（ProRes 4444）
- **状态持久化**：MIDI、图片、配置通过 IndexedDB / localStorage 自动保存与恢复
- **拖拽排布**：在画布上直接拖动人物调整位置，或一键自动排布

## 目录结构

```
.
├── index.html              # 前端页面
├── app.js                  # 前端逻辑（MIDI 解析、预览、Canvas 绘制、状态管理）
├── server.js               # Node 服务端（静态资源 + MOV 导出 API）
├── styles.css              # 页面样式
├── fonts.css               # 字体声明
├── fonts/
│   └── zcool-kuaile-miao.woff2   # 站酷快乐体（默认歌词字体）
├── Package.swift           # Swift 包定义（NativeRenderer）
├── Sources/NativeRenderer/main.swift   # 原生 GPU 渲染器
└── exports/                # 导出的 MOV 输出目录（运行时创建）
```

## 环境依赖

- **Node.js** ≥ 18（运行服务端）
- **ffmpeg**：需在系统 PATH 中可用，或通过 `FFMPEG` 环境变量指定路径
- **（可选）macOS 14+ + Xcode / Swift 6 工具链**：用于构建原生 GPU 渲染器获得最高性能；其他平台自动走 ffmpeg 回退路径

> 工作机制：服务端启动时优先尝试调用原生渲染器（仅 macOS 可构建），不可用时自动回退到 `@napi-rs/canvas` + `ffmpeg`，因此 Linux / Windows 也能完整运行，只是导出速度较慢。

## 快速开始

1. 安装依赖：

   ```bash
   npm install
   ```

2. （仅 macOS，可选）构建原生渲染器以获得最高性能：

   ```bash
   swift build -c release
   # 产物位于 .build/release/NativeRenderer
   ```

3. 启动服务：

   ```bash
   npm start
   # 默认监听 http://localhost:8787
   ```

4. 浏览器打开 `http://localhost:8787`，选择 MIDI 文件即可开始配置与导出。

> 提示：直接以 `file://` 打开 `index.html` 仅可预览，无法导出 MOV，必须通过本地服务访问。

## 配置说明

| 选项 | 说明 |
| --- | --- |
| MIDI 文件 | 输入 `.mid` / `.midi`，自动解析轨道、音符、歌词 |
| 视频宽 / 高 | 支持 320×240 到 3840×2160 |
| 帧率 | 12–60 fps |
| 音量 | 预览音频音量（不影响导出） |
| 背景图片 | 覆盖铺满画布；勾选「透明导出」时忽略 |
| 默认闭嘴图 / 张嘴图 | 全局默认图片，轨道未单独设置时继承 |
| 歌词颜色 / 字体 / 高度 | 歌词文本样式与垂直偏移 |
| 轨道人物 | 每轨可单独替换图片、调整 X/Y、缩放、Tilt 上限 |

## 导出流程

1. 浏览器点击「导出 MOV」
2. 前端将完整项目（含图片 data URL、配置、音符、歌词）POST 到 `/render-mov`
3. 服务端调用 `NativeRenderer`（或回退到 ffmpeg）逐帧渲染并合成 ProRes MOV
4. 进度通过 `/render-progress?id=...` 轮询，完成后文件落在 `exports/` 目录
5. 页面提供下载链接；4K ProRes 文件较大，已直接存盘无需重复下载

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 服务监听端口 |
| `FFMPEG` | `ffmpeg` | ffmpeg 可执行路径（PATH 查找或绝对路径） |
