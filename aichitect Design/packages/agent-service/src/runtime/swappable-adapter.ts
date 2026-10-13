/**
 * 可热切换的适配器间接层。
 *
 * 背景：端点/密钥配置此前只能靠「杀子进程 → 主进程重新 spawn」生效（`restartAgentService`），
 * 代价是重建网关端口、丢失在途 run 上下文、会话 token 全失效，用户每次改一个 Key 都要等
 * 握手往返数秒。而 adapter/imagePort 本身是无状态的纯配置派生对象，替换成本极低。
 *
 * 本类把「当前生效的 adapter」收敛到一个可变的槽位：RunManager 与 RetryingRuntime 始终
 * 持有同一个 SwappableAdapter 实例，reload 时只换槽内对象，不动服务器、不动在途 run。
 *
 * 并发约定：JavaScript 单线程下「读 current」与「写 current」不会交错到一半，
 * 因此这里不需要锁。代价是最多一个在途 run 会用旧 adapter 跑完——这正是期望语义
 * （reload 不应打断已发出的请求）。
 */

import type { AgentRuntimePort, RunHandle, RunRequest } from "@aichdesign/shared";

export class SwappableAdapter implements AgentRuntimePort {
  private current: AgentRuntimePort;
  /** 当前 adapter 的展示标签（/v1/health 与就绪行回传；reload 后随之更新）。 */
  private currentLabel: string;

  constructor(initial: AgentRuntimePort, initialLabel: string) {
    this.current = initial;
    this.currentLabel = initialLabel;
  }

  label(): string {
    return this.currentLabel;
  }

  /**
   * 原子替换生效的 adapter。
   *
   * @param next    新 adapter
   * @param nextLabel 新 adapter 的标签
   * @param disposePrevious 是否在替换后释放旧 adapter（reload 场景为 true；
   *   首次装配时传 false，避免对尚未使用的实例做无谓的释放）。
   */
  async swap(next: AgentRuntimePort, nextLabel: string, disposePrevious = true): Promise<void> {
    const previous = this.current;
    this.current = next;
    this.currentLabel = nextLabel;
    if (disposePrevious && previous !== next) {
      try {
        await previous.dispose();
      } catch (err) {
        // 旧 adapter 释放失败不影响新配置生效，仅告警。
        process.stderr.write(`[reload] 旧 adapter 释放失败（忽略）：${(err as Error).message}\n`);
      }
    }
  }

  /**
   * 运行期注册能力：转发到当前 adapter。
   *
   * reload 会换掉槽内 adapter，因此这里必须动态转发而非在构造时绑定——否则热重载后
   * 新注册的技能/扩展会丢失在旧的 adapter 上，表现为"重启后技能才生效"。
   */
  loadSkill(skill: Parameters<AgentRuntimePort["loadSkill"]>[0]): void {
    this.current.loadSkill(skill);
  }

  registerExtension(ext: Parameters<AgentRuntimePort["registerExtension"]>[0]): void {
    this.current.registerExtension(ext);
  }

  async run(req: RunRequest): Promise<RunHandle> {
    return this.current.run(req);
  }

  async dispose(): Promise<void> {
    await this.current.dispose();
  }
}