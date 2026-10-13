import { describe, expect, it } from "vitest";
import { SwappableAdapter } from "../src/runtime/swappable-adapter.js";
import type { AgentRuntimePort, RunHandle, RunRequest, SkillDef } from "@aichdesign/shared";

/** 可区分身份的桩 adapter：记录 run 落在哪个实例上、是否被 dispose。 */
class TaggedAdapter implements AgentRuntimePort {
  disposed = false;
  skillCount = 0;
  constructor(private readonly tag: string) {}
  loadSkill(_skill: SkillDef): void {
    this.skillCount += 1;
  }
  registerExtension(): void {}
  async dispose(): Promise<void> {
    this.disposed = true;
  }
  async run(_req: RunRequest): Promise<RunHandle> {
    return {
      events: null as never,
      result: Promise.resolve({ kind: "stream" as const, delta: this.tag }),
      status: "succeeded" as const,
    };
  }
}

describe("SwappableAdapter（配置热重载的adapter 间接层）", () => {
  it("初始 label 与 run 均落在初始 adapter 上", async () => {
    const first = new TaggedAdapter("first");
    const swappable = new SwappableAdapter(first, "adapter-v1");
    expect(swappable.label()).toBe("adapter-v1");
    const handle = await swappable.run({} as RunRequest);
    const result = await handle.result;
    expect(result.kind === "stream" && result.delta).toBe("first");
    swappable.loadSkill({} as SkillDef);
    expect(first.skillCount).toBe(1);
  });

  it("swap 后 run 与 loadSkill 转发到新 adapter，label 同步更新", async () => {
    const first = new TaggedAdapter("first");
    const second = new TaggedAdapter("second");
    const swappable = new SwappableAdapter(first, "adapter-v1");

    await swappable.swap(second, "adapter-v2");
    expect(swappable.label()).toBe("adapter-v2");

    const handle = await swappable.run({} as RunRequest);
    const result = await handle.result;
    expect(result.kind === "stream" && result.delta).toBe("second");

    // 运行期注册能力必须动态转发，否则重载后新注册的技能会丢在旧 adapter 上
    swappable.loadSkill({} as SkillDef);
    expect(second.skillCount).toBe(1);
    expect(first.skillCount).toBe(0);
  });

  it("swap 默认释放旧 adapter；disposePrevious=false 时不释放", async () => {
    // 公开可观测的判据：默认路径下旧 adapter 的 dispose 会被调用。
    const old = new TaggedAdapter("old");
    const keep = new SwappableAdapter(old, "v1");
    await keep.swap(new TaggedAdapter("new"), "v2", false);
    expect(old.disposed).toBe(false);

    // 换一个干净的旧实例验证默认路径（避免受上一条 swap 影响）。
    const old2 = new TaggedAdapter("old2");
    const auto = new SwappableAdapter(old2, "v1");
    await auto.swap(new TaggedAdapter("new2"), "v2");
    expect(old2.disposed).toBe(true);
  });

  it("旧 adapter 释放失败不影响新配置生效", async () => {
    const bad: AgentRuntimePort = {
      loadSkill: () => {},
      registerExtension: () => {},
      run: async () => ({ events: null as never, result: Promise.resolve({ kind: "stream" as const, delta: "bad" }), status: "succeeded" as const }),
      dispose: async () => {
        throw new Error("释放失败");
      },
    };
    const good = new TaggedAdapter("good");
    const swappable = new SwappableAdapter(bad, "v1");
    await expect(swappable.swap(good, "v2")).resolves.toBeUndefined();
    expect(swappable.label()).toBe("v2");
    const handle = await swappable.run({} as RunRequest);
    const result = await handle.result;
    expect(result.kind === "stream" && result.delta).toBe("good");
  });

  it("dispose 转发到当前生效的 adapter", async () => {
    const first = new TaggedAdapter("first");
    const second = new TaggedAdapter("second");
    const swappable = new SwappableAdapter(first, "v1");
    await swappable.swap(second, "v2", false);
    await swappable.dispose();
    expect(second.disposed).toBe(true);
    expect(first.disposed).toBe(false);
  });
});