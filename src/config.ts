import { Schema } from 'koishi'

import { DEFAULT_LXGW_WENKAI_PATH } from './font'

export type LlmApiFormat = 'openai' | 'anthropic'

export interface TargetConfig {
  platform: string // 🤖 目标机器人平台
  selfId?: string // 🪪 可选机器人账号 ID
  channelId: string // 📨 目标频道 ID 或 QQ 群号
  enabled?: boolean // ✅ 是否启用此目标
}

export interface Config {
  // ===== 💬 会话设置 =====
  enableQuote: boolean // 💬 是否引用触发指令的消息
  enableWaitingHint: boolean // ⏳ 是否显示等待提示

  // ===== ⏱️ 轮询与状态 =====
  interval: number // ⏱️ Steam 新闻轮询间隔
  count: number // 📰 单次拉取新闻数量
  stateFile: string // 💾 gid 与失败目标状态文件
  pushOnFirstRun: boolean // 🚀 首次启动是否推送历史内容

  // ===== 🎯 推送目标与策略 =====
  targets: TargetConfig[] // 📬 机器人与目标频道列表
  allowPartialAutoPush: boolean // 🚚 自动推送是否允许部分目标失败
  allowPartialManualPush: boolean // 🛠️ 手动推送是否允许部分目标失败
  allowPartialAiBroadcast: boolean // 🤖 AI 广播是否允许部分目标失败

  // ===== 🖼️ 图片显示 =====
  brandName: string // 🏷️ 卡片顶部品牌名
  siteName: string // 🌐 卡片底部站点名
  picture: boolean // 🖼️ 是否启用 Puppeteer 长图
  fontPath: string // ✍️ LXGW WenKai Mono 字体路径
  appendLink: boolean // 🔗 长图后是否追加原文链接
  showAiSummaryCardSources: boolean // 📇 AI 摘要卡片内是否展示 SOURCES
  showAiSummaryTextSources: boolean // 📋 AI 摘要图片后是否追加 SOURCES 文字

  // ===== 🤖 LLM 设置 =====
  enableLlmTranslate: boolean // 🌏 是否启用普通新闻 LLM 翻译
  enableLlmSummary: boolean // 🧠 是否启用手动 LLM 摘要命令
  llmApiFormat: LlmApiFormat // 🔌 LLM API 请求格式
  llmApiKey: string // 🔑 LLM API Key
  llmApiEndpoint: string // 🌐 LLM API 基础地址或完整端点
  llmModel: string // 🧠 LLM 模型名
  llmMaxTokens: number // 📏 LLM 最大输出 Token 数
  llmTranslateTimeout: number // ⏳ 普通新闻翻译超时秒数
  llmSummaryTimeout: number // ⌛ AI 摘要超时秒数
  llmTranslatePrompt: string // 📝 翻译系统提示词
  llmSummaryPrompt: string // 📚 合并摘要系统提示词

  // ===== ⌨️ 命令权限 =====
  checkCommandAuthority: number // 🔍 cs2log.check 权限等级
  pushCommandAuthority: number // 📢 cs2log.push 权限等级
  testCommandAuthority: number // 🧪 cs2log.test 权限等级
  aiCommandAuthority: number // 🤖 cs2log.ai 权限等级
  aiBroadcastAuthority: number // 📡 --broadcast 选项权限等级
}

