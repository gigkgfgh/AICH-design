"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 渲染进程安全桥（P007 preload）
 *
 * - contextIsolation 开启，仅暴露白名单 API，渲染进程不接触 Node/Electron 能力
 * - 主进程通过 webContents.send('gateway:event', envelope) 推送 SSE 事件
 * - 渲染侧类型声明见 src/types/global.d.ts（window.aichBridge）
 */
const electron_1 = require("electron");
const bridge = {
    /** 查询网关状态（agentService ready → 走 bridge 网关；否则渲染层走 mock） */
    getGatewayStatus: () => electron_1.ipcRenderer.invoke('gateway:status'),
    /** 发出 AgentRequest，主进程 POST /v1/run（runOptions 携带 agent/model/thinking），返回 { requestId } */
    runRequest: (req, runOptions) => electron_1.ipcRenderer.invoke('gateway:run', req, runOptions),
    /** R5：上传参考图注册（dataURL → imageId，可作 genImage.refImageId/editImage.imageId） */
    uploadImage: (sessionId, dataUrl, name) => electron_1.ipcRenderer.invoke('upload:image', sessionId, dataUrl, name),
    /** 取消流（POST /v1/cancel） */
    cancelRequest: (requestId) => electron_1.ipcRenderer.invoke('gateway:cancel', requestId),
    /** 订阅主进程转发的 SSE 事件；返回退订函数 */
    onGatewayEvent: (cb) => {
        const listener = (_e, envelope) => {
            cb(envelope);
        };
        electron_1.ipcRenderer.on('gateway:event', listener);
        return () => {
            electron_1.ipcRenderer.removeListener('gateway:event', listener);
        };
    },
    /** 会话历史列表（主进程读 sessions/*.jsonl 摘要；bridge 模式有效） */
    listSessions: () => electron_1.ipcRenderer.invoke('sessions:list'),
    /** R6-9：删除历史会话（jsonl + meta.db 级联） */
    deleteSession: (sessionId) => electron_1.ipcRenderer.invoke('sessions:delete', sessionId),
    /** 读取会话完整内容（消息流/图像/版本引用；bridge 模式有效） */
    readSession: (sessionId) => electron_1.ipcRenderer.invoke('sessions:read', sessionId),
    /** R5：历史方案完整恢复（meta.db plan_version；不可用时返回 []，降级为引用级恢复） */
    storagePlans: (sessionId) => electron_1.ipcRenderer.invoke('storage:plans', sessionId),
    /**
     * G8 兜底：file:// 图像 → 主进程白名单读取转 dataURL（仅会话数据目录内，fail-closed）。
     * 失败抛错；渲染层保持原 src 并提示。
     */
    readImageAsDataUrl: (uri) => electron_1.ipcRenderer.invoke('image:readDataUrl', uri),
    /** R6：在途运行列表（刷新/切回后重连挂接；pump 结束即移除） */
    activeRuns: () => electron_1.ipcRenderer.invoke('gateway:activeRuns'),
    /** R6：重挂单个请求（在途广播已覆盖；终态则回放缓存事件） */
    reattachRun: (requestId) => electron_1.ipcRenderer.invoke('gateway:reattach', requestId),
    /** R6：外部链接经系统浏览器打开（仅 http/https） */
    openExternal: (url) => electron_1.ipcRenderer.invoke('open:external', url),
    /** R6-3：打开外部技能文件夹（自动创建；返回路径） */
    openSkillsDir: () => electron_1.ipcRenderer.invoke('skills:openDir'),
    /** R6-3：重启本地服务（技能/配置变更后生效） */
    restartService: () => electron_1.ipcRenderer.invoke('service:restart'),
    /** R6-4：外部技能列表（加号菜单「选择技能」；mock/未就绪返回 []） */
    listSkills: () => electron_1.ipcRenderer.invoke('skills:list'),
    /** R6-6：保存多模型条目（全量替换+激活 id；保存后自动重启服务） */
    saveModels: (entries, activeModelId) => electron_1.ipcRenderer.invoke('secrets:saveModels', entries, activeModelId),
    /** R6-6：设置自定义会话目录（''=恢复默认；保存后自动重启服务） */
    setSessionsDir: (dir) => electron_1.ipcRenderer.invoke('config:setSessionsDir', dir),
    /** R6-7：弹出文件夹选择对话框（返回所选路径或 null） */
    browseSessionsDir: () => electron_1.ipcRenderer.invoke('config:browseSessionsDir'),
    /** R6-9：Agent Loops 日志开关（重启服务生效） */
    setLoopLogEnabled: (enabled) => electron_1.ipcRenderer.invoke('looplog:setEnabled', enabled),
    /** R6-13：单次运行工具调用轮次上限（1~200；保存后自动重启服务生效） */
    setMaxToolCalls: (value) => electron_1.ipcRenderer.invoke('agent:setMaxToolCalls', value),
    /** R6-14：保存多图像服务商条目（保存后自动重启服务生效） */
    saveImageModels: (entries, activeImageModelId) => electron_1.ipcRenderer.invoke('secrets:saveImageModels', entries, activeImageModelId),
    /** R6-14：无边框窗口控制（ZCode 同构自绘按钮） */
    windowMinimize: () => electron_1.ipcRenderer.invoke('win:minimize'),
    windowToggleMaximize: () => electron_1.ipcRenderer.invoke('win:toggleMaximize'),
    windowClose: () => electron_1.ipcRenderer.invoke('win:close'),
    getWindowChromeState: () => electron_1.ipcRenderer.invoke('win:chromeState'),
    onWindowChromeChanged: (cb) => {
        const listener = (_e, state) => cb(state);
        electron_1.ipcRenderer.on('win:chromeChanged', listener);
        return () => {
            electron_1.ipcRenderer.removeListener('win:chromeChanged', listener);
        };
    },
    /** R6-6：打开 Agent 日志文件夹（自动创建；返回路径） */
    openLogsDir: () => electron_1.ipcRenderer.invoke('logs:openDir'),
    /** 密钥状态（不含密钥内容；无口令方案） */
    secretsStatus: () => electron_1.ipcRenderer.invoke('secrets:status'),
    /** 保存 LLM/图像 Key 配置（safeStorage 系统级加密保存；保存后自动重启 agent-service 生效；undefined 不改、'' 清除） */
    secretsSaveKeys: (input) => electron_1.ipcRenderer.invoke('secrets:saveKeys', input),
};
electron_1.contextBridge.exposeInMainWorld('aichBridge', bridge);
//# sourceMappingURL=preload.cjs.map