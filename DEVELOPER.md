# 开发者指南

本文面向想要**扩展、调试或部署**本 demo 的开发者。

---

## 环境要求

| 工具 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 18.x | 使用 `node --version` 确认 |
| npm | 8.x | 随 Node.js 一起安装 |
| TypeScript | 6.x | 项目 devDependency，无需全局安装 |

---

## 项目结构

```
hello-ts/
├── src/
│   ├── daemon.ts      # 守护进程主体
│   │   ├── § 0  配置与路径常量
│   │   ├── § 1  log()          日志函数
│   │   ├── § 2  writePidFile() / removePidFile() / isAlreadyRunning()
│   │   ├── § 3  DaemonState 接口 + state 对象
│   │   ├── § 4  startTaskScheduler() / stopTaskScheduler()
│   │   ├── § 5  startIpcServer() / stopIpcServer() / handleIpcCommand()
│   │   ├── § 6  reloadConfig()
│   │   ├── § 7  setupSignalHandlers()
│   │   ├── § 附  startHeartbeat()
│   │   └── main()
│   ├── client.ts      # IPC 客户端（工具，非业务代码）
│   └── index.ts       # 项目入口说明
├── docs/
│   ├── CONCEPTS.md    # 概念深度讲解
│   ├── IPC.md         # IPC 协议参考
│   └── SIGNALS.md     # 信号速查表
├── DEVELOPER.md       # 本文件
├── README.md          # 用户快速入门
├── tsconfig.json
└── package.json
```

---

## 开发工作流

### 启动开发环境

```bash
# 终端 A
npm run daemon        # 启动守护进程，代码改动需手动重启

# 终端 B
npm run client status # 测试 IPC 通信
```

### 修改代码后重启

```bash
# 在终端 B 发送停止命令
npm run client stop

# 在终端 A 重新运行
npm run daemon
```

> **提示**：可以改用 `nodemon` 实现文件变化自动重启：
> ```bash
> npx nodemon --exec "tsx src/daemon.ts" --ext ts
> ```

### 类型检查

```bash
npx tsc --noEmit      # 只检查类型，不输出文件
```

### 编译生产包

```bash
npm run build         # 输出到 dist/
npm run start         # 运行编译后的版本
```

---

## 常见扩展任务

### 1. 添加新 IPC 命令

只需在 `daemon.ts` 的 `handleIpcCommand` 中添加 `case`：

```typescript
case "pause":
  state.isPaused = true;
  log("INFO", "守护进程已暂停任务执行");
  return { ok: true };

case "resume":
  state.isPaused = false;
  log("INFO", "守护进程已恢复任务执行");
  return { ok: true };
```

同时在 `DaemonState` 中添加 `isPaused: boolean` 字段，在 `runTask` 中判断：

```typescript
async function runTask(): Promise<void> {
  if (state.isShuttingDown || state.isPaused) return;
  // ...
}
```

### 2. 添加新定时任务

在 `startTaskScheduler` 的 `runTask` 函数内添加业务逻辑：

```typescript
async function runTask(): Promise<void> {
  if (state.isShuttingDown) return;

  state.taskCount++;
  
  // 任务 A：清理过期文件
  await cleanExpiredFiles();
  
  // 任务 B：同步远程数据（每 10 次执行一次）
  if (state.taskCount % 10 === 0) {
    await syncRemoteData();
  }

  taskTimer = setTimeout(runTask, state.config.taskIntervalMs);
}
```

如果不同任务有不同频率，用**多个独立调度器**：

```typescript
function startCleanupScheduler(): void { /* 每 5 分钟 */ }
function startSyncScheduler(): void    { /* 每 30 秒 */ }
```

### 3. 从配置文件读取真实配置

将 `reloadConfig` 改为读取磁盘文件：

```typescript
import * as path from "path";

const CONFIG_FILE = path.resolve("config.json");

function reloadConfig(): void {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;

    // 校验（推荐用 zod）
    if (typeof parsed.taskIntervalMs === "number" && parsed.taskIntervalMs > 0) {
      state.config.taskIntervalMs = parsed.taskIntervalMs;
    }

    log("INFO", `配置已从 ${CONFIG_FILE} 重载`);
  } catch (err) {
    log("ERROR", `配置重载失败: ${String(err)}，保持旧配置`);
  }
}
```

### 4. 替换日志系统

