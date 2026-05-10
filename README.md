# Node.js 守护进程完整演示

用最小代码量演示守护进程（Daemon）的 **8 大核心功能**，适合从零学习后台服务进程。

---

## 快速开始

```bash
# 安装依赖
npm install

# 终端 A：启动守护进程
npm run daemon

# 终端 B：发送控制命令
npm run client status   # 查询状态
npm run client reload   # 热重载配置
npm run client stop     # 优雅关闭
```

启动后控制台会实时输出带时间戳的日志，同时日志也写入文件（见下方"运行时文件"）。

---

## 功能一览

| # | 功能 | 关键 API | 源码位置 |
|---|------|---------|---------|
| 1 | **日志系统** | `fs.appendFileSync` | `daemon.ts § 1` |
| 2 | **PID 文件** | `process.kill(pid, 0)` | `daemon.ts § 2` |
| 3 | **状态管理** | `DaemonState` 接口 | `daemon.ts § 3` |
| 4 | **定时任务** | `setTimeout` 递归调度 | `daemon.ts § 4` |
| 5 | **IPC 通信** | `net.createServer` | `daemon.ts § 5` |
| 6 | **配置热重载** | `SIGHUP` / IPC reload | `daemon.ts § 6` |
| 7 | **信号处理** | `process.on('SIGTERM')` | `daemon.ts § 7` |
| 8 | **优雅关闭** | 有序清理 + `process.exit` | `daemon.ts § 8` |
| + | **心跳监控** | `setInterval` | `daemon.ts § 附` |

---

## 文件结构

```
hello-ts/
├── src/
│   ├── daemon.ts      # 守护进程主体（8 大功能，全注释）
│   ├── client.ts      # IPC 客户端示例
│   └── index.ts       # 入口说明
├── docs/
│   ├── CONCEPTS.md    # 守护进程核心概念深度讲解
│   ├── IPC.md         # IPC 协议参考文档
│   └── SIGNALS.md     # 信号处理速查表
├── DEVELOPER.md       # 开发者指南（扩展 / 调试 / 部署）
├── tsconfig.json
└── package.json
```

---

## npm Scripts

| 命令 | 说明 |
|------|------|
| `npm run daemon` | 启动守护进程（开发模式，tsx 直接运行） |
| `npm run client [cmd]` | 向守护进程发送 IPC 命令，默认 `status` |
| `npm run build` | 编译为 JavaScript（输出到 `dist/`） |
| `npm run start` | 运行编译后的守护进程 |

---

## IPC 命令速查

```bash
npm run client status   # 返回 PID、运行时长、内存、任务计数
npm run client reload   # 热重载配置，无需重启
npm run client stop     # 优雅关闭，有序释放资源
```

Unix 系统也可直接发送 OS 信号（见 [docs/SIGNALS.md](docs/SIGNALS.md)）：

```bash
PID=$(cat /tmp/demo-daemon.pid)
kill -TERM  $PID   # 优雅关闭
kill -HUP   $PID   # 热重载配置
kill -USR1  $PID   # 打印状态快照到日志
```

---

## 运行时文件

守护进程运行时会在系统临时目录生成以下文件：

| 文件 | 路径（Windows） | 路径（Unix） | 说明 |
|------|----------------|-------------|------|
| PID 文件 | `%TEMP%\demo-daemon.pid` | `/tmp/demo-daemon.pid` | 记录进程 ID |
| 日志文件 | `%TEMP%\demo-daemon.log` | `/tmp/demo-daemon.log` | 追加写入的日志 |
| IPC 通道 | `\\.\pipe\demo-daemon` | `/tmp/demo-daemon.sock` | 命名管道/socket |

查看实时日志（Unix）：
```bash
tail -f /tmp/demo-daemon.log
```

---

## 延伸阅读

- [守护进程核心概念](docs/CONCEPTS.md) — 8 大功能的原理和设计思路
- [IPC 协议参考](docs/IPC.md) — 命令格式、扩展方法
- [信号处理速查](docs/SIGNALS.md) — 各平台信号对比
- [开发者指南](DEVELOPER.md) — 如何扩展、调试和部署
