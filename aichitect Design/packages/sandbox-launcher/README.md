# @aichdesign/sandbox-launcher

P015 沙箱启动器：声明式策略（fail-closed）+ **降级最小权限启动包装** + 越权自测。

## P002-SP 真机结论（2026-08-24，Windows 11 10.0.26200，非提升 Shell，单轮探测）

探针 = node 自检脚本（写 `%APPDATA%` / 读 `%USERPROFILE%\Documents` / 写 `C:\Windows` / DNS loopback）：

| 原语 | 可用性 | 实测结果 |
|---|---|---|
| `runas /trustlevel:0x20000`（受限令牌） | ✅ 非提升可用 | 仅剥离管理员 SID：writeAppData=**ALLOWED**、readDocuments=ALLOWED(33)、writeWindows=DENIED —— **不能防用户文件越权读写**，仅「去管理员化」价值 |
| `icacls <exe> /setintegritylevel L`（低完整性） | ❌ 需管理员 | exit=5 拒绝访问（写 SACL 需 SeSecurityPrivilege；对普通 txt 同样被拒）→ 非提升启动流不可用 |
| AppContainer | ❌ 无原语 | shell/PowerShell 无对应原语；需 **native helper**（C++/Rust 或 Node native addon 调 `CreateAppContainerProfile` + `CreateProcess` 构建令牌） |

基线（当前 Shell）：Medium 完整性；`C:\Windows` 写 DENIED。

**结论**：真实 OS 级沙箱（AppContainer 或低完整性）在本产品常规非提升启动流中**当前不可行**；
本轮交付降级实现，native helper 列为后续轮（届时 `launcher.ts` 以原语模式替换包装，策略/自测契约不变）。

## 降级最小权限实现（本轮交付）

1. **策略 fail-closed**（`policy.ts`）：`fsReadRoots`/`fsWriteRoots` 必须非空绝对路径、
   `netLoopbackOnly`/`noNetRaw`/`noProcessInjection` 必须为 true（能力语义占位）、envWhitelist 项名校验；
   非法即抛 `SandboxPolicyError` 拒绝启动；`isPathAllowed` 穿越后判定（`../` 与相似前缀均拒绝）。
2. **环境白名单裁剪**（`launcher.ts`）：默认仅保留 `DEFAULT_ENV_WHITELIST`（PATH/SYSTEMROOT/TEMP 等运行必需）；
   业务变量经 `extraEnv` 显式放行；**凭据语义变量（`*KEY*/*TOKEN*/*SECRET*/*PASSPHRASE*` 等）硬剥离——
   extras 里声明也抛错拒绝**（真实 Key 永不见沙箱进程）；剥离 `NODE_OPTIONS/NODE_PATH` 等注入面。
3. **launch()**：显式 `cwd=projectDir`（须在策略根内）+ 裁剪环境 + `windowsHide`；
   projectDir 越界 → fail-closed 拒绝。
4. **越权自测**（`self-test.ts`）：可执行断言（环境无凭据泄漏/无 NODE 注入面/策略路径判定/临时目录读写）
   + **已登记边界观察项**（`writeUserProfileObserved`——降级模式下 OS 不阻断用户目录写，如实记录非缺陷）。

## 已知边界（登记）

- 无 OS 级文件/网络阻断：网络隔离为语义声明（loopback-only）+ 自检观察，真实阻断待 native helper；
- 受限令牌模式（runas）仅有去管理员化价值，不作为防线路径；
- **接线决策（2026-08-24，R4-1）**：agent-service spawn 接线**顺延至 in-proxy 轮**——
  本轮 KeyStore 落地后主进程需向 agent-service 注入 `AICH_IMAGE_API_KEY` 等凭据环境变量，
  与本包 scrubEnv 的「凭据变量硬剥离」安全设计直接冲突；待凭据改为注入式代理通道
  （真实 Key 永不见沙箱进程的 in-proxy 语义）后，spawn 一并切换到 launch()。

测试：`npm test`（vitest 8 用例：策略校验/穿越防护/环境裁剪/extras 拒凭据/真实 spawn 自证 cwd+裁剪/自测语义）。
