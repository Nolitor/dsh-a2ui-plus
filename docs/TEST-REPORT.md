# dsh-a2ui — 测试与验证报告

<!-- skeleton:
version: 0.2.0
kind: report
status: active
updated: 2026-11-27
summary: Upstream 0.4.0 verification report inherited with the fork, plus the fork's own build, test, verify and render results.
-->

## v0.4.0 发布验证

| 验证项 | 结果 |
|---|---|
| `npm run all` | 类型检查、构建、198 个自动化用例、32 项 bundle 检查、19 个 React 渲染用例和隔离安装检查通过 |
| 浏览器回归 | 修复后的构建通过 38 项 Chrome 浏览器场景，覆盖热力图滚动与提示、散点坐标轴、雷达图和帕累托图等交互 |
| 发布包 | `tools/verify-install.mjs --tarball` 对安装包执行 27 项检查，核对包名、版本和运行文件字节 |

下文保留早期版本的验证记录。

---

生成时间：2026-11-15
被测版本：`dsh-a2ui@0.3.0`

> 历史记录：本报告最初随 0.2.0 发布；0.3.0 的测试数据（160 个自动化用例、17 个渲染用例）已并入下文，早期版本的验证记录仍保留在对应章节。

## 一、环境

| 项目 | 值 |
|---|---|
| DeepSeek Harness | 0.2.2-rc.1（Desktop，Profile `desktop`，`patchReload: live`） |
| 运行平台 | Windows 10.0.26200，Node.js v24.11.1 |
| A2UI 协议 | 1.0（校验规则取自 `@a2ui/web_core@0.15.0` 的 v1.0 schema 与 basic catalog 定义） |
| 安装方式 | `plugin_manager install_bundle` → 目录链接 `link:C:/Users/ChimeSky/Desktop/DSH/plugins/a2ui/package` |
| 构建 | `tsc`（进程内 API）+ 自写模块链接器；无 esbuild（沙箱禁止其原生服务的管道，`spawn EPERM`） |

## 二、自动化测试

命令：`npm run all`（= typecheck → build → test → verify）

| 项目 | 结果 |
|---|---|
| TypeScript 类型检查（`strict`） | ✅ 0 错误 |
| 构建 | 35 个模块；`client.js` 332 KiB；`lib/**` 16 模块 + `index.js` |
| 单元/集成/验收用例 | ✅ **160 / 160 通过**（`node:test`，`duration ≈ 3 s`） |
| 真实 React 渲染 | ✅ **17 / 17**（`npm run render`） |
| DOM 事件用例 | ✅ **14 / 14**（jsdom，`tests/dom.test.mjs`） |
| 官方 catalog 样例 | ✅ **43 / 43**（`tests/fixtures/examples`，commit `58379ad`) |
| Bundle 不变量检查 | ✅ **32 / 32 通过** |

用例分布：

