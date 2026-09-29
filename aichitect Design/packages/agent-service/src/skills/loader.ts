/**
 * 外部 Skill 加载（R6-3，Anthropic Agent Skills 开放格式）。
 *
 * - 目录约定：<skillsDir>/<skill-name>/SKILL.md（YAML 前置元数据 name/description + Markdown 正文）；
 * - L1 元数据（name/description）注入系统提示「可用技能」段（发现依据）；
 * - 正文按需加载：read_skill 工具返回全文（对齐 Anthropic 的渐进式披露机制）；
 * - 校验 fail-soft：非法目录/损坏文件跳过（不阻塞启动）；name 白名单 ^[a-z0-9-]{1,64}$。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolBinding } from "../adapters/common.js";

export interface ExternalSkill {
  name: string;
  description: string;
  /** SKILL.md 全文（含前置元数据；截断上限 64KB）。 */
  body: string;
  /** allowed_tools 白名单（R6-8：内置技能据此过滤工具；undefined = 不限）。 */
  allowedTools?: string[];
}

const NAME_RE = /^[a-z0-9-]{1,64}$/;
const BODY_MAX = 64 * 1024;

/** 解析 SKILL.md（frontmatter name/description + 正文）。非法返回 null。 */
export function parseSkillMd(raw: string, fallbackName: string): ExternalSkill | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const meta = fm?.[1] ?? "";
  const name = (/^name:\s*(.+)$/m.exec(meta)?.[1] ?? fallbackName).trim();
  const description = (/^description:\s*(.+)$/m.exec(meta)?.[1] ?? "").trim();
  if (!NAME_RE.test(name)) return null;
  // allowed_tools（Anthropic 格式）或 allowedTools：YAML 列表 "- item"
  const toolsBlock =
    /^(?:allowed_tools|allowedTools):[^\S\n]*\n((?:[^\S\n]*-[^\S\n]*[a-zA-Z_][a-zA-Z0-9_]*[^\S\n]*\n?)*)/m.exec(meta)?.[1] ?? "";
  const allowedTools = [...toolsBlock.matchAll(/-\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]!);
  return {
    name,
    description: description.slice(0, 500),
    body: raw.slice(0, BODY_MAX),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
  };
}

/** 扫描单个技能目录（<dir>/<name>/SKILL.md）；目录不存在/为空返回 []。 */
function loadSkillDir(dir: string): ExternalSkill[] {
  if (!dir || !existsSync(dir)) return [];
  const skills: ExternalSkill[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      try {
        const skill = parseSkillMd(readFileSync(file, "utf8"), entry.name);
        if (skill) skills.push(skill);
      } catch {
        // 单个技能文件损坏跳过（fail-soft）
      }
    }
  } catch {
    return [];
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * R6-8：多目录合并加载（内置技能目录 + 用户技能目录）——内置与外部同一机制。
 * 同名技能后者覆盖（用户可改写内置行为）；preferredOrder 中的技能排前（image-gen 首要）。
 */
export function loadSkillsFromDirs(dirs: readonly string[], preferredOrder: readonly string[] = []): ExternalSkill[] {
  const byName = new Map<string, ExternalSkill>();
  for (const dir of dirs) {
    for (const skill of loadSkillDir(dir)) {
      byName.set(skill.name, skill); // 后目录覆盖同名
    }
  }
  const order = new Map(preferredOrder.map((n, i) => [n, i]));
  return [...byName.values()].sort((a, b) => {
    const ia = order.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const ib = order.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    return ia !== ib ? ia - ib : a.name.localeCompare(b.name);
  });
}

/** 兼容别名（既有调用点）。 */
export const loadExternalSkills = (dir: string): ExternalSkill[] => loadSkillsFromDirs([dir]);

/** 外部技能的 L1 元数据段（注入系统提示；空列表返回 ""）。 */
export function skillsPromptSection(skills: readonly ExternalSkill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}：${s.description || "（无描述）"}`);
  return [
    "可用技能（宿主按用户意图自动分派；你也可以在职责相关时主动调用 read_skill 获取技能全文再执行）：",
    ...lines,
  ].join("\n");
}

/** read_skill 工具绑定（全 agent 可用；返回技能全文）。 */
export function buildReadSkillBinding(skills: readonly ExternalSkill[]): ToolBinding | null {
  if (skills.length === 0) return null;
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    def: {
      name: "read_skill",
      description: "读取外部技能的完整操作指引（SKILL.md 正文）。在系统提示的「外部技能」列表中选定技能后调用。",
      label: "读取技能",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "技能名（见系统提示外部技能列表）" } },
        required: ["name"],
      },
    },
    execute: async (params) => {
      const name = typeof params["name"] === "string" ? params["name"].trim() : "";
      const skill = byName.get(name);
      if (!skill) {
        return {
          text: `技能不存在：${name}（可用：${[...byName.keys()].join("、")}）`,
          isError: true,
        };
      }
      return { text: skill.body, details: { name: skill.name } };
    },
  };
}
