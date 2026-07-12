export const usage: string = `
<h1>Counter-Strike 2 更新日志推送</h1>

<p>🎯 自动监控 CS2 官方 Steam 新闻，记录全局 <code>gid</code> 与失败目标快照，并将更新日志与官方公告推送到指定频道或 QQ 群。</p>

<p>
  <a href="https://www.npmjs.com/package/koishi-plugin-cs2-update-log" target="_blank">
    <img src="https://img.shields.io/npm/v/koishi-plugin-cs2-update-log?style=flat-square&logo=npm" alt="npm version">
  </a>
  <a href="https://github.com/BestBcz/koishi-cs2-update-log" target="_blank">
    <img src="https://img.shields.io/badge/GitHub-cs2--update--log-181717?style=flat-square&logo=github" alt="GitHub">
  </a>
  <a href="https://forum.koishi.xyz/t/topic/12652" target="_blank">
    <img src="https://img.shields.io/badge/Koishi%20Forum-12652-5546A3?style=flat-square" alt="Koishi Forum">
  </a>
</p>

<h2>⌨️ 可用命令</h2>
<ul>
  <li>🔍 <code>cs2log.check</code>：在当前会话查看最近最多 5 条官方新闻的分类、时间、gid 与原文链接。</li>
  <li>📨 <code>cs2log.push</code>：向配置目标补发历史失败内容，并立即推送尚未处理的新内容。</li>
  <li>🧪 <code>cs2log.test</code>：在当前会话测试发送最近最多 2 条完整新闻，不写入投递状态。</li>
  <li>🤖 <code>cs2log.ai</code>：在当前会话生成并发送一条合并的 LLM 新闻摘要。</li>
  <li>📡 <code>cs2log.ai --broadcast</code>：将同一份摘要发送到当前会话与配置目标，并自动去重。</li>
</ul>

<p>💡 实际新闻数量受 <code>count</code> 限制；完整的发送范围、LLM、图片与 state 行为请查看 README。</p>

<details>
<summary><b>📚 展开完整配置、运行流程与故障排查</b></summary>

<h2>🚀 快速配置</h2>
<ol>
  <li>在「🎯 推送目标与策略」中新增一行目标。</li>
  <li><code>platform</code> 填机器人平台，OneBot 用户通常保持 <code>onebot</code>。</li>
  <li><code>selfId</code> 可留空；多机器人场景建议填写，避免选中错误账号。</li>
  <li><code>channelId</code> 填目标频道 ID；OneBot QQ 群通常直接填写群号。</li>
  <li>需要普通新闻翻译时开启 <code>enableLlmTranslate</code>；需要手动摘要时开启 <code>enableLlmSummary</code>。</li>
  <li>填写共用的 <code>llmApiKey</code>、<code>llmApiEndpoint</code>、<code>llmModel</code>，并选择正确的 <code>llmApiFormat</code>。</li>
  <li>默认 <code>fontPath</code> 无需修改，插件会自动将展示的 cwd 路径映射到 <code>ctx.baseDir/data/fonts</code>。</li>
</ol>

<p>💡 <code>enableLlmSummary</code> 默认关闭，且只控制手动 <code>cs2log.ai</code>，不会让 RSS 自动轮询额外生成摘要。</p>

<h2>⚙️ 服务依赖</h2>
<ul>
  <li>✅ <b>http</b>：必需，用于读取 Steam 新闻，以及调用 OpenAI-compatible 或 Anthropic 格式的 LLM 接口。</li>
  <li>🖼️ <b>puppeteer</b>：可选，仅在开启 <code>picture</code> 长图模式时使用。</li>
  <li>📝 未启用 Puppeteer 或长图渲染失败时，插件会自动降级为纯文本推送。</li>
</ul>

<h3>🔄 工作流程</h3>
<ol>
  <li>⏱️ 按 <code>interval</code> 周期检查 CS2 官方新闻。</li>
  <li>🌐 优先从 Steam Fastly RSS 与 Steam Web API 获取数据，必要时回退到 Steam Store RSS。</li>
  <li>🏷️ 根据标题和正文分区，将内容分类为「官方更新日志」或「官方公告」。</li>
  <li>💾 使用全局 <code>gid</code> 判断新闻是否已进入正式流程，并用失败快照记录尚未收到的目标。</li>
  <li>🌏 按需翻译、渲染长图，再按配置策略向目标发送。</li>
  <li>✅ 成功目标不会进入失败队列，失败目标则保留到手动 <code>cs2log.push</code> 补发。</li>
</ol>

<h3>⏱️ 轮询与状态</h3>
<ul>
  <li><code>interval</code>：轮询间隔，默认 30 秒，最小 5 秒。</li>
  <li><code>count</code>：每次拉取数量，默认 5 条；AI 摘要数量为 <code>min(count, 5)</code>。</li>
  <li><code>stateFile</code>：保存初始化状态、全局 gid 与按目标失败快照的文件路径。</li>
  <li><code>pushOnFirstRun</code>：首次启动是否推送当前已存在的历史内容。</li>
</ul>

<p>🌱 默认 <code>pushOnFirstRun = false</code>。state 尚未初始化时会建立历史基线，但不会一次性推送旧公告。旧版全局 <code>gids</code> 会兼容迁移为当前目标均已收到，避免升级后突然重发历史内容。</p>

<h3>🎯 推送目标与部分失败策略</h3>
<ul>
  <li><code>allowPartialAutoPush</code>：自动推送遇到失败目标时，是否继续发送其他目标，默认开启。</li>
  <li><code>allowPartialManualPush</code>：手动 <code>cs2log.push</code> 遇到失败目标时，是否继续处理其他目标，默认开启。</li>
  <li><code>allowPartialAiBroadcast</code>：AI 广播遇到失败目标时，是否继续发送其他目标，默认开启。</li>
</ul>

<p>开启部分失败策略后，正式新闻会按目标记录成功结果。自动推送失败的目标不会被定时器反复补发；管理员下次执行 <code>cs2log.push</code> 时，会先按发布时间从旧到新补发历史失败内容，再按同一顺序处理新内容，已经成功的目标不会重复收到。</p>
<p>关闭对应策略时，发送前发现目标不可用会取消该次操作。若目标在实际发送过程中突然失败，已经成功发送的消息无法回滚，插件会按真实结果记录或报告。</p>
<p>AI 广播不写 state，也不保存旧摘要任务；失败目标会显示在本次统计中，需要时可重新执行命令。</p>

<h3>🖼️ 图片显示</h3>
<ul>
  <li><code>brandName</code> 与 <code>siteName</code> 控制新闻和摘要卡片的顶部、底部文字。</li>
  <li><code>picture</code> 控制长图或纯文本模式，新闻摘要会合并为一张长图。</li>
  <li><code>fontPath</code>：LXGW WenKai Mono 字体路径；默认展示 <code>process.cwd()/data/fonts/LXGWWenKaiMono-Regular.ttf</code>，运行时映射到 <code>ctx.baseDir/data/fonts/LXGWWenKaiMono-Regular.ttf</code>。</li>
  <li><code>appendLink</code> 控制长图成功时是否追加真实 Steam 来源链接。</li>
</ul>

<p>✍️ 默认托管字体缺失或校验失败时，插件会依次尝试 <a href="https://gitee.com/vincent-zyu/koishi-plugin-awa-quote-image/releases/download/fonts/LXGWWenKaiMono-Regular.ttf" target="_blank">Gitee</a> 与 <a href="https://github.com/VincentZyuApps/koishi-plugin-awa-quote-image/releases/download/fonts/LXGWWenKaiMono-Regular.ttf" target="_blank">GitHub</a>。下载内容通过文件大小与多重 hash 校验后才会使用，并采用临时文件原子替换。</p>
<p>自定义 <code>fontPath</code> 会被严格使用，读取失败时不会切回默认 LXGW，而是记录错误并使用系统字体继续出图。只有 Puppeteer 不可用或截图失败时才降级纯文本。字体失败结果会缓存 5 分钟，避免批量新闻重复等待下载超时，之后会自动重试。手动 <code>push/test/ai</code> 会在当前会话提示 fallback，自动轮询只写日志。LXGW WenKai 遵循 SIL Open Font License 1.1。</p>

<h3>🤖 LLM 设置与双协议</h3>
<ul>
  <li><code>enableLlmTranslate</code> 控制普通自动推送、<code>push</code> 与 <code>test</code> 的翻译。</li>
  <li><code>enableLlmSummary</code> 只控制手动 <code>cs2log.ai</code> 与 <code>--broadcast</code>。</li>
  <li><code>llmApiFormat</code> 支持 <code>openai</code> Chat Completions 和 <code>anthropic</code> Messages API。</li>
  <li><code>llmApiKey</code>、<code>llmApiEndpoint</code>、<code>llmModel</code> 由翻译和摘要共用。</li>
  <li><code>llmMaxTokens</code> 默认 10240；摘要内容较多或模型启用思考时可适当提高。</li>
  <li><code>llmTranslatePrompt</code> 约束逐篇翻译，<code>llmSummaryPrompt</code> 决定合并摘要的内容、格式与输出语言。</li>
</ul>

<p>默认使用 DeepSeek 基础地址 <code>https://api.deepseek.com</code> 与模型 <code>deepseek-v4-flash</code>。配置可以只填写服务根地址：Anthropic 自动补 <code>/v1/messages</code>，OpenAI 自动补 <code>/v1/chat/completions</code>；已有完整端点时保持原样。OpenAI 格式默认使用兼容服务常见的 <code>max_tokens</code>，接口明确拒绝时会自动改用 <code>max_completion_tokens</code> 重试一次。LLM 请求失败时，普通新闻翻译会回退原文；AI 摘要命令则返回明确错误，不会写入 state。</p>

<h3>⌨️ 命令权限</h3>
<ul>
  <li><code>checkCommandAuthority</code> 默认 1。</li>
  <li><code>pushCommandAuthority</code>、<code>testCommandAuthority</code>、<code>aiCommandAuthority</code> 默认 2。</li>
  <li><code>aiBroadcastAuthority</code> 默认 2，并独立保护 <code>--broadcast</code> 选项。</li>
</ul>

<h3>🛠️ 常见问题</h3>
<h4>没有自动推送</h4>
<ul>
  <li>检查 <code>targets</code> 是否至少配置一项，以及平台、账号与频道 ID 是否正确。</li>
  <li>使用 <code>cs2log.check</code> 验证 Steam 数据源是否可读取，并查看日志中的目标发送错误。</li>
  <li>首次启动默认只建立历史基线，不会立即推送旧新闻。</li>
</ul>

<h4>只收到纯文本</h4>
<ul>
  <li>确认 <code>picture</code> 已开启，并安装、启用了 Puppeteer 服务。</li>
  <li>长图渲染失败不会阻断普通新闻发送，会自动降级为纯文本。</li>
</ul>

<h4>图片使用了系统字体</h4>
<ul>
  <li>默认路径请检查网络、<code>ctx.baseDir/data/fonts</code> 写入权限，以及 Gitee/GitHub 下载日志。</li>
  <li>自定义 <code>fontPath</code> 不会自动回退默认 LXGW，请自行修正文件路径或恢复配置默认值。</li>
</ul>

<h4>LLM 没有生效</h4>
<ul>
  <li>确认对应的 <code>enableLlmTranslate</code> 或 <code>enableLlmSummary</code> 已开启。</li>
  <li>核对 <code>llmApiFormat</code>、接口地址、API Key、模型名、输出上限与账户额度。</li>
  <li>从旧版本升级后，请将已删除的 <code>trans</code>、<code>translate*</code> 字段迁移到新的 <code>enableLlmTranslate</code> 与 <code>llm*</code> 字段。</li>
</ul>

<h4>重启后重复推送或无法写入状态</h4>
<ul>
  <li>确认 <code>stateFile</code> 指向稳定、可写的位置。</li>
  <li>不要随意删除 state，也不要在多个互不共享的运行目录间切换该文件。</li>
</ul>

</details>

<h2>🔗 项目链接</h2>
<ul>
  <li>📦 npm：<a href="https://www.npmjs.com/package/koishi-plugin-cs2-update-log" target="_blank">koishi-plugin-cs2-update-log</a></li>
  <li>💻 GitHub：<a href="https://github.com/BestBcz/koishi-cs2-update-log" target="_blank">BestBcz/koishi-cs2-update-log</a></li>
  <li>💬 Koishi 论坛：<a href="https://forum.koishi.xyz/t/topic/12652" target="_blank">插件交流帖 #12652</a></li>
</ul>

<p>📜 问题反馈与改进建议请优先前往项目仓库或论坛帖子。</p>
`
