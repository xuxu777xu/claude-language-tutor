# language-tutor

一边 coding 一边学外语。这是 Claude Code 的 mod，移植自 pi 扩展 [mackt/pi-language-tutor](https://github.com/mackt/pi-language-tutor)：检查你的 prompt、在你退回母语时教你怎么说、把新词存成记忆卡片，并把 Claude 的回复变成沉浸式双语对照。

默认配置开箱即用：学英语、母语简体中文。

> **来源**：本项目是 [mackt/pi-language-tutor](https://github.com/mackt/pi-language-tutor)（作者 Mack，MIT 许可）的 Claude Code 移植版。检查、辅导、翻译的提示词和文本规则沿用原作，界面与运行方式按 Claude Code 的 mod 接口重写。原作的版权声明保留在 [LICENSE](LICENSE)。

## 安装

在 Claude Code 终端会话的输入框里：

```text
/plugin install language-tutor --marketplace xuxu777xu/claude-language-tutor
```

询问 `Add marketplace?` 时按 `y`，再选安装范围（默认用户范围，回车即可）。

在 shell 里：

```sh
claude plugin install language-tutor --marketplace xuxu777xu/claude-language-tutor
```

在桌面应用里（不支持 `/plugin`）：点输入框旁的 +，选 Plugins，用 Add marketplace 添加 `xuxu777xu/claude-language-tutor`，再点 Add plugin。

## 功能

### ✏ Writing check

用你正在学的语言写 prompt。Claude 照常工作，输入框上方会出现面板，用**母语**讲清每一处错误，并给出整句更地道的说法。

### ✏ Writing tutor

先用**母语**写下 prompt，面板会教你学习语言里的整句地道表达、关键词汇和语法。

### 🗂 记忆卡片

Writing tutor 教过的单词会自动保存。运行 `/flashcards` 复习，用 FSRS 安排下次出现的时间。

### 🌐 双语卡片

运行 `/translate`，上一条回复会原位变成双语对照：每段原文下紧跟译文，短代码块原样保留，已经是母语的段落不重复翻译（母语是中日韩时按文字本地判断，这些段落不发给模型）。再运行一次就恢复原文。译文只改变显示，不会发给模型，也不占上下文。

## 快速上手

1. 用正在学的语言发一条 prompt：

   ```text
   when agent anwser me, I want translate it, it have three feature
   ```

   Claude 照常回答，输入框上方出现 `✏ Writing check`。按 `×` 可以收起。

2. 换成用母语写：

   ```text
   我想重构这个函数但是不知道怎么下手
   ```

   这次出现 `✏ Writing tutor`，单词同时存进记忆卡片。

3. 运行 `/flashcards`：`1` 开始复习，`s` 显示答案，`1`–`4` 评价 Again / Hard / Good / Easy，`b` 返回，Esc 关闭。

4. Claude 回答完，运行 `/translate`。想每条最终回复都自动翻译：`/lang auto on`。

## 设计原则

| | |
| --- | --- |
| **绝不阻塞** | prompt 立刻发给 Claude，检查在后台进行；没写错就不显示面板。 |
| **两个面板，不会同时出现** | 学习语言 → Writing check；母语 → Writing tutor。一次调用决定。 |
| **绝不污染对话** | 双语卡片只改终端里的显示，不发回模型、不占上下文。 |
| **花费你说了算** | 默认用 `haiku`，每条 prompt 一次调用也不贵；`/lang model <model>` 可换别的模型。 |

## 设置

`/lang` 打开设置面板，也可以直接带参数：

| 命令 | 作用 |
| --- | --- |
| `/translate` | 上一条回复切换为双语卡片 / 恢复原文 |
| `/flashcards` | 复习、浏览、编辑、删除记忆卡片，调整每日新卡和每轮数量 |
| `/lang` | 设置面板 |
| `/lang check off` \| `on` \| `context` | 检查与辅导模式（`context` 能看到会话；`/lang on`/`off` 也可以） |
| `/lang tutor on` \| `off` | 单独开关写作辅导 |
| `/lang auto on` \| `off` | 自动翻译每轮最终回复（约 15 个词以下的回复跳过） |
| `/lang native <code>` | 母语：译文与讲解的语言（`zh-CN`、`ja`…） |
| `/lang learning <code>` | 正在练习的语言（`en`、`fr`…） |
| `/lang model <model>` | 本 mod 用的模型：别名（`haiku`、`sonnet`）或完整模型 id，默认 `haiku` |
| `/lang model default` | 恢复为 `haiku` |
| `/lang context on` \| `off` | 翻译时携带完整会话上下文（默认关闭） |

开启自动翻译时，状态栏显示 `🌐 auto`。

## 上下文模式

`/lang check context` 和 `/lang context on` 会从主会话 fork 出请求：复用主会话上一次请求的前缀（系统提示词、工具定义、消息历史），服务商从 prompt cache 里取这段前缀，只按缓存读取计价，再加上本次检查或翻译的开销。这样能认出会话里约定的项目名和术语。

- fork 固定使用会话模型，`/lang model` 对上下文模式不生效。
- 会话的第一轮请求之前还没有可 fork 的内容，这时按无上下文处理。
- 检查在你发的每条消息上都会触发，开启 `check context` 后每次都有一次缓存读取。只有当检查总把项目术语误报成错误时才值得开。

## 哪些消息会被检查

斜杠 / 感叹号命令、过短的消息、含代码块或以代码路径为主的消息、`/lang check off` 期间的输入，都不检查。中日韩文本按字符计数，一整句母语仍会进入写作辅导。检查只在交互式会话里运行，失败也不影响会话。

## 文件

都在 `~/.claude/language-tutor/` 下：

| 文件 | 内容 |
| --- | --- |
| `config.json` | 语言、模型（默认 `haiku`）、各开关 |
| `flashcards.json` | 记忆卡片与 FSRS 状态 |
| `flashcards-settings.json` | `newPerDay`、`sessionLimit`、`requestRetention`（FSRS 目标保留率，只能改文件） |
| `tutor.log` | 每次检查、翻译、复习的步骤与错误，排查问题先看这里 |

## 和 pi 版的差别

- 默认模型是 `haiku`，不跟随会话模型；想用会话模型就用 `/lang model` 写明。
- Claude Code 的 mod 不能注册自定义快捷键，没有 `alt+t`，用 `/translate` 或自动模式。
- 记忆卡片在终端面板里复习，不弹原生窗口，也没有窗口主题设置。
- 已经是母语的段落不挂译文；整条回复都是母语时保持原样。母语是中文、日文、韩文时按文字本地判断，全是母语的回复不调模型。
- 翻译结果段数和原文对不上时直接报错（提示与 `tutor.log`），不再退回整段翻译。

## 开发

```sh
claude plugin validate .
claude plugin test .
```

`hooks/vendor/ts-fsrs.mjs` 是 [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) 5.4.1 的打包产物，去掉了它对 `Date.prototype` 的扩展（mod 运行环境冻结了内置对象，原样加载会失败）。

## 许可证

[MIT](LICENSE)。原作 © Mack；ts-fsrs © Open Spaced Repetition（[LICENSE](hooks/vendor/LICENSE-ts-fsrs)）。