| 文件 | 数量 | 覆盖内容 |
|---|---|---|
| `tests/protocol.test.mjs` | 32 | 信封（version/单一 message key/未知字段）、未知组件与属性、缺 `root`、悬空引用、环、重复 ID、`Surface` 误用、目录不匹配、未知 catalog、`updateComponents` 合并语义、`updateDataModel` 指针写入/删除、`deleteSurface`、多 surface 隔离、模板子列表、消息数/字符串长度上限、v0.8/v0.9 载荷拒绝、`callRendererFunction` 明确拒绝；同批次状态机（create+update+数据更新累积、双 updateComponents、delete→create、重复 create 拒绝、create 字段校验、basic 目录 + 扩展组件、跨调用形状保持）；官方 43 样例全通过、`@checks`/`@catalogId` 别名归一与冲突拒绝 |
| `tests/unit.test.mjs` | 14 | JSON Pointer 读写（copy-on-write、`~0/~1` 转义）、字面量/绑定/函数调用解析、模板内相对绑定、模板展开上限、`formatString`（路径/嵌套调用/字面量/转义/畸形输入）、数字/货币/日期/复数格式化、5 个校验函数、action context 解析、表达式求值与拒绝（`this`/`window.constructor`/`x[0]`/`x;y`/超长）、26 个组件逐一最小样本校验通过、catalog 文档包含全部组件与函数且体积 < 8 KB |
| `tests/integration.test.mjs` | 15 | Host 插件形态与 `inject`、两个工具 + 一个 prompt 段的注册、`muteSection`/`catalogTool:false`、主动触发策略与 `autoRender:false` 收紧、成功执行与摘要渲染、失败时的路径化报错、超大可回放副本降级、`a2ui_catalog` 输出、effect 清理（生命周期）、URL/SVG 准入、浏览器 bundle 经 `vm` + React stub 加载并注册两个槽位、bundle 中无 `eval`/`new Function`/`dangerouslySetInnerHTML`、外部依赖仅 `react` |
| `tests/turn-tail.test.mjs` | 9 | 轮末转录查询：仅取本轮、跳过隐藏节点、结果阶段从 `call.name` 取名、非 a2ui 排除、store/order 缺失返回空、Map 与普通对象兼容；`turnDataSource` 载荷映射（顺序、start→result 阶段切换、畸形输入） |
| `tests/claims.test.mjs` | 5 | 副本认领：会话/调用隔离、嵌套认领与幂等释放、缺失标识不认领、订阅通知与退订、订阅者抛错不影响已记录的认领 |
| `tests/limits.test.mjs` | 26 | 正则安全子集与 ReDoS 拒绝（含耗时断言与独立进程超时用例）、46,656 叶节点载荷、长列表模板、超大序列图表、正常嵌套模板、展开估算、指针长度/段数/下标/原型链、稀疏数组拒绝、合法追加与删除、字段级错误定位；官方四条安全规则的正反例（`(?:ab){2}`、`([A-Z]){2}`、相邻无界量词、`\d+\s*\d+`）、散点计数、多 Surface 总预算、11,000 层 JSON、拒绝写入的字段路径、`pointerWrite` 三态、**有界求值器与既有匹配语义一致**（`regex keeps the existing matching semantics for regular validation patterns`） |
| `tests/dom.test.mjs` | 14 | jsdom 真实事件：过程行编辑经轮末接管仍在、双击只入队一次、发送失败（`QUEUE_FULL`）后表单可编辑并可重试、成功后锁定、隐藏节点不渲染、改名工具靠 meta 渲染（正反例）、官方 `00_incremental` 每行按钮携带本行餐厅名、Tabs 方向键/Home/End 与 roving tabindex、Modal 初始焦点/Tab 环/Esc/焦点回归 |
| `tests/client-units.test.mjs` | 11 | action 信封与时间戳、模板行作用域取值、编辑后取值、userMessage、超限拒绝、日期时间往返（纯时间/ISO/date min-max/垃圾输入）、柱状图零点基线域、Plot 断点切分 |
| `tests/acceptance.test.mjs` | 9 | 见下节验收场景 1–9 |
| `tests/streaming.test.mjs` | 26 | 渐进式渲染恢复、消息版本与已闭合组件校验、官方增量样例、单张与聚合预算、缓存上限、会话窗口重建与取消、工具过滤、同调用 ID 的会话隔离、卸载释放订阅 |

**第 8 条需求（交互性）的验证方式**：图表悬停、图例开关、表头排序都是纯客户端状态，无法在无头环境断言像素；已通过 9 个 SSR 渲染用例（含官方 `00_incremental` 等价 fixture、逐条内容断言）确认「带交互逻辑的组件树仍能完整渲染且不抛异常」，交互行为本身需要人眼确认（见第五节）。

以下三节是历轮核对记录（第二轮 → 第一轮 → 0.2.0 收尾），主体验收表见 §三。

## 附一、复验返修（第二轮）核对

