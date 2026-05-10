/**
 * daemon.ts — Node.js 守护进程完整功能演示
 *
 * 守护进程 (Daemon) 是在后台持续运行、不依附于终端的长期服务进程。
 * 本文件演示守护进程的 8 大核心功能：
 *   1. 日志系统        — 写文件，不依赖终端
 *   2. PID 文件管理    — 防止重复启动
 *   3. 状态管理        — 统一的内部状态
 *   4. 定时任务调度器  — 周期性后台工作
 *   5. IPC 服务器      — 进程间通信（socket/命名管道）
 *   6. 配置热重载      — 不重启进程更新配置
 *   7. 信号处理        — 响应 OS 信号
 *   8. 优雅关闭        — 有序释放资源再退出
 */

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 0. 配置与路径常量
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TMP = os.tmpdir();
const PID_FILE = path.join(TMP, "demo-daemon.pid");
const LOG_FILE = path.join(TMP, "demo-daemon.log");

// Windows 使用命名管道，Unix 使用 socket 文件
// Windows 命名管道路径格式固定为 \\.\pipe\<name>
const SOCKET_PATH =
  os.platform() === "win32"
    ? "\\\\.\\pipe\\demo-daemon"
    : path.join(TMP, "demo-daemon.sock");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 1. 日志系统
//
// 守护进程与终端分离后，stdout 无人查看。
// 必须将日志写入文件，并附带时间戳和级别。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type LogLevel = "INFO" | "WARN" | "ERROR";

function log(level: LogLevel, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}\n`;

  // appendFileSync：同步追加，确保多行日志顺序正确
  fs.appendFileSync(LOG_FILE, line, "utf8");

  // 开发阶段保留 console，生产守护进程中可以移除
  process.stdout.write(line);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 2. PID 文件管理
//
// PID 文件的作用：
//   a) 防止同一守护进程重复启动（启动时检查）
//   b) 让运维脚本知道进程 ID，以便发送信号
//   c) 监控系统可读取 PID 文件来追踪进程
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function writePidFile(): void {
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  log("INFO", `PID 文件已写入: ${PID_FILE}  (PID=${process.pid})`);
}

function removePidFile(): void {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
    log("INFO", "PID 文件已清除");
  }
}

function isAlreadyRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;

  const savedPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  try {
    // process.kill(pid, 0) 不发送信号，只探测进程是否存在
    // 若进程不存在会抛出 ESRCH 错误
    process.kill(savedPid, 0);
    log("WARN", `检测到已有进程在运行 (PID=${savedPid})`);
    return true;
  } catch {
    // 进程已死，PID 文件是残留，可以忽略
    log("INFO", "发现旧 PID 文件（进程已不存在），继续启动");
    return false;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 3. 守护进程状态
//
// 将所有可变状态集中到一个对象，方便：
//   - IPC 查询（status 命令直接序列化此对象）
//   - 优雅关闭时判断是否已在关闭中
//   - 调试时一目了然
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface Config {
  taskIntervalMs: number; // 定时任务执行间隔（毫秒）
}

interface DaemonState {
  startTime: Date;
  taskCount: number;       // 已成功执行的任务次数
  isShuttingDown: boolean; // 关闭保护标志，防止重复关闭
  config: Config;
}

const state: DaemonState = {
  startTime: new Date(),
  taskCount: 0,
  isShuttingDown: false,
  config: { taskIntervalMs: 2000 },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 4. 定时任务调度器
//
// 守护进程的核心价值：在后台持续执行周期性工作。
// 典型场景：清理过期缓存、同步远程数据、发送心跳包。
//
// 使用 setTimeout 递归调度而非 setInterval 的原因：
//   setInterval 是固定间隔，若任务本身耗时，会出现重叠；
//   setTimeout 递归调度是"上次完成后再等 N 毫秒"，更安全。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let taskTimer: ReturnType<typeof setTimeout> | null = null;

function startTaskScheduler(): void {
  async function runTask(): Promise<void> {
    if (state.isShuttingDown) return; // 关闭中不再产生新任务

    state.taskCount++;
    log("INFO", `[任务调度器] 执行任务 #${state.taskCount}`);

    // 在这里放实际的后台工作，例如：
    // await syncRemoteData();
    // await cleanExpiredCache();

    // 任务完成后，延迟再调度下一次（间隔可动态调整）
    taskTimer = setTimeout(runTask, state.config.taskIntervalMs);
  }

  // 首次延迟后触发
  taskTimer = setTimeout(runTask, state.config.taskIntervalMs);
  log("INFO", `任务调度器已启动，间隔: ${state.config.taskIntervalMs}ms`);
}

