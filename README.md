# 文本脱敏审阅工作台

在保存脱敏策略前，编辑检测器组合、置信阈值与替换策略，并对一组固定样例进行流式模拟、逐范围溯源的本地工作台。

## 运行

```bash
npm install
npm run dev      # API: http://127.0.0.1:4174 ，前端: http://localhost:4173
npm test         # vitest（30 个用例）
npm run build    # tsc 类型检查 + vite 构建
```

## 功能覆盖

- **检测器组合**：内置检测器（邮箱/电话/身份证/银行卡/姓名/地址/密钥）之上定义派生检测器，支持并集、交集与邻近窗口。
- **规则与阈值**：规则列表顺序即优先级（P0 最高），阈值边界包含（`confidence ≥ min` 即提议），五种替换策略：掩码 / 标签 / 涂黑 / 哈希 / 保留。
- **规则重排**：上下移动改变优先级，重排参与草稿哈希，模拟绑定最新哈希。
- **服务端编译诊断**（`POST /api/policy/compile`）：
  - 无效引用：规则或派生检测器指向不存在的检测器；
  - 循环派生：DFS 找环，环上节点及其下游全部拒绝参与模拟；
  - 永远不可达：同检测器闭包上被更早且阈值更低（或相等）的规则完全遮蔽（警告）；
  - 阈值越界、id 重复/为空。
- **统一协调**（`src/server/coordinator.ts`）：按优先级逐字符占用，重叠范围切成片段，每条提议带人类可读的 `reason`，说明它由哪个检测器、以什么置信度/阈值产生，以及被哪条更高优先级规则在哪些片段上覆盖。
- **批量模拟**（`POST /api/simulate`，NDJSON 流式）：
  - 开始事件绑定**策略草稿哈希**与每个**样例 revision**；
  - 逐样例推送 `progress`（部分统计，虚线卡片），结束推送 `done`（最终统计）；
  - 单个检测器失败 → `detectorErrors`（按 0 命中处理），单个样例致命错误 → 样例结果带 `error`，均不阻断其他样例；
  - 可取消：`POST /api/simulate/:jobId/cancel` 或客户端断开；未开始的样例不再执行，已完成结果保留，最终事件为 `cancelled`。
- **过期保留对照**：前端修改任何字段（规则、阈值、策略、派生组合）或样例更新后，旧模拟结果立即打上“已过期”标记但不清空。
- **并发保存**：策略与样例均使用 revision 乐观锁，冲突返回 409 与服务端当前版本；前端可一键加载服务端版本合并。

## 主要模块

| 文件 | 职责 |
| --- | --- |
| `src/shared/types.ts` | 草稿、编译产物、提议、范围、流式事件等类型 |
| `src/server/policyCompiler.ts` | 规范化哈希、引用/循环/不可达编译诊断 |
| `src/server/detectorEngine.ts` | 内置正则检测器（可注入失败/延迟）、派生并集交集求值 |
| `src/server/coordinator.ts` | 优先级协调、片段化覆盖解释、替换文本与统计 |
| `src/server/simulator.ts` | 批量执行、取消、部分失败、部分/最终聚合统计 |
| `src/server/index.ts` | Express API：策略 CRUD+编译、样例 revision 锁、NDJSON 模拟与取消 |
| `src/client/` | 三栏工作台：策略编辑器 / 诊断与样例 / 流式结果与范围溯源 |

## API 摘要

- `GET/PUT /api/policy`，`POST /api/policy/compile`
- `GET/PUT /api/samples/:id`（PUT 需带 `revision`）
- `POST /api/simulate`：body 含 `draft`、可选 `sampleIds`、`detectorFailures`（测试注入）、`delayMs`；
  响应为 `application/x-ndjson`，事件序列 `start` → `progress`* → (`done` | `cancelled`)，响应头 `X-Sim-Job-Id`。