| 项 | 状态 | 证据 |
|---|---|---|
| 构建不再删除任何文件 | ✅ | 编译器只在内存中 emit，链接/复制全由本次 emit 清单驱动；`reportStale()` 只列出不属于本次构建的 `lib/` 文件。连续两次构建成功，标记文件仍在，陈旧文件未进入 `client.js` / `build/shared.mjs`（`tests` 之外的临时验证已跑过） |
| 正则按官方四条规则 | ✅ | `src/shared/regex.ts` 重写（专用解析器 + 字符集分析）；`(a+)+$`、`(a\|ab)*c`、`\d+\s*\d+`、`^a*a*…a*$` 拒绝；`(?:ab){2}`、`([A-Z]){2}`、`^(?=.*\d).{8,}$` 通过；独立进程 1.5 s 超时用例 |
| Plot 散点计数 | ✅ | `budget.ts` 按渲染分支数点：`points.length` + 非散点的 `samples`；2×8×500 点被拒 |
| 多 Surface 总预算 | ✅ | `maxTotalExpandedNodes` / `maxTotalExpandedDataUnits`；5 个表面各 1501 单元被拒 |
| 深层 JSON | ✅ | `isJsonValue` 改迭代实现并限制 128 层，序列化前先判定；11,000 层不再栈溢出 |
| 拒绝写入显式化 | ✅ | `pointerWrite` 返回 `ok/unchanged/refused`；`{arr:[]}` + `/arr/500` 在 `/messages/1/updateDataModel/path` 报错；合法追加/删除保持 |
| 官方增量示例空标签 | ✅ | `renderById` 向普通后代传递模板行作用域；`00_incremental.json` 四行全部渲染，行按钮携带本行餐厅名（SSR + DOM 双证） |
| 纯日期回归 | ✅ | `toControlValue(...,'date')` 不再做时区换算，`2026-11-13` 在任意时区都是 13 日；仅 `datetime-local` 转本地墙上时间 |
| 失败后仍锁输入 | ✅ | 表单锁定条件改为 `sending \|\| sent`；DOM 用例覆盖失败后可编辑、改值、重试入队一次 |
| 轮末接管丢输入 | ✅ | `model-store.ts` 按 `sessionId+callId+surfaceId` 共享模型与动作状态；DOM 用例：行内编辑 → 轮末挂载仍是新值 |
| 轮末可见性 / 自定义工具名 | ✅ | 卡片取自 `locations.getTurn(turn)` 的有序节点并过滤 `visibility === 'hidden'`，`turnDataSource` 仅作变化信号；`isA2uiRoot` 增加 `meta.kind === 'a2ui'` 回退，改名工具在轮末渲染（正反例各一） |
| 官方 43 样例 | ✅ | `tests/fixtures/examples`（commit `58379ad`）+ `protocol.test.mjs` 全量断言 |
| 饼图占比与边界 | ✅ | 占比按已绘制切片求和；>40 切片与 >10 图例时显示截断提示（不再静默丢弃） |
| Modal 键盘焦点 | ✅ | 初始焦点入对话框、Tab 环、Esc 关闭、关闭后焦点回归触发按钮（DOM 用例） |
| Tabs 方向键 | ✅ | ←/→/↑/↓/Home/End + roving tabindex（DOM 用例） |
| CI 渲染检查 | ✅ | `.github/workflows/ci.yml` 增加 `npm run render`；`jsdom` 进入 `devDependencies` 与 lock |

仍未覆盖：
- 真实 DSH 桌面端的隔离 `DSH_HOME` 安装/启停/重开/分页验收未在本次执行（受会话环境限制），本报告只记录已安装 profile 的重新加载成功。
- `sendDataModel` 全量回传、`callRendererFunction`/`agentFunctionResponse` 仍未实现（明确拒绝并文档化）。
- 过程行与轮末共享同一 store，但**跨调用**的 surface 生命周期仍是快照语义。

## 附二、第一轮任务书核对（历史记录）