function stopTaskScheduler(): void {
  if (taskTimer !== null) {
    clearTimeout(taskTimer);
    taskTimer = null;
    log("INFO", "任务调度器已停止");
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 5. IPC 服务器（进程间通信）
//
// 守护进程在后台运行，外部需要一个"控制通道"来：
//   - 查询状态（status）
//   - 触发配置热重载（reload）
//   - 请求优雅关闭（stop）
//
// 实现方式：通过 Unix socket（或 Windows 命名管道）
// 接收 JSON 格式的命令，返回 JSON 格式的结果。
//
// 命令格式：{"cmd":"status"} + 换行符
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let ipcServer: net.Server | null = null;

// IPC 命令路由表：cmd 字符串 → 处理函数
function handleIpcCommand(cmd: string): object {
  switch (cmd) {
    case "status": {
      const uptimeSec = Math.floor(
        (Date.now() - state.startTime.getTime()) / 1000
      );
      return {
        pid: process.pid,
        uptimeSec,
        taskCount: state.taskCount,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        config: state.config,
        isShuttingDown: state.isShuttingDown,
      };
    }

    case "reload":
      // 触发配置热重载（§ 6）
      reloadConfig();
      return { ok: true, message: "配置已重载" };

    case "stop":
      // 异步触发优雅关闭，先把响应发回客户端
      setImmediate(() => gracefulShutdown("IPC stop 命令"));
      return { ok: true, message: "守护进程正在优雅关闭..." };

    default:
      return { error: `未知命令: ${cmd}，支持: status | reload | stop` };
  }
}

function startIpcServer(): void {
  // Unix：删除残留 socket 文件，否则 listen 会报 EADDRINUSE
  if (os.platform() !== "win32" && fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  ipcServer = net.createServer((socket) => {
    log("INFO", "[IPC] 客户端已连接");

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      // 按换行符分割，支持一次发送多条命令
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 最后一段可能是未完成的片段

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const req = JSON.parse(trimmed) as { cmd: string };
          const resp = handleIpcCommand(req.cmd);
          socket.write(JSON.stringify(resp) + "\n");
        } catch {
          socket.write(JSON.stringify({ error: "无效 JSON" }) + "\n");
        }
        socket.end();
      }
    });

    socket.on("error", (err) =>
      log("WARN", `[IPC] socket 错误: ${err.message}`)
    );
  });

  ipcServer.listen(SOCKET_PATH, () => {
    log("INFO", `[IPC] 服务器监听: ${SOCKET_PATH}`);
  });

  ipcServer.on("error", (err) =>
    log("ERROR", `[IPC] 服务器错误: ${err.message}`)
  );
}

function stopIpcServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!ipcServer) {
      resolve();
      return;
    }
    ipcServer.close(() => {
      // Unix：清理 socket 文件
      if (os.platform() !== "win32" && fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }
      log("INFO", "[IPC] 服务器已关闭");
      resolve();
    });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 6. 配置热重载
