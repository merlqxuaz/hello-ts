# 守护进程核心概念

本文逐一深度讲解守护进程的 8 大核心功能，并与 C# Windows Service 做对比，帮助有 C# 背景的开发者快速建立心智模型。

---

## 什么是守护进程？

守护进程（Daemon）是在**后台持续运行**、**不依附于任何终端**的长期服务进程。

| 对比维度 | C# Windows Service | Node.js Daemon |
|---------|-------------------|----------------|
| 注册方式 | SCM（服务控制管理器）| 无需注册，自行管理 |
| 生命周期控制 | `OnStart` / `OnStop` | 信号 + IPC |
| 配置热重载 | 通常需重启 | SIGHUP / IPC reload |
| 日志 | EventLog / NLog | 文件 + stdout |
| 进程守护 | SCM 自动重启 | PM2 / systemd |

---

## § 1 — 日志系统

### 为什么不能用 `console.log`？

守护进程与终端断开后（真正的后台运行），`stdout` 无人查看。即使在开发阶段用 `console.log`，生产部署时也必须改为写文件。

### 设计要点

```
[2026-05-09T12:34:56.789Z] [INFO] 任务调度器已启动，间隔: 2000ms
│                        │  │   │ └── 日志内容
│                        │  └───┘ 级别：INFO / WARN / ERROR
└────────────────────────┘ ISO 8601 时间戳（UTC，便于跨时区对比）
```

**同步写入 vs 异步写入**

本 demo 用 `fs.appendFileSync`（同步）。原因：守护进程在优雅关闭阶段，异步回调可能来不及执行，同步写入确保最后一条日志一定落盘。

代价是同步 I/O 会短暂阻塞事件循环。高吞吐场景（每秒数千条日志）应改用写入流（`fs.createWriteStream`）+ 缓冲队列。

### C# 对比

```csharp
// C# NLog 等价写法
logger.Info("任务调度器已启动");
```

TypeScript 版本是手写的最小实现，生产中可替换为 `winston` 或 `pino`。

---

## § 2 — PID 文件管理

### 三大作用

```
PID 文件（demo-daemon.pid）
    │
    ├── 防止重复启动 ──── 启动时读取 PID，用 kill(pid,0) 探测进程是否存活
    ├── 运维脚本停止 ──── kill -TERM $(cat demo-daemon.pid)
    └── 监控系统追踪 ──── Nagios / Prometheus 读取 PID 文件来检测进程
```

### `process.kill(pid, 0)` 的妙用

```typescript
try {
  process.kill(savedPid, 0); // 信号 0：不发送实际信号，只检测进程是否存在
  // 执行到这里 = 进程存在
} catch {
  // ESRCH = 进程不存在，PID 文件是残留
}
```

这是一个跨平台的"进程存活探测"惯用法，Windows 和 Unix 都支持。

### 残留 PID 文件

进程被强制 kill（`kill -9`）时，来不及执行清理代码，PID 文件会残留。下次启动时必须区分"进程确实在运行"和"PID 文件是残留"，因此要用 `kill(pid, 0)` 二次确认。

---

## § 3 — 状态管理

### 为什么集中状态？

将所有可变状态放进一个 `DaemonState` 对象，带来三个好处：

1. **IPC 查询**：`status` 命令直接序列化整个 state，不需要到处收集字段。
2. **关闭保护**：`isShuttingDown` 标志防止收到多个信号时重复执行关闭流程。
3. **调试友好**：打印 `state` 即可看到进程全貌。

### 类型安全

```typescript
interface DaemonState {
  startTime: Date;
  taskCount: number;
  isShuttingDown: boolean;  // 一旦为 true，所有新操作都应跳过
  config: Config;
}
```

C# 中等价于一个 `private readonly DaemonState _state = new();` 单例。

---

## § 4 — 定时任务调度器

### `setTimeout` 递归 vs `setInterval`

```
setInterval（固定间隔，有重叠风险）：
  t=0  ── 任务开始
  t=2  ── 任务结束（耗时 2 秒）
  t=2  ── 下一次任务已触发！← 重叠！

setTimeout 递归（完成后再等待）：
  t=0  ── 任务开始
  t=2  ── 任务结束
  t=4  ── 下一次任务触发（等待 2 秒后）
```

当任务执行时间可能超过间隔时，`setInterval` 会导致并发执行同一任务。守护进程的后台任务通常有 I/O 操作，用 `setTimeout` 递归更安全。

### 动态间隔

使用 `setTimeout` 的额外好处：每次调度时重新读取 `state.config.taskIntervalMs`，热重载新间隔后下一次就生效，`setInterval` 做不到这点。

### C# 对比

```csharp
// C# System.Timers.Timer 等价
private Timer _timer;
protected override void OnStart(string[] args) {
    _timer = new Timer(2000);
    _timer.Elapsed += RunTask;
    _timer.Start();
}
```

---

## § 5 — IPC 通信

### 为什么不用 HTTP？

HTTP 需要开放网络端口，有安全风险，且有不必要的协议开销。IPC（进程间通信）通过操作系统内核路由，只有本机进程能访问，更快更安全。

### 传输层选择

