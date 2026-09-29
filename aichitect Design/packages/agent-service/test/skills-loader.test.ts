/**
 * R6-3 外部 Skill 加载测试：frontmatter 解析/目录扫描/去重/fail-soft/read_skill 工具。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExternalSkills, parseSkillMd, skillsPromptSection, buildReadSkillBinding } from "../src/skills/loader.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aich-skills-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function writeSkill(name: string, md: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), md, "utf8");
}

describe("parseSkillMd", () => {
  it("frontmatter name/description 解析；正文保留", () => {
    const skill = parseSkillMd(
      "---\nname: material-guide\ndescription: 材料选型指南\n---\n\n# 正文\n按步骤选材。",
      "material-guide",
    )!;
    expect(skill.name).toBe("material-guide");
    expect(skill.description).toBe("材料选型指南");
    expect(skill.body).toContain("# 正文");
  });

  it("缺 frontmatter 时回退目录名；非法 name 拒绝", () => {
    expect(parseSkillMd("# 无元数据", "fallback-name")?.name).toBe("fallback-name");
    expect(parseSkillMd("---\nname: BAD NAME\n---\nx", "x")).toBeNull();
  });
});

describe("loadExternalSkills", () => {
  it("扫描子目录 SKILL.md；无 SKILL.md 的目录跳过；同名去重", () => {
    writeSkill("material-guide", "---\nname: material-guide\ndescription: 材料\n---\nA");
    writeSkill("case-lib", "---\nname: case-lib\ndescription: 案例库\n---\nB");
    mkdirSync(join(dir, "no-skill-md"));
    writeFileSync(join(dir, "loose.md"), "---\nname: loose\n---\nX"); // 根级散文件不算
    const skills = loadExternalSkills(dir);
    expect(skills.map((s) => s.name)).toEqual(["case-lib", "material-guide"]);
  });

  it("目录不存在返回 []；损坏文件跳过不抛错", () => {
    expect(loadExternalSkills(join(dir, "nope"))).toEqual([]);
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", "SKILL.md"), "x".repeat(10), "utf8"); // 无 name 元数据但可用 fallback
    expect(loadExternalSkills(dir).length).toBe(1);
  });
});

describe("注入与工具", () => {
  it("skillsPromptSection 生成发现段；空列表为空串", () => {
    expect(skillsPromptSection([])).toBe("");
    writeSkill("case-lib", "---\nname: case-lib\ndescription: 案例库\n---\nB");
    const section = skillsPromptSection(loadExternalSkills(dir));
    expect(section).toContain("read_skill");
    expect(section).toContain("- case-lib：案例库");
  });

  it("read_skill 按 name 返回全文；未知技能报错", async () => {
    writeSkill("case-lib", "---\nname: case-lib\ndescription: 案例库\n---\n正文B");
    const binding = buildReadSkillBinding(loadExternalSkills(dir))!;
    const ok = await binding.execute({ name: "case-lib" });
    expect(ok.text).toContain("正文B");
    const bad = await binding.execute({ name: "nope" });
    expect(bad.isError).toBe(true);
    expect(buildReadSkillBinding([])).toBeNull();
  });
});