//
// 守护进程的优势：无需重启即可更新配置。
// 触发方式：
//   - 收到 SIGHUP 信号（Unix 传统方式，如 nginx -s reload）
//   - 通过 IPC 发送 reload 命令
//
// 实际项目中：从磁盘重新读取 JSON/YAML 配置文件，
// 更新 state.config，让调度器下次循环时用新配置。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function reloadConfig(): void {
  // 示例：模拟从配置文件读取新间隔（实际替换为 fs.readFileSync + JSON.parse）
  const newIntervalMs = Math.floor(Math.random() * 3000) + 1000; // 1~4 秒随机
  const oldIntervalMs = state.config.taskIntervalMs;

  state.config.taskIntervalMs = newIntervalMs;
  log(
    "INFO",
    `[热重载] 任务间隔: ${oldIntervalMs}ms → ${newIntervalMs}ms（下次任务后生效）`
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 7. 信号处理
//
// 操作系统通过信号（signal）与进程通信：
//
//   SIGTERM — 礼貌地请求进程退出（systemd stop、kill <pid>）
//             守护进程应执行优雅关闭
//
//   SIGINT  — Ctrl+C（通常用于开发调试）
//             与 SIGTERM 处理相同
//
//   SIGHUP  — 传统意义："终端挂起"
//             现代用途：请求守护进程重载配置（nginx、sshd 等都这样做）
//             注意：Windows 不支持 SIGHUP
//
//   SIGUSR1/2 — 用户自定义信号，可用于触发诊断信息输出
//             注意：Windows 不支持
//
//   uncaughtException — Node.js 特有，未被 try/catch 的异常
//             守护进程必须捕获，否则会意外崩溃
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function setupSignalHandlers(): void {
  // 跨平台：SIGTERM 和 SIGINT 在 Windows 也支持
  process.on("SIGTERM", () => {
    log("INFO", "收到 SIGTERM，开始优雅关闭...");
    gracefulShutdown("SIGTERM");
  });

  process.on("SIGINT", () => {
    log("INFO", "收到 SIGINT（Ctrl+C），开始优雅关闭...");
    gracefulShutdown("SIGINT");
  });

  // 仅 Unix 平台注册以下信号
  if (os.platform() !== "win32") {
    process.on("SIGHUP", () => {
      log("INFO", "收到 SIGHUP，触发配置热重载...");
      reloadConfig();
    });

    // SIGUSR1：自定义诊断信号，发送 kill -USR1 <pid> 触发
    process.on("SIGUSR1", () => {
      log("INFO", "收到 SIGUSR1，输出当前状态快照...");
      const snap = handleIpcCommand("status");
      log("INFO", `状态快照: ${JSON.stringify(snap)}`);
    });
  }

  // 全局异常兜底：守护进程绝对不能因为未捕获异常而静默崩溃
  process.on("uncaughtException", (err) => {
    log("ERROR", `未捕获异常: ${err.message}\n${err.stack ?? ""}`);
    // 选择策略：
    //   方案 A：继续运行（适合轻微错误）
    //   方案 B：退出让外部监控器（systemd/PM2）重启（适合严重错误）
    gracefulShutdown("uncaughtException"); // 这里选方案 B
  });

  process.on("unhandledRejection", (reason) => {
    log("ERROR", `未处理的 Promise rejection: ${String(reason)}`);
    // 根据业务决定是否要关闭进程
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 8. 优雅关闭（Graceful Shutdown）
//
// 关闭顺序至关重要，错误的顺序会导致：
//   - 请求在处理一半时被截断
//   - 临时文件/锁文件残留
//   - 数据库连接未正常释放
//
// 推荐关闭顺序：
//   1. 标记"关闭中"，拒绝新请求
//   2. 关闭对外服务（IPC 服务器）
//   3. 等待进行中的任务完成（或超时强制退出）
//   4. 停止调度器
//   5. 释放资源（数据库连接、文件句柄等）
//   6. 清理 PID 文件
//   7. 刷新最后一条日志
//   8. process.exit(0)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function gracefulShutdown(reason: string): Promise<void> {
  // 防止多个信号触发多次关闭流程
  if (state.isShuttingDown) {
    log("WARN", `收到重复关闭信号，忽略（原因: ${reason}）`);
    return;
  }
  state.isShuttingDown = true;

  log("INFO", `━━ 开始优雅关闭（原因: ${reason}）━━`);

  // 步骤 1: 关闭 IPC 服务器，不再接受新连接
  await stopIpcServer();

  // 步骤 2: 停止任务调度器
  stopTaskScheduler();

  // 步骤 3: 在这里关闭数据库连接、清空缓冲区等
  // await db.close();
  // await flushLogs();

  // 步骤 4: 清理 PID 文件
  removePidFile();

  // 步骤 5: 写入最终日志（给文件 I/O 一点时间）
  log(
    "INFO",
    `守护进程已停止 | 运行时长: ${Math.floor(
      (Date.now() - state.startTime.getTime()) / 1000
    )}s | 共执行任务: ${state.taskCount} 次`
  );
  await new Promise((r) => setTimeout(r, 50));

  process.exit(0);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// § 附加. 心跳监控
//
// 定期向日志输出健康信息，供外部监控系统检测进程是否存活。
// 生产中也可以改为：
//   - HTTP GET /health 返回 200
//   - 更新一个"心跳时间戳文件"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startHeartbeat(): void {
  setInterval(() => {
    if (state.isShuttingDown) return;

    const uptimeSec = Math.floor(
      (Date.now() - state.startTime.getTime()) / 1000
    );
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

    log(
      "INFO",
      `[心跳] 运行 ${uptimeSec}s | 内存 ${memMB}MB | 任务 ${state.taskCount} 次`
    );
  }, 10_000); // 每 10 秒一次心跳
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 主入口
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main(): Promise<void> {
  log("INFO", "═══════════════════════════════════");
  log("INFO", "       守护进程 Demo 启动中         ");
  log("INFO", "═══════════════════════════════════");

  // 防止重复启动
  if (isAlreadyRunning()) {
    log("ERROR", "守护进程已在运行，拒绝重复启动");
    process.exit(1);
  }

  writePidFile();          // § 2: 写入 PID 文件
  setupSignalHandlers();   // § 7: 注册信号处理器
  startIpcServer();        // § 5: 启动 IPC 服务器
  startTaskScheduler();    // § 4: 启动定时任务
  startHeartbeat();        // 附: 启动心跳

  log("INFO", `PID     : ${process.pid}`);
  log("INFO", `PID文件 : ${PID_FILE}`);
  log("INFO", `日志文件: ${LOG_FILE}`);
  log("INFO", `IPC路径 : ${SOCKET_PATH}`);
  log("INFO", "发送 Ctrl+C 或 SIGTERM 可优雅关闭");
  log("INFO", "运行 client.ts 可通过 IPC 与本进程通信");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log("ERROR", `启动失败: ${msg}`);
  process.exit(1);
});
