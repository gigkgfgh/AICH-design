# aichD

AICH Design —— 桌面端 AI 建筑设计辅助工具的源码仓库。

仓库根仅存放仓库级配置文件；**项目源码位于 [`aichitect Design/`](<aichitect Design/README.md>) 子目录**（monorepo：app / agent-service / shared / extensions / skills / storage）。

## 项目文档

完整说明（技术栈、目录结构、快速开始、架构要点、测试概况）见：

**[`aichitect Design/README.md`](<aichitect Design/README.md>)**

## 快速开始

```bash
cd "aichitect Design"
npm install        # 装依赖；postinstall 按拓扑构建各包 dist
npm run dev        # 渲染层 vite(5173) + electron 壳，热更新
```

端点与密钥配置：启动后进入「设置 → LLM 端点 / 图像端点」填写，保存即生效；密钥经 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）加密存放，不落明文。

## 仓库结构

```
.
├── aichitect Design/   项目源码（monorepo，含完整 README 与各包文档）
├── .editorconfig       编辑器统一配置
├── .gitattributes      换行符与二进制文件策略
└── .gitignore          忽略规则（含密钥/环境/本地数据文件，绝不入库）
```

## 安全说明

- API 密钥只经系统级加密存储（`safeStorage`），仓库与提交历史中不存在任何真实密钥。
- `.env`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`secrets.json`、`*.db` 等敏感文件已被 `.gitignore` 排除，请勿 `git add -f` 强制入库。
- 本地会话数据（`.data/`）、密钥库（`userData/secrets.json`）均位于项目目录内且不入库。