| 项 | 状态 | 证据 |
|---|---|---|
| §0 构建安全：去掉递归删除，改显式单文件清理 | ✅ 已被第二轮取代 | 第二轮彻底移除了构建中的任何删除：编译器内存 emit，`reportStale()` 只列出陈旧文件 |
| §1 同批次状态机 | ✅ | 折叠改为读取批次最新状态；重复 create 拒绝；create 字段（`dataModel`/`sendDataModel`/`metadata`）无组件时也校验；目录继承；delete→create 摘要 `deleted=false`；`states` 与 Host 摘要同源 |
| §1 官方增量 fixture | ✅ | `tools/render-check.mjs` 的 `incremental create + append` 用例断言输出含餐厅列表与最后追加项 |
| §1 跨调用契约文档化 | ✅ | 提示词与 README 改为「每次调用一张快照」，并给出完整 `createSurface` 示例指引 |
| §2 正则安全子集 | ✅ | `src/shared/regex.ts`；`^(a+)+$` 在 0 ms 内被拒绝，正常邮箱/数字仍通过；字面量在校验期报字段路径 |
| §2 展开预算 | ✅ | `src/shared/budget.ts`；46,656 叶节点载荷 < 3 ms 被拒；Host 与客户端同一估算器；超限渲染为可读错误而非整块空白 |
| §2 JSON Pointer 边界 | ✅ | 长度 1024 / 段数 64 / 下标 10000、原型链段拒绝、稀疏写入拒绝、`-` 追加、`~0`/`~1` 保留 |
| §3 模板行作用域 | ✅ | action 取值改为携带 scope；两行分别取到各自 item；DOM id 含 callId + 行号 |
| §3 日期时间往返 | ✅ | `src/client/datetime.ts`；纯时间 `14:30` 稳定、ISO 按本地墙上时间显示、非法输入退化为空 |
| §3 错误态 / 重复提交 | ✅ | `isError` 结果不再回落渲染可操作内容；同一组件发送中二次点击只入队一次，失败后可重试 |
| §3 轮末订阅 | ✅ | 改用 `nodes.turnDataSource(turn, 'tool-call')`（官方 `snapshot.ts` 契约），保留 `order`+`nodes` 回退；start→result 原地更新有单测 |
| §5 柱状图基线/轴域 | ✅ | `barDomain()`：全正从 0 起、全负到 0 止、混合含 0、显式域优先且越界裁剪、全零不退化；堆叠正负分别累积；横向从基线两侧生长 |
| §5 Plot 变量与断点 | ✅ | `variables` 支持整体绑定；`splitPlotSegments()` 在越界/非有限处断开 |
| §6 可复现测试 | ⚠️ 部分 | `react`/`react-dom` 已进 `devDependencies` 与 `package-lock.json`；`render-check` 默认用仓库 fixture，`--session` 显式读取录制的会话；`tools/verify-install.mjs`、`tools/install.ps1` 已修 `-DshHome` 绝对化与 `DSH_HOME` try/finally。**未跑 `npm ci --ignore-scripts` 全流程**（会替换当前 `node_modules`），未新增 CI workflow |
| §3(g) 两处卡片共享本地模型 | ❌ 未做 | 过程行与轮末各自持有 `models` 状态；因副本认领保证同一时刻只渲染一份，实际影响限于「运行中在过程行编辑后轮末接管」这一窗口。方案：把 `models`/`interactions` 提升为按 `sessionId|callId|surfaceId` 索引的模块级 store（含订阅） |
| §3 日期时间/滑块 checks | ✅ | 两者均执行 `checks` 并显示字段级错误、设置 `aria-invalid` |
| §4 别名归一（`@checks` 等） | ❌ 未做 | 需要上游 1.0 规范的别名清单与冲突判定；当前只支持 `@path`/`@call` 双写与 `path`/`call` 兼容 |
| §4 `sendDataModel` 全量回传 | ⚠️ 文档化 | 接受该字段但不做全量同步；已在限制中说明 |
| §5(c) 饼图百分比/上限提示 | ⚠️ 部分 | 百分比按全部接受数据计算；命中 40 切片 / 10 图例上限时**未加显式提示** |
| §5(d) Modal/Tabs 键盘 | ❌ 未做 | 目前 Modal 支持 Esc 与遮罩点击，无焦点陷阱/初始焦点/焦点回归；Tabs 无方向键 |
| §7 真实 DSH 隔离环境验收 | ❌ 未做 | 未使用独立临时 `DSH_HOME` 启动宿主；宿主级验证沿用已安装的 `desktop` profile |

## 附三、0.2.0 收尾与推送就绪

| 项 | 状态 | 证据 |
|---|---|---|
| 版本号正式升到 `0.2.0` | ✅ | `package.json` / `package-lock.json` / `README`×2 / 本报告；新增 [CHANGELOG.md](../CHANGELOG.md) 并纳入发布 `files` 白名单 |
| 冻结 tarball 与源码一致 | ✅ | `vendor/dsh-a2ui-0.2.0.tgz`（142,434 B，27 文件）：包内 `client.js` 与工作区 **SHA-256 相同**（301,469 B）；旧的 `0.1.0` tarball 已按单文件删除 |
| 文档计数与实测一致 | ✅ | 130 用例 / 11 渲染用例 / 43 官方样例 / 29 不变量（此前文档停留在 129 与 10） |
| 有界求值器的语义边界写入文档 | ✅ | 中英 README 已知限制第 8 条；`regex keeps the existing matching semantics…` 用例；审阅期差分测试 1144 组 0 差异 |
| 隔离 `DSH_HOME` 的可重复验收 | ✅ 部分 | 新增 `tools/verify-fresh-home.mjs`（`npm run verify:fresh-home`）：在临时 home 里按 tarball 布局安装 → 校验 27 个发布文件逐字节一致 → 去掉 bundle 行复现「停用被识别」→ 恢复后通过 → 版本漂移被识别 |
| GUI 内交互 / 重开会话 / 历史分页 | ❌ 仍未覆盖 | 需要运行中的 Host + 浏览器；`verify-fresh-home` 明确打印这一边界，见下节 |

