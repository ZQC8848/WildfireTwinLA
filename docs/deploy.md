# 上线到 Vercel

公开网站是纯前端的静态站，不需要后端：
- Norte 回放直接用打包进前端的数据，在浏览器里播放；
- 紧急联络调度在 Web Worker 里运行（`web/src/net/localDispatch.worker.ts`），逻辑与 `server/app/dispatch.py` 相同，住户都是合成数据；
- "Live feed" 按钮在没有后端时禁用，因为实时数据需要后端抓取 NASA FIRMS 等来源。

## 一次性设置（在 vercel.com 上操作）

1. 用 GitHub 账号登录 vercel.com。
2. Add New → Project，导入 `ZQC8848/WildfireTwinLA`。
3. **Root Directory 保持仓库根目录（`./`），不要设成 `web`。**
   - 前端会引用 `packages/core` 和 `server/data/norte-replay.jsonl`。
   - Vercel 文档说明，根目录设成子文件夹后，构建时不能访问该目录之外的文件。
4. Framework Preset 选 Other。安装命令、构建命令和输出目录已经写在仓库根目录的 `vercel.json` 里：
   - 安装：`npm --prefix web ci`
   - 构建：`npm --prefix web run build`，会先跑类型检查，有错误就不部署
   - 输出：`web/dist`
5. Settings → Build and Deployment → Node.js Version 选 22.x 或更新（Vite 8 需要较新的 Node）。
6. **不要设置 `VITE_API_URL`。** 不设置时网站完全不连后端。
7. Deploy，得到 `https://<项目名>.vercel.app`。

之后每次推送到 `main` 都会自动部署到正式地址，每个 PR 会生成一个预览地址。

## 缓存

`vercel.json` 里设置了两条缓存规则：
- `/assets/*`：带内容哈希的 JS、CSS、字体，永久缓存；
- `/data/*`、`/models/*`：文件名不带哈希，缓存 1 小时，过期后一天内可以先用旧副本、同时在后台更新。

更新数据后最多一小时内生效；如果要立刻生效，就重新部署并清除缓存。

首次打开约下载 35 MB 的数据和模型。最大的 `buildings.json` 有 18 MB，Vercel 会自动压缩 JSON。

## 以后需要后端时

- 把 `server/` 部署到支持长连接的平台，例如 Cloud Run。实例数固定为 1，因为调度器状态在内存里。
- 在 Vercel 设置 `VITE_API_URL=https://<后端地址>`，然后重新部署。
- 后端的 `WILDFIRE_CORS_ORIGINS` 里加上 Vercel 的正式域名和预览域名。
- 所有密钥（Retell、ElevenLabs、FIRMS）只放在后端。以 `VITE_` 开头的变量会被打包进前端，所有人都能看到。

## 本地验证正式版本

```bash
npm --prefix web run build
npx --prefix web vite preview --port 4173   # 不设置 VITE_API_URL：浏览器内模式
```

打开 http://localhost:4173，检查以下几点：
- "Live feed" 按钮是灰的；
- Norte 回放能播放；
- Respond 模式里紧急联络会自动开始；
- 网络面板里没有发往 8010 端口的请求。
