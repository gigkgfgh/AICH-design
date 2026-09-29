/**
 * @aichdesign/shared 入口
 * 跨包契约冻结包：类型（contracts.ts）、错误码（errors.ts）、运行时端口（runtime.ts）、
 * PlanStructure 迁移注册表（migrations.ts）。planschema.json 为运行时 schema 权威文件。
 */

export * from "./contracts.js";
export * from "./errors.js";
export * from "./runtime.js";
export * from "./migrations.js";

export { default as planschema } from "../planschema.json" with { type: "json" };