当前实现是极简的 `appendFileSync`。生产环境推荐 `winston` 或 `pino`：

```bash
npm install winston
```

```typescript
import winston from "winston";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: LOG_FILE }),
    new winston.transports.Console(),
  ],
});

// 替换所有 log() 调用
function log(level: LogLevel, message: string): void {
  logger[level.toLowerCase()](message);
}
```

### 5. 添加配置文件监视（自动热重载）

无需手动发信号，文件保存后自动重载：

```typescript
import * as fs from "fs";

fs.watch(CONFIG_FILE, (eventType) => {
  if (eventType === "change") {
    log("INFO", "检测到配置文件变化，自动重载...");
    reloadConfig();
  }
});
```

> **注意**：`fs.watch` 在某些系统上可能触发两次事件，需加防抖（debounce）。

---

## 调试技巧

### 查看实时日志

```bash
# Unix
tail -f /tmp/demo-daemon.log

# Windows PowerShell（实时轮询）
Get-Content "$env:TEMP\demo-daemon.log" -Wait
```

### 检查进程状态

```bash
# Unix
ps aux | grep daemon
cat /tmp/demo-daemon.pid

# Windows
Get-Process -Name "node"
Get-Content "$env:TEMP\demo-daemon.pid"
```

### 用 Node.js 调试器附加到守护进程

```bash
# 启动守护进程时开启调试端口
node --inspect=9229 -r tsx/cjs src/daemon.ts

# 在 Chrome 打开 chrome://inspect，点击"Open dedicated DevTools for Node"
```

### 模拟异常测试 `uncaughtException` 处理

在 `runTask` 中临时加入：

```typescript
if (state.taskCount === 3) {
  throw new Error("模拟第 3 次任务崩溃");
}
```

观察守护进程是否正确记录错误日志并执行优雅关闭。

---

## 生产部署

### 方案 A：PM2（最简单）

```bash
npm install -g pm2

# 启动并设置开机自启
pm2 start dist/daemon.js --name demo-daemon
pm2 startup     # 生成开机自启命令
pm2 save        # 保存当前进程列表

# 常用命令
pm2 status
pm2 logs demo-daemon
pm2 restart demo-daemon
pm2 stop demo-daemon
```

PM2 会在进程崩溃后自动重启，并提供内置日志轮转和监控 UI。

### 方案 B：systemd（Linux 生产标准）

创建 `/etc/systemd/system/demo-daemon.service`：

```ini
[Unit]
Description=Demo Node.js Daemon
After=network.target

[Service]
Type=simple
User=nodeuser
WorkingDirectory=/opt/demo-daemon
ExecStart=/usr/bin/node dist/daemon.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# 让 systemd 有足够时间等待优雅关闭
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable demo-daemon
systemctl start demo-daemon

# 查看日志
journalctl -u demo-daemon -f
```

### 方案 C：Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/

# 使用 dumb-init 正确传递信号（防止 PID 1 信号问题）
RUN apk add --no-cache dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/daemon.js"]
```

```bash
docker build -t demo-daemon .
docker run -d --name demo-daemon demo-daemon

# 优雅停止（发送 SIGTERM）
docker stop demo-daemon
```

> **为什么用 dumb-init**：Docker 容器中 PID 1 进程对信号的处理有特殊规则，直接运行 `node` 作为 PID 1 可能导致 SIGTERM 被忽略。`dumb-init` 作为 PID 1，正确将信号转发给 Node.js 进程。

---

## 代码规范

### TypeScript 规范

- 所有函数参数和返回值必须有类型注解（`strict: true` 强制）
- 使用 `interface` 定义数据形状，`type` 定义联合类型
- 异步函数统一用 `async/await`，不混用 callback
- 错误处理：内部错误用 `log("ERROR", ...)` 记录，边界错误用 `try/catch`

### 日志规范

| 级别 | 使用场景 |
|------|---------|
| `INFO` | 正常的状态变化、任务执行、配置变更 |
| `WARN` | 可以继续运行但需要关注的情况（残留文件、重复信号）|
| `ERROR` | 错误但尝试恢复（任务失败）或即将退出的情况 |

### 提交规范

```
feat: 添加新 IPC 命令 metrics
fix: 修复 Windows 下 PID 文件路径问题
docs: 更新 IPC 协议文档
refactor: 提取 ConfigLoader 类
```