| 平台 | 传输层 | 路径格式 |
|------|--------|---------|
| Unix / macOS | Unix Domain Socket | `/tmp/demo-daemon.sock` |
| Windows | 命名管道（Named Pipe）| `\\.\pipe\demo-daemon` |

Node.js `net` 模块对两者使用完全相同的 API，只需切换路径字符串。

### 协议设计：换行分隔的 JSON

```
请求：{"cmd":"status"}\n
响应：{"pid":1234,"uptimeSec":60,...}\n
```

选用换行分隔而非固定长度帧的原因：调试时可以直接用 `nc`（netcat）手动发送命令。

```bash
# Unix 调试（直接用 nc 发命令）
echo '{"cmd":"status"}' | nc -U /tmp/demo-daemon.sock
```

### 粘包处理

TCP / socket 不保证"一次 write = 一次 read"，大数据包可能被拆分。daemon.ts 用 `buffer += chunk` 累积，再按 `\n` 分割，正确处理了粘包：

```typescript
socket.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? ""; // 末尾可能是未完成的片段，留到下次
  for (const line of lines) { /* 处理完整帧 */ }
});
```

---

## § 6 — 配置热重载

### 核心思路

守护进程的最大优势之一：**运行时修改行为，无需重启**。

```
传统方式（需重启）：  修改配置文件 → 停止服务 → 启动服务 → 服务中断 10s
热重载方式（不停机）：修改配置文件 → 发送信号/IPC → 配置生效  → 无服务中断
```

### 触发方式对比

| 触发方式 | 命令 | 适用场景 |
|---------|------|---------|
| Unix 信号 | `kill -HUP $(cat daemon.pid)` | 运维人员手动触发 |
| IPC 命令 | `npm run client reload` | 脚本/CI 自动触发 |
| 文件监视 | `fs.watch('config.json', ...)` | 配置文件修改后自动触发 |

本 demo 演示前两种；文件监视可用 `fs.watch` 实现，留作扩展（见 [DEVELOPER.md](../DEVELOPER.md)）。

### 安全注意

热重载新配置前应先**校验**格式，否则一个错误的配置文件可能导致服务崩溃：

```typescript
function reloadConfig(): void {
  const raw = fs.readFileSync("config.json", "utf8");
  const parsed = JSON.parse(raw) as unknown;
  // TODO: 用 zod 或手动校验 parsed 的字段
  state.config = parsed as Config;
}
```

---

## § 7 — 信号处理

信号是操作系统向进程发送的"软件中断"。守护进程必须正确响应信号，才能被操作系统、容器编排工具（Kubernetes）、进程管理器（systemd）正确控制。

详细信号说明见 [docs/SIGNALS.md](SIGNALS.md)。

### 最重要的两条规则

1. **必须处理 `SIGTERM`**：Docker `docker stop`、Kubernetes Pod 终止、`systemctl stop` 都发送 SIGTERM。不处理 = 10 秒后被强制 `SIGKILL`，来不及做任何清理。

2. **必须捕获 `uncaughtException`**：未捕获的异常会让 Node.js 进程崩溃退出，守护进程的责任是记录错误后再决定是否退出，绝不能静默崩溃。

---

## § 8 — 优雅关闭

### 关闭顺序很关键

错误的顺序会导致数据丢失或资源泄漏：

```
❌ 错误顺序：先退出进程，再关闭数据库连接
   → 数据库连接未释放，连接池耗尽

✅ 正确顺序：
   1. 停止接收新请求（关闭 IPC 服务器）
   2. 等待进行中任务完成（或设超时强制退出）
   3. 关闭数据库/缓存连接
   4. 清理临时文件（PID 文件、socket 文件）
   5. 写入最后一条日志
   6. process.exit(0)
```

### 超时保护

生产环境必须加超时：如果某个任务卡死，优雅关闭也会卡死：

```typescript
// 30 秒内没完成关闭，强制退出
const forceExit = setTimeout(() => {
  log("ERROR", "优雅关闭超时，强制退出");
  process.exit(1);
}, 30_000);

// 确保 forceExit 不阻止事件循环退出
forceExit.unref();
```

### isShuttingDown 标志

这个标志是防止"重复关闭"的关键。用户可能同时按 Ctrl+C 并发送 SIGTERM，没有这个标志会触发两次关闭流程，导致重复删除文件、二次调用 `process.exit`。

---

## 进程生命周期全图

```
启动
  │
  ├─ 检查 PID 文件 ──── 已运行? → 退出(1)
  │
  ├─ 写入 PID 文件
  ├─ 注册信号处理器
  ├─ 启动 IPC 服务器
  ├─ 启动任务调度器
  └─ 启动心跳定时器
        │
        │  ← 正常运行阶段 →
        │
    ┌───┴──────────────────────────────────┐
    │  定时任务循环（每 N 毫秒）             │
    │  IPC 请求处理（随时响应）              │
    │  心跳输出（每 10 秒）                  │
    └───┬──────────────────────────────────┘
        │
        ├─ SIGTERM / SIGINT / IPC stop
        │
关闭
  ├─ 标记 isShuttingDown = true
  ├─ 关闭 IPC 服务器（停止接受新连接）
  ├─ 停止任务调度器
  ├─ 清理资源（DB、缓冲区...）
  ├─ 删除 PID 文件
  └─ process.exit(0)
```
