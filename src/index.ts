/**
 * index.ts — 快速入门说明
 *
 * 本项目演示 Node.js 守护进程的 8 大核心功能，分两个文件：
 *
 *   src/daemon.ts  — 守护进程主体（后台长期运行的服务）
 *   src/client.ts  — IPC 客户端（向守护进程发送控制命令）
 *
 * ── 启动方式 ──────────────────────────────────────────
 *
 *  终端 A（启动守护进程）：
 *    npm run daemon
 *
 *  终端 B（发送 IPC 命令）：
 *    npm run client status   ← 查询运行状态
 *    npm run client reload   ← 热重载配置（无需重启）
 *    npm run client stop     ← 优雅关闭守护进程
 *
 *  Unix 系统也可直接发送 OS 信号：
 *    kill -TERM <pid>        ← 优雅关闭（同 SIGTERM）
 *    kill -HUP  <pid>        ← 热重载配置（同 SIGHUP）
 *    kill -USR1 <pid>        ← 打印状态快照
 *
 * ── 日志 & PID 文件 ───────────────────────────────────
 *  日志文件: %TEMP%/demo-daemon.log  （Windows）
 *            /tmp/demo-daemon.log    （Unix）
 *  PID 文件: %TEMP%/demo-daemon.pid
 */

console.log("请查看 README 注释或直接运行 `npm run daemon` 启动守护进程。");
