# 信号处理速查

操作系统通过**信号**（Signal）向进程发送通知。守护进程必须正确响应信号，才能被 systemd、Docker、Kubernetes 等工具正确管理。

---

## 信号速查表

| 信号 | 数值 | Windows | Unix | 默认行为 | 本 Demo 的处理 |
|------|------|---------|------|---------|--------------|
| `SIGTERM` | 15 | ✅ | ✅ | 终止进程 | 优雅关闭 |
| `SIGINT` | 2 | ✅ | ✅ | 终止进程 | 优雅关闭（同 SIGTERM）|
| `SIGHUP` | 1 | ❌ | ✅ | 终止进程 | 热重载配置 |
| `SIGUSR1` | 10 | ❌ | ✅ | 终止进程 | 打印状态快照到日志 |
| `SIGUSR2` | 12 | ❌ | ✅ | 终止进程 | （未注册，可自定义）|
| `SIGKILL` | 9 | ✅ | ✅ | **强制终止**（不可捕获）| 无法处理 |
| `SIGQUIT` | 3 | ❌ | ✅ | 终止+核心转储 | （未注册）|

---

## 发送信号的方式

### 通过 PID 文件（推荐）

```bash
# Unix — 读取 PID 文件再发信号
PID=$(cat /tmp/demo-daemon.pid)
kill -TERM  $PID   # 优雅关闭
kill -HUP   $PID   # 热重载配置
kill -USR1  $PID   # 打印状态
kill -9     $PID   # 强制终止（紧急情况）
```

```powershell
# Windows — 只有 SIGTERM 可用
$pid = Get-Content "$env:TEMP\demo-daemon.pid"
Stop-Process -Id $pid          # 发送 SIGTERM（等价）
Stop-Process -Id $pid -Force   # 强制终止
```

### 通过进程名

```bash
# Unix
pkill -TERM -f "node dist/daemon.js"
pkill -HUP  -f "tsx src/daemon.ts"
```

### 通过 npm 脚本（本 demo）

```bash
npm run client stop    # 通过 IPC 触发优雅关闭（跨平台）
```

---

## 各信号详解

### SIGTERM — 礼貌的终止请求

最常见的信号。systemd、Docker、Kubernetes 在停止服务时首先发送 SIGTERM，等待一段时间（默认 30 秒）后若进程未退出，再发送 SIGKILL。

```
docker stop → SIGTERM → 等 10 秒 → SIGKILL
kubectl delete pod → SIGTERM → 等 terminationGracePeriodSeconds → SIGKILL
systemctl stop → SIGTERM → 等 TimeoutStopSec → SIGKILL
```

**规则**：收到 SIGTERM 必须在超时时间内完成关闭，否则会被强制 kill。

### SIGINT — 用户中断

用户在终端按 `Ctrl+C` 产生的信号。开发调试时最常用。行为上与 SIGTERM 完全相同，守护进程统一执行优雅关闭。

### SIGHUP — 挂起/重载

原始含义：控制终端挂起（hang up）。现代守护进程（nginx、sshd、logrotate）约定将其重新定义为"**重载配置**"。

```bash
# nginx 的用法
nginx -s reload        # 内部等价于 kill -HUP $(cat nginx.pid)

# 本 demo
kill -HUP $(cat /tmp/demo-daemon.pid)
# 效果：reloadConfig() 被调用，无服务中断
```

Windows 不支持 SIGHUP，使用 IPC reload 命令替代。

### SIGUSR1 / SIGUSR2 — 用户自定义

无固定语义，完全由应用自定义。常见用途：

| 信号 | 常见约定 |
|------|---------|
| SIGUSR1 | 打印状态快照、开启调试模式 |
| SIGUSR2 | 触发 GC、切换日志级别、热重载代码 |

Node.js 自身使用 SIGUSR1 来启动调试器（`--inspect`），因此注册 SIGUSR1 时需注意与 Node.js 内部行为的冲突。

### SIGKILL — 不可捕获的强制终止

进程无法捕获或忽略 SIGKILL，内核直接终止进程。后果：

- PID 文件残留（下次启动时需用 `kill(pid,0)` 二次确认）
- Socket 文件残留（需启动时清理）
- 正在写入的日志可能不完整
- 数据库事务未提交

**永远不要在正常流程中使用 `kill -9`**，只在进程卡死时作为最后手段。

---

## Node.js 信号处理注意事项

### 1. 处理函数是同步的

```typescript
process.on("SIGTERM", () => {
  // ❌ 不能在这里用 await
  // gracefulShutdown(); 如果 gracefulShutdown 是 async，await 不生效
  
  // ✅ 正确：启动 async 流程
  gracefulShutdown("SIGTERM"); // 返回 Promise，但这里不 await
});
```

### 2. 防止重复处理

多个信号（如同时按两次 Ctrl+C）可能触发多次处理函数，用 `isShuttingDown` 标志防重：

```typescript
process.on("SIGINT", () => {
  if (state.isShuttingDown) return; // 已在关闭中，忽略
  gracefulShutdown("SIGINT");
});
```

### 3. Windows 的限制

Windows 通过不同机制实现进程控制，POSIX 信号支持有限：

- `SIGTERM`：通过 `TerminateProcess` Win32 API 模拟，Node.js 可捕获
- `SIGINT`：`Ctrl+C` 产生的 `CTRL_C_EVENT`，Node.js 可捕获  
- `SIGHUP`、`SIGUSR1/2`、`SIGQUIT` 等：Node.js on Windows **不支持**

跨平台解决方案：使用 IPC 命令代替不支持的信号。

---

## 与 C# Windows Service 对比

| 场景 | C# Windows Service | Unix Daemon |
|------|-------------------|------------|
| 启动 | `OnStart()` | 进程启动，`main()` |
| 停止请求 | `OnStop()` | `SIGTERM` 处理器 |
| 暂停 | `OnPause()` | `SIGSTOP`（通常不实现）|
| 配置重载 | 通常重启 | `SIGHUP` 处理器 |
| 自定义命令 | `OnCustomCommand(int cmd)` | `SIGUSR1/2` 或 IPC |
