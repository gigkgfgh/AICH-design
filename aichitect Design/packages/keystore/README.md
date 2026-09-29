# @aichdesign/keystore

P016 密钥存储：`KeyStorePort` 抽象 + `AesGcmFileKeyStore` 加密文件实现。

- **口令**：`AICH_KEYSTORE_PASSPHRASE` 环境变量或构造参数（首启口令；交互提示为 UI 层占位）。
- **派生**：主密钥 = `scrypt(口令, storeSalt, 32)`（默认 N=16384/r=8/p=1，OWASP 建议下限；测试可注入小参数）。
- **条目加密**：AES-256-GCM，随机 12B IV，**AAD = keyRef**（防条目互换攻击）。
- **落盘**：版本化 JSON `{ version, kdf, entries }`（base64），文件权限 0600 尽力设置（Windows no-op）。
- **fail-closed**：篡改（GCM tag 校验失败）/ 错口令 / 非 JSON 损坏 / 未知版本 → 抛 `KeyStoreError`，绝不返回猜测明文。
- `verifyPassphrase(candidate)`：首启口令确认探针（恒定时间比对）。

## 接线边界（本轮登记）

- 「真实 Key 永不见沙箱进程」为后续 in-proxy 语义（主进程 → 网关注入式凭据替换）；
  本轮 agent-service 仍接收主进程环境变量注入的 Key（保持 R2 行为）。
- Electron 主进程接线（首启口令 UI → KeyStore → LLM/图像 Key 注入）为后续轮任务。

测试：`npm test`（vitest：往返/密文落盘/重开/错口令/篡改/条目互换/口令缺失/环境口令/损坏文件）。