## 三、验收场景

| # | 场景 | 自动化验证 | 结论 |
|---|---|---|---|
| 1 | 文字 + 按钮 + 选择框的交互卡片 | 卡片 13 组件图校验通过；`ChoicePicker` 绑定值经 action context 正确解析为 `{plan:['pro']}` | ✅ 数据链路通过；像素见「未验证」 |
| 2 | 月度销售柱状图 + 折线图 | 两图共用 `{"@path":"/revenue"}` 绑定，数据模型与 series 一致 | ✅ |
| 3 | 二次函数 a/b/c 参数可视化 | 三个 Slider 写模型 → `Plot.variables` 解析为 `{a:2,b:0,c:-4}` → 表达式 `2x²-4` 在 x=1 时得 -2；原模型未被修改 | ✅ 本地重绘本路径通过 |
| 4 | 冒泡排序交互动画 | 4 帧 `FramePlayer` 校验通过，帧状态（compare/active/sorted）保真 | ✅ 帧数据通过；播放动画见「未验证」 |
| 5 | 学习计划表单 → Agent 继续 | 填表后 action context = `{level:['beginner'],hours:8,goal:'…',algorithms:true}`；`userMessage` 解析正确 | ✅ |
| 6 | 会话恢复 | 同一批消息重复校验/折叠结果一致；输入载荷未被修改（JSON 快照相同）；重复折叠幂等 | ✅ 逻辑层；GUI 重开见「未验证」 |
| 7 | 普通对话兼容性 | Host 仅注册 2 个工具 + 1 个 prompt 段（精确断言），不触碰 Markdown/输入框/其他工具；停用后 prompt 段与工具消失（已在真实会话中观察） | ✅ |
| 8 | 异常与安全输入 | `<script>`、`javascript:`、`__proto__` 等作为文本被原样保留并以文本节点渲染；恶意 URL 被 `safeMediaUrl` 拒绝；未知组件/属性、`dangerouslySetInnerHTML`、v0.8 载荷全部拒绝 | ✅ |
| 9 | 多会话隔离 | 两个会话各自折叠同名 `surfaceId`，互不影响；更新一方不影响另一方 | ✅ |
| 10 | 插件生命周期 | effect 清理后工具与 prompt 段归零；真实环境中 bundle 停用→槽位 occupant 消失、启用→重新出现 | ✅ |

## 四、真实 DSH 桌面端验证（未使用无头替代）

以下证据均来自本次运行中的 Desktop 实例：

1. **工具已对模型可见**：`a2ui`、`a2ui_catalog` 出现在本会话的可用工具表中，工具描述与参数 Schema 即本插件注册内容。
2. **提示词段已注入**：本会话 system prompt 中出现 「Generative UI (A2UI 1.0)」段（由 `ctx.systemPrompt.section` 提供）。
3. **Catalog 工具可用**：`a2ui_catalog(detail="brief")` 返回 26 个组件的参考文本。
4. **校验闭环生效**：首次提交包含 `Progress.max: {"@path":"/total"}` 的载荷被拒绝，返回
   `- /messages/0/createSurface/components/7/max: must be a finite number (got object)`；修正后同一轮内重新提交成功——即设计中的「报错 → 修正 → 重试」循环。
5. **渲染调用成功**：返回 `Rendered surface "activation" (13 components).`
6. **可回放副本已落盘**：直接解码会话日志 `session.v4.jsonl.zstd` 后可见该调用的 `tool/result`：
   `meta.kind=a2ui`、`title="dsh-a2ui 激活验证"`、`surfaces=1`、可回放消息 1 条、`version=1.0`、`surfaceId=activation`、13 个组件、`catalogId=dsh-a2ui/catalog/v1`。
   这正是浏览器在历史页/重开时读取的数据，因此「会话恢复」不依赖任何插件私有状态。
7. **浏览器半边已注册**：Client 槽位检查显示 `tool.call.toolview` 的 keyed occupant 列表中存在 `key: "a2ui", active: true`。
8. **生命周期无残留**：停用 bundle 后，该 occupant 消失、prompt 段从下一轮消失；重新启用后二者恢复。停用期间其他工具（`cordis_*`、`skill`、`present` 等，其 registrant 同为 `tk`）不受影响，说明占位消失确由本插件导致。
9. **交互闭环（真人点击，已实测）**：在仪表盘上点击「刷新」后，Agent 收到一条完整用户消息：
   `[A2UI action] 刷新 dsh-a2ui 项目仪表盘` + 紧随其后的
   `{"version":"1.0","action":{"name":"refresh-dashboard","surfaceId":"status","sourceComponentId":"refresh","timestamp":"2026-11-12T13:38:18.900Z","context":{"scope":"all"},"userMessage":"…"}}`。
   即：按钮 → 协议 `action` 消息 → 普通用户消息入队 → Agent 处理，全链路成立。
