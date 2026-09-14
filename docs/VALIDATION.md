# v0.3.0 验证记录

日期：2026-09-14。共享工作室阶段；不包含营地或项目进度。

## 结果按证据层级区分

| 层级 | 本次结果 | 可以证明什么 | 不能证明什么 |
|---|---|---|---|
| 原版本基线 | 50/50 通过 | v0.2.0 原有测试可复现 | 设计正确或覆盖完整 |
| 新回归用例先跑旧版本 | 首批 19 个中 18 个失败 | 修复针对可复现问题，而非只写报告 | 18 个独立根因或穷尽所有问题 |
| 最终 Node 测试 | **85/85 通过**，0 跳过 | 状态机、身份／审批、乱序、真实磁盘、HTTP/SSE、安装链路、强杀与显式恢复 | 用户 Mac 的 Codex Desktop 接入、浏览器完整端到端 |
| Chromium 模拟 UI | **14 项检查通过**，无页面脚本错误 | 交互、布局、异常快照防御、动画控制 | 真实 ES module、CSP、浏览器 HTTP 连接 |
| 正常浏览器 → 真实服务 → 已安装 recorder | **受阻，未通过** | 严格测试存在且实际尝试执行 | 不能宣称该链路通过 |
| 用户 Mac → 真实 Codex Desktop Hooks | **未执行** | 无 | 实际版本字段、信任流程、工具覆盖与长期性能 |
| GitHub Actions | 已配置，结果由对应 commit 的运行记录提供 | 自动运行 Linux/macOS Node 与 Linux 浏览器测试 | 工作流文件存在不代表检查通过 |

本地环境：Linux、Node v22.16.0、Python 3.13、Playwright 1.57.0、Chromium。`npm test` 实测约 7.52 秒，不是未来执行时间承诺。摘要见 `node-test-results.txt`，UI 明细见 `browser-results.json`，端到端受阻记录见 `e2e-results.json`。

## 可复现命令

```bash
npm test
python3 -m pip install playwright==1.57.0
python3 -m playwright install chromium
npm run test:ui
npm run test:e2e
```

已有 Chromium 可设置 `CHROMIUM_PATH`。浏览器脚本不属于运行时依赖，`npm start` 仍不需要安装任何包或提供 API Key。

`test/browser_smoke.py` 在内存页面中组合脚本并模拟 fetch，结果只归入 UI。`test/e2e.py` 正常导航至本机服务，执行真实安装器生成的 recorder 命令；认证、SSE、模块与队列都不 mock。此次执行在 `page.goto` 返回 `net::ERR_BLOCKED_BY_ADMINISTRATOR`，没有把失败改成 skip 或模拟结果。即使该 E2E 在其他机器通过，也不代表真正启动了 Codex。

## 新增关键故障测试

审批说明与键顺序变化、迟到审批和收尾事件、所有六种单工具到达排列、相同命令并行歧义、同毫秒事件、无回合与陌生回合隔离、恢复后过期与错误过期、关联容量耗尽、损坏快照、临时文件 rename 失败、遗留锁、安装符号链接、真实 SSE 健康恢复。

真实安装链路测试从临时 `CODEX_HOME` 安装脚本开始，运行生成的 shell 命令，验证静默输出、脱敏落盘、离线队列回放、真实 HTTP 和请求头认证。强杀测试确实启动并 `SIGKILL` 自有子进程，在观察到快照提交和队列确认后终止它；等待退出、验证遗留锁拒绝抢占，再在隔离目录显式移除遗留锁并恢复，验证重放去重。这不覆盖任意掉电时刻或文件系统损坏。

## 用户桌面验收仍是发布门槛

升级后重新 `hooks:preview` / `hooks:install`，在 Codex 审核信任。验证两个任务同时运行不串状态、修改与测试规则保守、审批不被另一工具返回清除、中断不被迟到事件复活、收尾不当成需求完成。关闭看板后正常编码应继续；重开后重放队列但不把旧状态当作实时。`npm run probe` 只能显示合成自检，不能替代这些检查。

不要为了验收让模型每次主动汇报动画，不要跳过 Hook 信任，也不要把工作事件数当成项目完成百分比。第一阶段尚未通过实际 Desktop 验收前，第二阶段继续延期。
