/**
 * E9：isTrustedIpcSender 判定逻辑单测。
 *
 * 覆盖：正常主 frame 通过；其他 WebContents 拒绝；iframe（非主 frame）拒绝；
 * 窗口未创建/已销毁时 fail-closed。
 */

import { describe, expect, it } from "vitest";
import { isTrustedIpcSender, type IpcSenderLike, type WebContentsLike } from "./ipc-guard.js";

/** 构造一个最小 WebContents 桩；frame 可指定为 mainFrame 或独立对象（模拟 iframe）。 */
function webContents(opts?: { destroyed?: boolean }): WebContentsLike {
  const mainFrame = { __brand: "main-frame" };
  return {
    isDestroyed: () => opts?.destroyed ?? false,
    mainFrame,
  };
}

function eventFor(wc: WebContentsLike, useMainFrame: boolean): IpcSenderLike {
  return { sender: wc, senderFrame: useMainFrame ? wc.mainFrame : { __brand: "iframe" } };
}

describe("isTrustedIpcSender（E9）", () => {
  it("本窗口主 frame 调用 → 可信", () => {
    const wc = webContents();
    expect(isTrustedIpcSender(eventFor(wc, true), wc)).toBe(true);
  });

  it("其他 WebContents（别的窗口/应用）→ 拒绝", () => {
    const mine = webContents();
    const other = webContents();
    expect(isTrustedIpcSender({ sender: other, senderFrame: other.mainFrame }, mine)).toBe(false);
  });

  it("渲染进程内 iframe（非主 frame）→ 拒绝", () => {
    const wc = webContents();
    expect(isTrustedIpcSender(eventFor(wc, false), wc)).toBe(false);
  });

  it("窗口尚未创建（mainWindow 为空）→ fail-closed 拒绝", () => {
    const wc = webContents();
    expect(isTrustedIpcSender(eventFor(wc, true), null)).toBe(false);
    expect(isTrustedIpcSender(eventFor(wc, true), undefined)).toBe(false);
  });

  it("窗口已销毁 → fail-closed 拒绝", () => {
    const wc = webContents({ destroyed: true });
    expect(isTrustedIpcSender(eventFor(wc, true), wc)).toBe(false);
  });

  it("sender 为 null/undefined → 拒绝（不抛异常）", () => {
    const wc = webContents();
    expect(isTrustedIpcSender({ sender: null, senderFrame: wc.mainFrame }, wc)).toBe(false);
    expect(isTrustedIpcSender({ sender: undefined, senderFrame: wc.mainFrame }, wc)).toBe(false);
  });
});