10. **失败重试回路（实测）**：同一轮内我两次把 `caption` 写到 `Progress` 上，工具两次返回精确路径
    `/messages/0/createSurface/components/7/caption: is not a property of Progress`，第三次改正后成功渲染。
11. **轮末渲染（turnTail，已实现并通过 SSR 渲染验证）**：新增 `conversation.chat.turnTail` 条目；用真实日志载荷渲染得到 2840 字节 HTML（完整卡片），「进程行」在轮次结束后退化为 222 字节的一行指针，二者不重复。是否真的出现在浏览器主会话流中，需要一次页面刷新后由人确认（见第五节）。

## 五、未验证项（如实说明）

| 项目 | 原因 |
|---|---|
| 视觉呈现（配色、间距、图表外观、明暗主题切换、窄窗口表现） | 当前会话无法读取浏览器 DOM/截图；样式全部使用 `--dsw-alias-*` 主题变量并通过 bundle 检查，但**外观未经人眼确认** |
| 轮末（turnTail）卡片在真实浏览器中的落位 | 已有 11 个 SSR 渲染用例（含轮末与指针形态）与 10 个 DOM 用例证明不抛错、内容正确，但「是否真的出现在主会话流中」需要一次页面刷新后由人确认 |
| 关闭/重开 DSH 后界面恢复 | 需要重启应用；已证明可回放副本存在且渲染器只依赖该副本。**安装/停用/版本漂移**已由 `npm run verify:fresh-home` 在临时 `DSH_HOME` 中覆盖 |
| GUI 内完整链路（点卡片 → 入队消息 → 新一轮 → 重开会话 → 历史分页） | 需要运行中的 Host + 浏览器；DOM 用例覆盖到「点击产生何种消息」，但真实入队与重开画面本次未执行 |
| 两个真实会话并排的视觉隔离 | 仅逻辑层验证 |
| `FramePlayer` 动画时序、Slider 拖动实时重绘的流畅度 | 需要真实浏览器交互 |
| 渐进式流式渲染的**实时**观感 | 通过 `client.js` 的 DOM 用例用 Session 事件源驱动真实 React 卡片，覆盖两个非空分片、取消、窗口替换、`inert` 和正式结果接管。官方增量样例在生成阶段显示四条记录。本轮未在运行中的 DSH 对话观察实际逐帧呈现 |

## 六、开发过程中发现并修复的问题

| # | 问题 | 处理 |
|---|---|---|
| 1 | 插件激活失败：`cannot get property "systemPrompt" without inject` | `inject` 增加 `systemPrompt`；移除未声明的 `ctx.logger` 访问 |
| 2 | 沙箱内 `esbuild`/`node --test` 均因 `spawn EPERM` 失败 | 改用 TypeScript 编译器 API + 自写模块链接器；测试改为单进程加载 |
| 3 | 模块链接器不支持 `export * from` | 增加 `Object.assign(exports, require(...))` 转换 |
| 4 | `formatString` 的 `${/path}` 无法解析 | 标识符字符集补入 `/`、`~` |
| 5 | 表达式语言接受 `this` 等宿主标识符 | 增加保留字黑名单（`this`/`window`/`constructor`/`eval`…） |
| 6 | `Progress.max` 被误当作可绑定属性（真实调用中暴露） | 保留为字面量，并在错误信息中给出精确路径 |

## 七、复现命令

```bash
npm install --ignore-scripts
npm run all                  # typecheck → build → test → verify → render → verify:fresh-home
npm run pack:vendor          # 重新生成 vendor/dsh-a2ui-<version>.tgz
npm run inspect:session      # 打印最近会话中 a2ui 调用的 meta 与可回放副本
```

单项：

```bash
node tools/run-tests.mjs dom        # 只跑 DOM 用例
node tools/verify-fresh-home.mjs    # 临时 DSH_HOME：安装布局 / 停用 / 版本漂移
node tools/render-check.mjs --session   # 额外渲染最近一次录制的真实载荷
```
