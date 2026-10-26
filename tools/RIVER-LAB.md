# 河流评分台（临时脚手架 · TEMPORARY）

> **这是一次性的调参工具，不是游戏的一部分。**
> 等生成逻辑调好之后，按下面「删除清单」把它整个拿掉。

## 它解决什么问题

河流生成有 6 个旋钮（`src/river.js` 的 `RIVER_PARAMS`）：宽度、长波弯曲、短波抖动、
环岛概率、支流概率、汇合概率。人眼判断「这条河好不好看」很快，但很难反推该调哪个旋钮。

这个工具把流程拆成三步：

1. **评分** —— `tools/river-lab.html` 随机生成一条河，你按 1–5 打分（键盘 `1`–`5`）。
2. **统计** —— 分数写进 `shots/river-ratings.jsonl`（**第一次评分时才会创建这个文件**），`tools/river-tune.mjs` 算出
   每个旋钮和分数的**相关系数**（符号＝该往哪调，大小＝有多重要），以及「≥4 分的河流
   平均长什么样」。
3. **验证** —— 评分台里点「在游戏里试玩这组参数」，会带着 `?river={...}` 打开真实游戏，
   直接看它在实际对局里的样子。

## 为什么不是「训练模型」

1–5 分、几百条样本这个量级，训练生成模型是没有意义的。真正有效的是两件很朴素的事：

- **A. 高分种子池**（`river-tune.mjs` 自动写出 `shots/river-seeds.jsonl`）——
  直接只用评分高的 seed，零拟合、立刻见效。
- **B. 旋钮相关性** —— 找出「哪个旋钮往哪个方向调」，然后人肉改 `src/config.js`。

我一开始用岭回归做 B，结果六特征 + 噪声标签直接解出 NaN（还给出过错误的正负号），
所以换成了皮尔逊相关系数：没有矩阵求逆，不会退化，符号天然可信。

## 输出怎么读

`river-tune.mjs` 会打印：

| 段 | 内容 |
| --- | --- |
| 表头 | 样本数、平均分、标准差、**1–5 分分布**、跳过的损坏行数 |
| **评语** | 你手写的每一条（按分数分组），外加**反复出现的词**（中文按二字词统计并向上合并成长词） |
| **A** | 分数 ≥ 阈值的高分种子池，写成 `shots/river-seeds.jsonl` |
| **B** | 每个旋钮与分数的**相关系数**：符号＝往哪调，大小＝有多重要 |
| **C** | 高分图平均长什么样，以及和当前 `config.js` 的差距 |
| **D** | **具体建议**：关系最强的那个旋钮、当前值 → 建议值、可直接粘贴的 JSON |

**「好」的阈值是自适应算出来的**，不是硬编码 4 分：如果你一条 4 分都没给过，
它会退回到「你的前 20% 分位」那一档，并在开头明确告诉你
「没有任何一条达到 4 分 ⇒ 生成器整体不合格，这时该看 B 段的**负**相关」。
否则工具会在你最需要它的时候一声不吭。

如果 B 段里**所有** |r| 都 < 0.15，D 段会直接说：问题不在这些旋钮上，
而在生成器的几何本身——那时候把评语那段交给 AI 看比继续调参有用。

## 用法

```bash
node tools/serve.mjs                 # 已经跑着就跳过
# 浏览器打开 http://127.0.0.1:8123/tools/river-lab.html
# 键盘 1-5 打分，R 换一条，B 回退
node tools/river-tune.mjs            # 看统计和建议参数
```

**打分要点**：一定要把分差拉开（好的给 5、烂的给 1）。工具会检查标准差，
如果大家都在 3 分左右会直接警告——那种数据学不到东西。

样本量的经验值：**30 条**能看 A，**150 条以上**B 才有意义。

## 数据落在哪

| 文件 | 内容 | 删除时 |
| --- | --- | --- |
| `shots/river-ratings.jsonl` | 每一行是一次评分（seed / 旋钮 / 分数 / **可选的评语** / 时间）| 一起删 |
| `shots/river-seeds.jsonl` | 高分种子池（`river-tune.mjs` 生成）| 一起删 |
| 浏览器 localStorage | 同一份评分的本地副本 | 清站点数据即可 |

评分是**追加写**的：`tools/serve.mjs` 的 `POST /ratings` 每次把新行接到文件末尾，
所以中途关掉浏览器不会丢数据。

## 删除清单

调好之后按顺序做这四件事（**没有别的耦合**）：

1. **删文件**
   ```
   tools/river-lab.html
   tools/river-tune.mjs
   tools/RIVER-LAB.md          ← 本文档
   shots/river-ratings.jsonl
   shots/river-seeds.jsonl
   ```

2. **`tools/serve.mjs`** —— 删掉 `POST /ratings` 与 `GET /ratings` 两个路由块
   （搜 `river-ratings.jsonl` 就能定位，两块紧挨着，在 `/report` 和 `/shot-log` 之间）。

3. **`src/main.js`** —— 删掉 `readRiverParams()` 函数以及 `startGame()` 里
   `riverParams: readRiverParams(),` 这一行。

4. **`src/game.js`** —— 删掉构造函数里的
   ```js
   /** Optional river parameter overrides, e.g. from tools/river-lab.html. */
   this.riverParams = options.riverParams || null;
   ```
   并把下一行的 `new River(this.rng, CONFIG.world, this.riverParams)` 改回
   `new River(this.rng, CONFIG.world)`。

**保留不动的**（它们是游戏本身的代码，不是脚手架）：

- `src/river.js`：`River` 的第三个 `params` 参数、`RIVER_PARAMS`、`riverKnobs()` ——
  默认值就是 `CONFIG.river`，不传参时行为完全不变，留着对测试也有用。
- `src/config.js`：`wiggle` 与 `branchChance` 两个旋钮 —— 生成器自己要读。
- `tools/river-tune.mjs` 之外的任何测试 —— 它们不依赖评分数据。

删完跑一遍确认没有残留引用：

```bash
node --test && node tools/build.mjs && node tools/bundle-smoke.mjs
node tools/fuzz.mjs
# 应该没有输出（没有残留引用）
grep -rn "riverParams\|readRiverParams\|river-ratings\|river-seeds" src tools --include=*.js --include=*.mjs --include=*.html
```