export const Config: Schema<Config> = Schema.intersect([
  // ===== 💬 会话设置 =====
  Schema.object({
    enableQuote: Schema.boolean()
      .default(true)
      .description('💬 bot 发送消息时，是否引用触发指令的消息<br><i>仅对通过指令触发的被动消息生效；定时轮询等主动推送不受影响。</i>'),
    enableWaitingHint: Schema.boolean()
      .default(true)
      .description('⏳ 是否在执行指令前发送等待提示<br><i>提示会在指令执行完成后自动撤回；仅对被动指令消息生效。</i>'),
  }).description('💬 会话设置 ⚙️'),

  // ===== ⏱️ 轮询与状态 =====
  Schema.object({
    interval: Schema.number()
      .min(5)
      .step(1)
      .default(30)
      .description('⏱️ 轮询 Steam 官方新闻的间隔，单位：秒'),
    count: Schema.number()
      .min(1)
      .max(100)
      .step(1)
      .default(5)
      .description('📰 每次从 Steam 拉取的新闻数量，范围：1～100<br><i>cs2log.ai 最多总结 5 条，并同时受此配置限制。</i>'),
    stateFile: Schema.string()
      .default('.koishi-cs2-update-log.json')
      .description('💾 本地 gid 与失败目标状态文件路径<br><i>正式新闻进入投递流程后记录全局 gid，未送达目标另存失败快照；相对路径基于 Koishi 启动目录解析。</i>'),
    pushOnFirstRun: Schema.boolean()
      .default(false)
      .description('🚀 首次启动时是否推送已拉取到的历史内容<br><i>默认关闭，仅建立历史状态，避免首次启用时刷屏。</i>'),
  }).description('⏱️ 轮询与状态 💾'),

  // ===== 🎯 推送目标与策略 =====
  Schema.object({
    targets: Schema.array(
      Schema.object({
        platform: Schema.string()
          .default('onebot')
          .description('🤖 目标机器人平台，例如 onebot'),
        selfId: Schema.string()
          .description('🪪 机器人账号 ID (留空时使用该平台第一个可用机器人)'),
        channelId: Schema.string()
          .required()
          .description('📨 目标频道 ID 或 QQ 群号'),
        enabled: Schema.boolean()
          .default(true)
          .description('✅ 是否启用此推送目标<br><i>关闭后该目标不出现在自动/手动推送与 AI 广播中。</i>'),
      }),
    )
      .role('table')
      .default([
        {
          platform: 'onebot',
          selfId: '3967912008',
          channelId: '1085190201',
          enabled: true,
        },
      ])
      .description('🎯 正式新闻与 AI 广播的目标列表<br><i>cs2log.ai --broadcast 会将此列表与当前会话合并，并自动去重。</i>'),
    allowPartialAutoPush: Schema.boolean()
      .default(true)
      .description('🚚 自动轮询推送时是否允许部分目标失败<br><i>开启后跳过失败目标并继续发送其他目标；失败记录等待手动 cs2log.push 补发。</i>'),
    allowPartialManualPush: Schema.boolean()
      .default(true)
      .description('🛠️ 手动执行 cs2log.push 时是否允许部分目标失败<br><i>开启后会继续处理其他目标，并保留仍未送达的目标记录。</i>'),
    allowPartialAiBroadcast: Schema.boolean()
      .default(true)
      .description('📡 执行 cs2log.ai --broadcast 时是否允许部分目标失败<br><i>AI 摘要不写入 gid state，失败目标会在本次结果中报告。</i>'),
  }).description('🎯 推送目标与策略 📬'),

  // ===== 🖼️ 图片显示 =====
  Schema.object({
    brandName: Schema.string()
      .default('CS2 update')
      .description('🏷️ 公告与摘要长图顶部显示的品牌名'),
    siteName: Schema.string()
      .default('Github仓库')
      .description('🌐 公告与摘要长图底部显示的站点名'),
    picture: Schema.boolean()
      .default(true)
      .description('🖼️ 是否使用 Puppeteer 渲染长图<br><i>关闭后发送纯文本；未检测到 Puppeteer 或渲染失败时也会自动降级。</i>'),
    fontPath: Schema.string()
      .role('textarea', { rows: [2, 5] })
      .default(DEFAULT_LXGW_WENKAI_PATH)
      .description('✍️ LXGW WenKai Mono 字体文件路径<br><i>默认展示 process.cwd()/data/fonts/LXGWWenKaiMono-Regular.ttf，运行时自动映射到 ctx.baseDir/data/fonts/LXGWWenKaiMono-Regular.ttf。</i><br><i>默认字体缺失或校验失败时依次从 Gitee、GitHub 下载；自定义路径会严格按填写值读取，不会回退到默认 LXGW。</i>'),
    appendLink: Schema.boolean()
      .default(true)
      .description('🔗 长图发送成功时，是否追加 Steam 原文链接<br><i>纯文本与渲染降级消息始终包含原文链接。</i>'),
    showAiSummaryCardSources: Schema.boolean()
      .default(true)
      .description('📇 AI 摘要卡片图片内是否展示 SOURCES 来源段落<br><i>关闭后卡片只保留摘要正文，不显示右上角来源计数与底部来源列表。</i>'),
    showAiSummaryTextSources: Schema.boolean()
      .default(false)
      .description('📋 AI 摘要图片发送后是否追加 SOURCES 文字消息<br><i>关闭后只发图片不发来源文字；纯文本降级模式下同样生效。</i>'),
  }).description('🖼️ 图片显示 🎨'),

  // ===== 🤖 LLM 设置 =====
  Schema.object({
    enableLlmTranslate: Schema.boolean()
      .default(false)
      .description('🌏 是否使用 LLM 翻译普通新闻<br><i>关闭时直接推送 Steam 返回的原文；翻译失败时也会保留原文继续推送。</i>'),
    enableLlmSummary: Schema.boolean()
      .default(false)
      .description('🧠 是否启用 cs2log.ai 手动摘要命令<br><i>此配置不参与 RSS 自动轮询，默认关闭以避免升级后意外产生调用费用。</i>'),
    llmApiFormat: Schema.union([
      Schema.const('openai').description('🟢 OpenAI-compatible Chat Completions'),
      Schema.const('anthropic').description('🟠 Anthropic Messages API'),
    ])
      .role('radio')
      .default('openai')
      .description('🔌 LLM API 请求与响应格式<br><i>Anthropic 自动补 /v1/messages，OpenAI 自动补 /v1/chat/completions。</i>'),
    llmApiKey: Schema.string()
      .role('secret')
      .description('🔑 翻译与摘要共用的 LLM API Key<br><i>启用任一 LLM 功能时必填，请妥善保护配置文件。</i>'),
    llmApiEndpoint: Schema.string()
      .role('link')
      .default('https://api.deepseek.com')
      .description('🌐 LLM 基础地址或完整端点<br><i>可直接填写服务根地址；已有 /v1/messages 或 /v1/chat/completions 等完整路径时保持原样。</i>'),
    llmModel: Schema.string()
      .default('deepseek-v4-flash')
      .description('🧠 翻译与摘要共用的模型名<br><i>默认使用 DeepSeek-V4-Flash。</i>'),
    llmMaxTokens: Schema.number()
      .min(32)
      .max(102400)
      .step(1)
      .default(10240)
      .description('📏 单次 LLM 请求允许生成的最大 Token 数<br><i>范围：32～102400；摘要内容较多或模型启用思考时需要适当提高。</i>'),
    llmTranslateTimeout: Schema.number()
      .min(30)
      .max(3600)
      .step(30)
      .default(600)
      .description('⏳ 普通新闻 LLM 翻译超时，单位：秒<br><i>范围：30～3600；超时后自动使用原文，手动指令会显示回退原因。</i>'),
    llmSummaryTimeout: Schema.number()
      .min(30)
      .max(3600)
      .step(30)
      .default(600)
      .description('⌛ cs2log.ai 摘要请求超时，单位：秒<br><i>范围：30～3600；长摘要或思考模型可能需要更长时间。</i>'),
    llmTranslatePrompt: Schema.string()
      .role('textarea')
      .default('你是一个专业的游戏公告翻译助手。请将 CS2 Steam 官方公告翻译为简体中文，保留 Markdown 结构、更新分区、列表、粗体、行内代码和代码块，不要添加原文没有的解释。')
      .description('📝 普通新闻翻译系统提示词<br><i>建议保留 Markdown 结构与忠实原意的要求。</i>'),
    llmSummaryPrompt: Schema.string()
      .role('textarea')
      .default('你是一个专业的游戏新闻编辑。请将提供的最近几条 CS2 Steam 官方新闻翻译并整合为一份完整的 Markdown 摘要，默认使用简体中文。请先给出整体概览，再按新闻逐条列出翻译后的标题与核心变化，保留重要版本、地图、武器和赛事信息，不要编造原文没有的内容，也不要使用 Markdown 代码围栏包裹最终结果。')
      .description('📚 cs2log.ai 合并摘要系统提示词<br><i>摘要语言由此提示词决定，可改为英文或其他语言要求。</i>'),
  }).description('🤖 LLM 设置 🌐'),

  // ===== ⌨️ 命令权限 =====
  Schema.object({
    checkCommandAuthority: Schema.number()
      .min(0)
      .max(5)
      .step(1)
      .default(1)
      .description('🔍 cs2log.check 所需权限等级'),
    pushCommandAuthority: Schema.number()
      .min(0)
      .max(5)
      .step(1)
      .default(2)
      .description('📢 cs2log.push 所需权限等级<br><i>该命令会向配置 targets 正式推送并更新 gid state。</i>'),
    testCommandAuthority: Schema.number()
      .min(0)
      .max(5)
      .step(1)
      .default(2)
      .description('🧪 cs2log.test 所需权限等级<br><i>可能调用 LLM 与 Puppeteer，并连续发送最多 2 条内容。</i>'),
    aiCommandAuthority: Schema.number()
      .min(0)
      .max(5)
      .step(1)
      .default(2)
      .description('🤖 cs2log.ai 所需权限等级<br><i>该命令会产生一次 LLM 调用。</i>'),
    aiBroadcastAuthority: Schema.number()
      .min(0)
      .max(5)
      .step(1)
      .default(2)
      .description('📡 cs2log.ai --broadcast 选项所需权限等级<br><i>会向当前会话与配置 targets 的并集发送完整摘要。</i>'),
  }).description('⌨️ 命令权限 🛡️'),
])
