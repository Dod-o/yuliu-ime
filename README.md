# 语流 · Yuliu IME

基于 [LIME](https://github.com/xushengfeng/lime) 二次开发的本地大模型拼音输入法原型。当前重点是 Windows ARM64 / Snapdragon Hexagon NPU：候选由模型概率与拼音约束生成，Rime 提供系统输入法界面。

**这是实验原型，准确率和完整的编辑上下文支持尚不能替代成熟输入法。**

## 当前实现

- 默认 Qwen3-1.7B Q4_0，使用 GenieX 的 `llama_cpp:npu` / HTP0；故障不自动降级 CPU。
- 最近 256 个上屏字符组成前文，整段重新分词，避免一两个字分次上屏影响分词。
- 网页和 Rime 请求携带各自前文；同一模型服务切换时恢复对应上下文。
- 模型下一 token 概率经过拼音过滤，多 token 词句按拼音继续补全。
- 严格拼音匹配，关闭上游默认模糊音；按匹配覆盖长度分组，用模型概率排序。
- Rime 通过常驻 Windows 命名管道连接服务，避免逐键启动 curl。
- 简洁横排候选窗，浅色/深色主题，自动测试和分阶段性能日志。

## 本机启动

要求：Windows ARM64、受 GenieX 支持的 Qualcomm NPU、原生 ARM64 Node.js、可用于安装包的 Python/pip、PowerShell。

```powershell
./setup.ps1
./start.ps1
./open-demo.ps1
# 停止两个本地服务
./stop.ps1
```

`setup.ps1` 将运行时和 GenieX 下载至 `work/`，按固定版本下载模型至 `models/` 并校验 SHA-256，安装 LIME 依赖，生成本地密钥、网页和 Rime 配置。它不会注册系统输入法或自动安装小狼毫。首次设置需要网络；安装后的推理只在本机运行。

网页地址：http://127.0.0.1:5000/try.html 。切到英文键盘，输入拼音，空格选首项，数字 1–9 选词。可以设置上下文测试消歧。

## Rime 接入

先安装 [官方小狼毫](https://github.com/rime/weasel/releases)，注册 Windows 输入法的管理员确认由用户完成。然后：

```powershell
python work/stage_rime.py
```

生成文件来自 `lime/rime/`，本地含密钥的副本放在 `outputs/rime-npu/`；部署脚本复制到 `%APPDATA%/Rime`。如果已有 `default.custom.yaml`，脚本会保留它，请将 `llm` 加入原有 schema_list。在小狼毫中执行“重新部署”，按 F4 或 Ctrl+反引号选择“大模型拼音”。

可选扁平主题：将生成的 `weasel.custom.yaml` 合并到 Rime 用户目录，再重新部署；不要覆盖自己的已有设置。

## 配置

```powershell
$env:LIME_CONTEXT_CHARS='256'
# 需要先自行下载兼容的 Q4_0 GGUF；分词器和 NPU 使用同一模型。
$env:LIME_MODEL='Qwen3-1.7B-Q4_0.gguf'
./start.ps1
```

Rime 的 `llm_context/history_chars` 也需与服务窗口一致。Node 仅加载模型词表，不创建 CPU 推理上下文。GenieX 的 Python 包由 ARM64 嵌入 Python 加载，避免 x64 Python 无法加载 ARM64 DLL。

## 测试和日志

```powershell
python work/quality_benchmark.py local
python work/test_context_npu.py
python work/benchmark.py
```

Rime 引擎测试还需 `work/weasel-all/` 中的小狼毫 x64 DLL 和 data 文件（从官方安装包用 7-Zip 提取）：

```powershell
python work/test_rime_npu.py
python work/test_rime_short_context.py
```

测试使用预设文本，会更新测试客户端上下文。日志在 `work/performance.jsonl`、`work/server*.log` 和 `work/npu-server*.log`；其中可能包含输入文字，默认不提交到 Git。`npu_request`、`model_evaluate`、`candidate_filter`、`lock_wait` 分别帮助定位推理、后处理与等待时间。

Snapdragon X Elite 上一次短时调试样本：缓存候选更新约 5–29 ms，新多 token 补全约 116–133 ms。18 个手选调试用例首选符合预期，**不代表通用准确率，也不证明大模型一定更准**。性能会随上下文和输入长度变化。

## 已知限制与开发方向

- 多 token 补词主要走一条路径，需要多路径搜索、整句比较和更可靠的拼音切分。
- 没有完整获取光标附近的文档内容；删除、移动光标、粘贴和已有文字尚未同步。
- 近期前文是会话内的上屏记录，不是用户文档的权威副本。
- `forward_logits` 会清空原生 KV；当前缓存复用相同 token 前缀的结果，不是跨滑动窗口的增量 KV 复用。
- 下一步重点：候选搜索、用户选词学习、上下文同步、增量推理与延迟预算。

## 安全与许可证

服务仅监听本机并要求本地访问密钥。不要上传 `work/local-key.txt`、`lime/key.txt`、生成的试打 HTML、生成的 Rime Lua、输入日志或环境变量。模型、运行环境和依赖二进制不随代码分发。

本项目及修改遵循 GPL-3.0，保留上游历史、许可证和来源。详见 [UPSTREAM.md](UPSTREAM.md) 和 [LICENSE](LICENSE)。模型、GenieX、Rime 和其他依赖遵循各自许可证。
