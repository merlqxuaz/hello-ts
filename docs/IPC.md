# IPC 协议参考

守护进程通过 **换行分隔的 JSON** 协议接收命令，并返回 JSON 响应。

---

## 传输层

| 平台 | 类型 | 路径 |
|------|------|------|
| Windows | 命名管道（Named Pipe）| `\\.\pipe\demo-daemon` |
| Linux / macOS | Unix Domain Socket | `/tmp/demo-daemon.sock` |

两种传输层使用完全相同的 Node.js `net` API，协议层无区别。

---

## 报文格式

### 请求

```
{"cmd":"<命令名>"}\n
```

每条请求以 `\n`（换行符）结尾作为帧边界，支持在单个连接内发送多条命令。

### 响应

```
{...响应对象...}\n
```

同样以 `\n` 结尾。守护进程发送响应后会关闭连接（`socket.end()`）。

---

## 命令参考

### `status` — 查询状态

**请求：**
```json
{"cmd":"status"}
```

**响应：**
```json
{
  "pid": 12345,
  "uptimeSec": 120,
  "taskCount": 60,
  "memoryMB": 45,
  "config": {
    "taskIntervalMs": 2000
  },
  "isShuttingDown": false
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `pid` | number | 守护进程的操作系统进程 ID |
| `uptimeSec` | number | 已运行秒数 |
| `taskCount` | number | 定时任务已执行次数 |
| `memoryMB` | number | 当前 RSS 内存占用（MB） |
| `config` | object | 当前生效的配置 |
| `isShuttingDown` | boolean | 是否正在执行关闭流程 |

---

### `reload` — 热重载配置

触发守护进程重新读取配置，无需重启进程。

**请求：**
```json
{"cmd":"reload"}
```

**响应：**
```json
{"ok": true, "message": "配置已重载"}
```

新配置在**下一次**定时任务调度时生效（不中断当前任务）。

---

### `stop` — 优雅关闭

请求守护进程按正确顺序释放资源后退出。

**请求：**
```json
{"cmd":"stop"}
```

**响应（关闭前发出）：**
```json
{"ok": true, "message": "守护进程正在优雅关闭..."}
```

收到响应后守护进程开始关闭流程，通常在 1 秒内完成退出。

---

### 错误响应

当命令名不存在或 JSON 解析失败时：

```json
{"error": "未知命令: foo，支持: status | reload | stop"}
```

```json
{"error": "无效 JSON"}
```

---

## 使用示例

### TypeScript 客户端（已内置）

```bash
npm run client status
npm run client reload
npm run client stop
```

### Node.js 手写客户端

```typescript
import * as net from "net";

const socket = net.createConnection("\\\\.\\pipe\\demo-daemon", () => {
  socket.write(JSON.stringify({ cmd: "status" }) + "\n");
});

socket.on("data", (data) => {
  console.log(JSON.parse(data.toString()));
  socket.end();
});
```

### Unix netcat 调试

```bash
echo '{"cmd":"status"}' | nc -U /tmp/demo-daemon.sock
```

### Python 客户端示例

```python
import socket, json

client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect("/tmp/demo-daemon.sock")
client.sendall(b'{"cmd":"status"}\n')
print(json.loads(client.recv(4096)))
client.close()
```

---

## 扩展：添加自定义命令

在 `daemon.ts` 的 `handleIpcCommand` 函数中添加新的 `case`：

```typescript
case "metrics":
  // 返回自定义指标
  return {
    errorCount: state.errorCount,
    lastTaskDuration: state.lastTaskDurationMs,
    queueDepth: taskQueue.length,
  };
```

同时在 `DaemonState` 接口中添加对应字段，就完成了新命令的注册。无需修改任何其他代码。

---

## 安全注意

命名管道 / Unix socket 文件默认只有**同一用户**可以访问，不对网络开放，无需认证。如果守护进程以 root 运行而客户端以普通用户运行，需要在创建 socket 后调整文件权限：

```typescript
// Unix 仅：创建 socket 后限制权限
ipcServer.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o660); // 仅 owner + group 可读写
});
```
