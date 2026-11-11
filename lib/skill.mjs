/**
 * 科研式解题器 —— 技能正文。
 *
 * 这段文字在插件加载时注册为一个技能，模型读到它就知道怎么用两个工具。
 * 它刻意写得很短：流程细节靠工具报错和 human/ 产物引导，不在这里复述一遍。
 */

export const SKILL_MD = `# 科研式解题器（research-solver）

把「解一个难题」当成论文来做：先找别人的不足，再用同一套尺子量所有方案，
针对短板融合改进，最后用同一套尺子再量一次。

## 两条原则

1. **创新点必须落在别人的不足上。** 没有 gapIds 的方案只是功能罗列。每条不足都要能指回一条资料。
2. **先本地，后联网。** 资料有 tier：0 工作区文件 / 1 本地知识库 / 2 本机应用 MCP / 3 网络。
   走 tier 3 必须写 \`whyLocalFailed\`，否则 check 报 S001；本地占比低于 50% 报 S002。

## 四个阶段（顺序不可跳）

| 阶段 | 做什么 | 工具 |
| --- | --- | --- |
| 1 资料收集 | 找别人怎么做、哪里做不好 | \`research_task action=source\` / \`action=gap\` |
| 2 指标与评估 | 先定尺子，再量所有方案 | \`action=metric\` / \`action=candidate\` → \`research_score action=evaluate\` |
| 3 改进与融合 | 按矩阵短板补，不重新发明 | \`action=candidate\` + \`kind=fused\` |
| 4 迭代改善 | 只认同一套尺子下的差分 | \`research_score action=iterate\` |

阶段由内容自动推导：有指标和候选即进入 2，出现融合方案进入 3，两次评估进入 4。

## 推荐调用顺序

\`\`\`
file_layout   action=init    root=<目录>          # 先立骨架，再往里放东西
research_task action=init project=<slug> title=<标题> goal=<要解决什么>
research_task action=source  project=<slug> sources=[{tier:0,title:...,locator:...}, ...]
research_task action=gap     project=<slug> gaps=[{target:"谁做不好",gap:"具体不足",evidence:["s-1"]}, ...]
research_task action=metric  project=<slug> metrics=[{name:"准确率",weight:40,direction:"higher"}, ...]
research_task action=candidate project=<slug> candidate={name:"方案A",gapIds:["g-1"],scores:[{metric:"m-1",value:7}, ...]}
research_task action=candidate project=<slug> candidate={name:"融合B",kind:"fused",fuses:["c-1"],...}
research_score action=evaluate project=<slug>
research_score action=iterate  project=<slug> hypothesis="..." changes=[...]
research_task action=check    project=<slug>
\`\`\`

## 文件分两层，四个格子

任何一次解题（不只是建了项目的）都要把文件放进这套骨架，而不是散在工作区里：

\`\`\`
<目录>/
├── human/                 给人看
│   ├── 交流/              往返记录：需求、追问、取舍讨论、会议纪要
│   ├── 流程展示/           怎么一步步走到结论的：阶段、进度、计划
│   ├── 成品/              能直接拿去用的东西
│   └── 可验证中间过程/      评分表、校验清单、原始数据、证据
└── ai/                    给 AI 读写：状态、索引、日志、脚本
\`\`\`

判断归属只问一句：**这份文件是给谁读的？**
- 人要读、且是过程的 → \`human/流程展示/\`
- 人要读、且是结论的 → \`human/成品/\`
- 人要读、且能被重新算一遍 → \`human/可验证中间过程/\`
- 只是人和 AI 之间的往返 → \`human/交流/\`
- 机器读的结构化数据/脚本 → \`ai/\`

用 \`file_layout\` 管这件事，不要手动猜：

\`\`\`
file_layout action=init  root=<目录>          # 建骨架 + 每格说明
file_layout action=audit root=<目录>          # 指出放错的、低置信的、散在根目录的
file_layout action=move  root=<目录> all=true # 一键归位（低置信的用 path= + kind= 逐个定）
file_layout action=map   root=<目录>          # 重建 human/README.md 与 ai/index.json
\`\`\`

**根目录只留说明文件。** 散在根目录的文件是「还没决定给谁看」，不是「暂时放一下」。

## 纪律

- **先写缺点再写优点。** \`candidate.weaknesses\` 为空通常说明你没看懂它。
- **不要用总分掩盖单项。** 总分上涨时回看 02 的矩阵，看哪一格掉了。
- **改指标必须重跑全部评分。** 指标一改，旧结论立即过期（check 报 R001）。
- **融合方案要写 \`fixes\`：** 说清它补了哪条不足或哪个弱指标。
- **交付前跑 check。** error 未清零就不要说「完成」。

## 产物在哪

项目根：\`research/<slug>/\`

- \`human/交流/\` — 入口说明、决策记录（给人建立共识）
- \`human/流程展示/00-总览.md … 04-迭代分析.md\` — 完整推演（给评审者）
- \`human/成品/方案.md\` — 最终方案（给使用者）
- \`human/可验证中间过程/评分表.csv\`、\`校验清单.md\` — 给怀疑者复算
- \`ai/state.json\` — 唯一真相源，所有 human/ 文件由它渲染

不要在 \`human/\` 里手改结论：下次 check 会标记不一致，而且任何改动都会在重新渲染时被覆盖。

不是研究项目、只是普通的文件整理任务时，也同样用这套骨架（\`file_layout\`），别另发明一套目录。
`;
