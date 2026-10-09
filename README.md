# 语流 · Yuliu IME

基于 [LIME](https://github.com/xushengfeng/lime) 的本地大模型拼音输入法。默认 Qwen3-1.7B Q4_0，在 Windows ARM64 / Snapdragon Hexagon NPU 上运行；Rime 提供系统候选窗。

这是实验原型，下面的功能已经接通，但小规模回归结果不能证明它胜过成熟输入法。

## 当前能力

- **多路径候选**：对符合拼音的模型 token 分支继续推理，比较完整词句；有限宽度的搜索代替单条贪心路径。候选分数来自真实模型概率，没有传统词频伪装成模型概率。
- **完整拼音优先**：区分完整音节、未打完的音节和简拼；支持全拼、简拼、混拼及 `xi'an` 分音。
- **有限纠错**：尝试一次漏键、错键、多键或相邻字母交换，用模型重新评分；纠错候选带标记，完整拼音优先，不开启全局模糊音。
- **光标上下文**：网页使用真实选区前后文字，能编辑正文、移动光标和替换选区。Rime 使用独立 Windows UI Automation 辅助进程读取当前编辑控件的前 256 / 后 128 字符；不支持、快照过期时回退到上屏记录，输入框变化时清空旧记录。密码控件不读取、不学习。
- **后文比较**：在预算允许时，对小组候选比较后文前两个模型 token 的概率；属于有限长度的向前评分，不能等同于整篇理解。
- **本地学习**：只记录明确选择的拼音、词语和次数，有限加权；个人词仍经过模型评分。网页可查看、删除、清空、撤销最近一次修改、暂停和恢复；没有保存正文作为学习记录。
- **渐进结果与缓存**：先提供已缓存模型概率能筛出的候选，再后台搜索；同一客户端的新输入取消旧搜索，网页丢弃过期响应。复用完整前缀概率、进行中的相同请求及完整查询结果。搜索约 1.8 秒预算，已开始的一次 NPU 调用可略超预算。
- **系统输入**：Rime 常驻命名管道，逐键无需启动子进程；简洁横排候选窗。

## 本机启动

需要 Windows ARM64、GenieX 支持的 Qualcomm NPU、ARM64 Node.js、Python/pip 和 PowerShell。文档上下文辅助进程另需 **.NET 10 SDK** 编译及对应 Windows Desktop Runtime。

```powershell
./setup.ps1
./start.ps1
./open-demo.ps1
./stop.ps1
```

设置脚本固定运行时与 GenieX 版本，下载模型并校验 SHA-256，生成本地密钥、网页和 Rime 配置；有 .NET SDK 时编译上下文辅助进程。没有 SDK 时仍能运行输入法，Rime 使用上屏记录。首次设置需要网络；推理只在本机运行。NPU 故障不自动降级 CPU。

网页：[本机试打](http://127.0.0.1:5000/try.html)。正文可编辑；切英文键盘输入拼音，空格等完整首选，数字按当前显示顺序选择。鼠标停在候选区时暂停自动重排。

## Rime 接入

安装 [官方小狼毫](https://github.com/rime/weasel/releases)，由用户完成系统注册的管理员确认，然后运行：

```powershell
python work/setup_rime_files.py
python work/stage_rime.py
```

在小狼毫中“重新部署”，选择“大模型拼音”。部署脚本保留已有 schema 偏好；已有 `default.custom.yaml` 时自行加入 `llm`。可将生成的 `weasel.custom.yaml` 合并到自己的主题设置。

Rime 逐键显示首批候选，**空格等待完整搜索并选首项，Tab 刷新完整候选，数字保留显示时的选择**。目前 Lua 前端没有空闲定时刷新，停下打字后完整候选不会自行更新；网页会自动更新。冷上下文还没有模型概率时，Rime 的第一个按键会等首次计算。

配置源在 `lime/rime/`，含本地密钥的生成文件在忽略的 `outputs/rime-npu/`。`llm_context/learning: false` 可关闭该 Rime 客户端的选词学习。

## 配置与接口

```powershell
$env:LIME_CONTEXT_CHARS='256'
$env:LIME_MODEL='Qwen3-1.7B-Q4_0.gguf'
./start.ps1
```

更换模型需自行下载兼容 GGUF。NPU 与分词器必须使用同一模型。上下文辅助进程当前固定读取前 256 / 后 128 字符，Rime 上屏窗口也默认 256。

所有 `/api/*` 要求本地 Bearer 密钥。`POST /candidates` 接受 `keys/context/after/session/progressive/surrounding`，返回 `job/pending/revision/candidates`；`GET /results/:job` 取渐进结果，`?wait=1` 等完成。`POST /commit` 的 `keys/selected` 表示明确选词；`GET/POST /learning` 管理记录。

## 测试和日志

启动服务后：

```powershell
./tests/run.ps1
```

包含 Deno 单元测试、NPU 用例、快速连续输入、缓存、学习管理、真实 Rime DLL / Lua 测试、文档快照协议测试和上下文长度性能测试。Rime 测试需要从官方安装包提取的 x64 `rime.dll` 和 data 放在 `work/weasel-all/`，并用 x64 Python 执行。测试自己的 Rime 配置关闭学习，使用独立文档快照，不读取当前用户文档。仅核心测试可运行：

```powershell
work/runtime/node_modules/deno/deno.exe test -A --config lime/deno.json tests/core_test.ts
python tests/integration_npu.py
python tests/latency_npu.py
```

日志在 `work/performance.jsonl`、`work/server*.log`、`work/npu-server*.log`。新的 `candidate_initial` / `candidate_search` 区分首批响应和后台搜索，`candidate_filter` / `npu_request` 区分筛选和 NPU 等待；NPU 日志记录 token 数、计算耗时、缓存命中。性能记录只写输入长度，旧版日志仍可能有输入文字，不要上传日志。

测试规模、结果和限制见 [测试报告](docs/validation.md)。这些是可复现回归样例，不能作为独立的通用准确率评测。

## 限制

- UI Automation 依赖应用支持，尚未完成各类编辑器的实机兼容矩阵；回退上屏记录无法可靠反映删除、粘贴和移动光标。它不是原生 TSF 文档读取。
- 搜索宽度、深度和时间有限；候选仍可能不准，简拼和多音字还有改进空间。
- 后文仅评分前两个 token，预算不足时跳过。
- GenieX `forward_logits` 会清空原生 KV；当前复用完整前缀计算结果，**不是**跨滑动窗口的增量 KV 复用。
- 个性化是有限候选加权，没有模型微调；撤销保留一次内存快照，重启后不能撤销上次运行的修改。

## 隐私与许可证

服务仅监听本机并要求本地密钥。`work/learning.json` 是个人词记录，`work/context.json` 是当前文档的短快照，两者都忽略 Git。不要上传密钥、生成的 HTML / Lua、输入日志、快照或环境变量。模型和依赖二进制不随代码分发。

GPL-3.0，保留上游历史、许可证和来源，见 [UPSTREAM.md](UPSTREAM.md)、[LICENSE](LICENSE)。模型和依赖遵循各自许可证。
