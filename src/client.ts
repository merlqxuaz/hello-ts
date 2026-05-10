/**
 * client.ts — IPC 客户端
 *
 * 演示如何通过 socket/命名管道向正在运行的守护进程发送命令。
 *
 * 用法（先在另一个终端启动 daemon）：
 *   npm run client status   — 查询状态
 *   npm run client reload   — 热重载配置
 *   npm run client stop     — 优雅关闭守护进程
 */

import * as net from "net";
import * as os from "os";
import * as path from "path";

const SOCKET_PATH =
  os.platform() === "win32"
    ? "\\\\.\\pipe\\demo-daemon"
    : path.join(os.tmpdir(), "demo-daemon.sock");

// 向守护进程发送一条 JSON 命令，等待并返回响应
function sendCommand(cmd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH, () => {
      // 连接成功后立即发送命令，末尾加换行符作为帧分隔符
      socket.write(JSON.stringify({ cmd }) + "\n");
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
    });

    socket.on("end", () => {
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch {
        reject(new Error(`响应解析失败: ${buffer}`));
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`连接失败: ${err.message}`));
    });

    // 5 秒超时，防止守护进程无响应时永久阻塞
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("连接超时"));
    });
  });
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status"; // 默认发送 status 命令

  console.log(`\n► 发送命令: ${cmd}  →  ${SOCKET_PATH}\n`);

  try {
    const response = await sendCommand(cmd);
    console.log("◄ 响应:");
    console.log(JSON.stringify(response, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ ${msg}`);
    console.error("  请先在另一个终端运行: npm run daemon");
    process.exit(1);
  }
}

main();
