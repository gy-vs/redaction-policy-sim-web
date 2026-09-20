# Redaction Review Studio

文本脱敏审阅工作台：编辑检测器组合、置信阈值与替换策略，保存前对固定样例集模拟。

## 运行

```bash
npm install
npm run dev      # 前端 http://localhost:4173，API http://127.0.0.1:4174
npm test         # vitest + supertest
npm run build    # 类型检查 + 产物构建
```

## 关键行为

- **策略编译**：服务端编译草稿，检出无效引用（`invalid_reference`）、循环派生
  （`circular_derivation`）、永远不可达规则（`unreachable_rule`，祖先阈值 > 1）、
  越界阈值与缺失替换文案；存在问题时拒绝保存（422）。
- **统一协调**：多个检测器的重叠命中按 `(起点, 规则顺序, -置信度, 终点)` 确定排序，
  每个范围记录“由哪条规则产生”以及“被哪条更高优先级规则覆盖”。
- **模拟绑定**：每次模拟绑定策略草稿哈希（规范化文本的 SHA-256 截断）与样例 revision；
  前端任何字段修改都会改变规范化文本，旧结果立即标记过期但保留用于对照。
- **批量模拟**：`POST /api/simulate` 以 NDJSON 流式返回 `started / sample / done` 事件；
  客户端中止（AbortController）即取消；进行中事件 `partial=true`，终态 `partial=false`；
  单个样例的检测器失败只标记该样例，不阻断其余样例。
- **并发保存**：策略与样例均按 expectedRevision 乐观并发控制，冲突返回 409 与当前状态。

## 结构

- `src/shared/` — 领域模型、规范化/哈希、编译校验、检测器、统一协调与模拟（前后端共用）
- `src/server/` — Express API（策略/样例/编译/流式模拟）与内存存储
- `src/client/` — React 工作台（规则编辑器、样例面板、模拟统计）
- `test/api.test.ts` — 覆盖重排、阈值边界、检测器失败、重叠、样例更新、并发保存、流式取消
