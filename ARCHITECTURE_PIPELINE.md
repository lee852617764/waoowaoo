# waoowaoo - 从文本到AI视频的完整技术工作流全生命周期方案

> 本文档基于项目源码 `waoowaoo` 的完整技术实现，系统描述从小说/文本输入到最终AI视频输出的全生命周期技术架构、数据流转、提示词工程及执行细节。
>
> 版本: v0.4.1 | 日期: 2026-04-22

---

## 目录

1. [架构概览](#1-架构概览)
2. [数据模型](#2-数据模型)
3. [核心工作流总览](#3-核心工作流总览)
4. [第一阶段：Story-to-Script（故事解析与分镜脚本）](#4-第一阶段story-to-script故事解析与分镜脚本)
5. [第二阶段：Script-to-Storyboard（故事板与面板设计）](#5-第二阶段script-to-storyboard故事板与面板设计)
6. [第三阶段：媒体生成流水线](#6-第三阶段媒体生成流水线)
7. [第四阶段：视频组装与导出](#7-第四阶段视频组装与导出)
8. [任务调度与执行引擎](#8-任务调度与执行引擎)
9. [AI模型网关与多供应商路由](#9-ai模型网关与多供应商路由)
10. [资产中心与视觉一致性](#10-资产中心与视觉一致性)
11. [存储与媒体对象管理](#11-存储与媒体对象管理)
12. [计费与成本追踪](#12-计费与成本追踪)
13. [错误处理与恢复机制](#13-错误处理与恢复机制)
14. [架构守护脚本](#14-架构守护脚本)
15. [附录A：完整提示词模板](#附录a完整提示词模板)
16. [附录B：文件索引](#附录b文件索引)

---

## 1. 架构概览

### 1.1 技术栈

| 层级 | 技术选型 |
|------|---------|
| 前端框架 | Next.js 15 (App Router) + React 19 + TypeScript |
| 样式 | Tailwind CSS v4 |
| 数据库 | MySQL 8 + Prisma ORM |
| 任务队列 | Redis + BullMQ |
| 存储 | MinIO (S3-compatible) / 本地文件系统 |
| 认证 | NextAuth.js v4 |
| 国际化 | next-intl (zh / en) |
| 视频渲染 | Remotion |
| 测试 | Vitest (fork pool, 30s timeout) |

### 1.2 多进程运行时架构

生产环境由四个并发进程组成：

```
+----------------------+----------------------+----------------------+----------------------+
|   Next.js Web Server |   Workers (BullMQ)   |   Watchdog 监控进程   |   Bull Board 管理UI  |
|        :3000         |                      |                      |       :3010          |
+----------------------+----------------------+----------------------+----------------------+
| 页面/API路由          | 图像队列 (并发20)     | 心跳检测 (60s周期)   | 队列状态可视化        |
| SSE流推送             | 视频队列 (并发4)      | 僵死任务恢复         | 任务重试管理          |
|                      | 语音队列 (并发10)     | Run级恢复            |                      |
|                      | 文本队列 (并发10)     | 定时对账             |                      |
+----------------------+----------------------+----------------------+----------------------+
```

### 1.3 核心子系统关系

```
+-------------------+    +-------------------+    +-------------------+    +-------------------+
|    前端层          |    |     API层          |    |     业务层         |    |     数据层         |
| Next.js App Router |--->| novel-promotion/* |--->| novel-promotion/  |--->|  MySQL (Prisma)   |
| [locale]/*         |    | asset-hub/*       |    | workflow-engine/  |    |  Redis (BullMQ)   |
| editor/*           |    | task-target-states|    | run-runtime/      |    |  MinIO/Local      |
+-------------------+    | runs/*            |    | task/             |    +-------------------+
                         +-------------------+    | workers/          |
                                                  | model-gateway/    |
                                                  | ai-runtime/       |
                                                  | assets/           |
                                                  | storage/          |
                                                  | billing/          |
                                                  +-------------------+
```

---

## 2. 数据模型

### 2.1 核心领域模型

`NovelPromotionProject` 是顶层聚合根，一个项目包含多个 `Episode`，每个 `Episode` 经历从文本到视频的完整转换：

```prisma
model NovelPromotionProject {
  id              String  @id @default(uuid())
  projectId       String  @unique
  analysisModel   String? // AI分析模型 (如 "openai::gpt-4o")
  imageModel      String? // 图像生成模型
  videoModel      String? // 视频生成模型
  audioModel      String? // 音频/TTS模型
  videoRatio      String  @default("9:16")
  ttsRate         String  @default("+50%")
  artStyle        String  @default("american-comic")
  artStylePrompt  String?
  characterModel  String? // 角色图像专用模型
  locationModel   String? // 场景图像专用模型
  storyboardModel String? // 故事板图像模型
  editModel       String? // 编辑/修改模型
  videoResolution String  @default("720p")
  workflowMode    String  @default("srt")
  imageResolution String  @default("2K")
  characters      NovelPromotionCharacter[]
  episodes        NovelPromotionEpisode[]
  locations       NovelPromotionLocation[]
}

model NovelPromotionEpisode {
  id            String  @id @default(uuid())
  episodeNumber Int
  name          String
  novelText     String? // 原始小说文本
  srtContent    String? // 字幕内容
  speakerVoices String? // JSON: { "speakerName": { "provider": "fal", "audioUrl": "..." } }
  clips         NovelPromotionClip[]
  storyboards   NovelPromotionStoryboard[]
  voiceLines    NovelPromotionVoiceLine[]
  editorProject VideoEditorProject?
}
```

### 2.2 转换产物模型

```prisma
model NovelPromotionClip {
  id         String  @id @default(uuid())
  episodeId  String
  start      Int?    // SRT文本边界起始索引
  end        Int?    // SRT文本边界结束索引
  summary    String  // AI生成的片段摘要
  location   String? // 检测到的场景名
  content    String  // 该片段原始文本
  characters String? // JSON: ["角色A", "角色B"]
  props      String? // JSON: ["道具A"]
  endText    String? // 边界结束文本（用于匹配）
  startText  String? // 边界起始文本（用于匹配）
  screenplay String? // JSON: 结构化分镜脚本（见下方示例）
  shotCount  Int?
  storyboard NovelPromotionStoryboard?
}

model NovelPromotionStoryboard {
  id                  String  @id @default(uuid())
  episodeId           String
  clipId              String  @unique // 1:1关联Clip
  panelCount          Int     @default(9)
  storyboardTextJson  String? // 故事板文本JSON
  storyboardImageUrl  String? // 故事板总览图
  imageHistory        String? // JSON: 历史图像URL数组
  candidateImages     String? // JSON: 候选图像URL数组
  photographyPlan     String? // JSON: 摄影规则
  panels              NovelPromotionPanel[]
}

model NovelPromotionPanel {
  id                    String  @id @default(uuid())
  storyboardId          String
  panelIndex            Int     // 在故事板中的位置
  panelNumber           Int?    // AI分配的编号
  shotType              String? // "close-up", "wide", "medium shot"等
  cameraMove            String? // "static", "pan", "zoom-in"等
  description           String? // 面板描述
  location              String? // 面板场景
  characters            String? // JSON: [{"name":"角色A","appearance":"初始形象","slot":"位置描述"}]
  props                 String?
  imagePrompt           String? // 图像生成提示词
  imageUrl              String? // 生成的图像URL
  imageMediaId          String? // MediaObject关联
  videoPrompt           String? // 视频生成提示词
  firstLastFramePrompt  String? // 首尾帧模式提示词
  videoUrl              String?
  videoMediaId          String?
  videoGenerationMode   String? // "normal" | "firstlastframe"
  lipSyncTaskId         String?
  lipSyncVideoUrl       String?
  lipSyncVideoMediaId   String?
  sketchImageUrl        String?
  sketchImageMediaId    String?
  previousImageUrl      String? // 上一次生成的图像（用于对比/回退）
  previousImageMediaId  String?
  srtSegment            String? // 字幕片段文本
  srtStart              Float?
  srtEnd                Float?
  duration              Float?  // 面板时长(秒)
  photographyRules      String? // JSON: {composition, lighting, colorPalette, atmosphere}
  actingNotes           String? // JSON: [{name:"角色A", acting:"表情描述"}]
  candidateImages       String? // JSON: ["url1", "url2"]
  linkedToNextPanel     Boolean @default(false)
}

model NovelPromotionVoiceLine {
  id                String  @id @default(uuid())
  episodeId         String
  lineIndex         Int
  speaker           String  // 说话角色名
  content           String  // 台词内容
  voicePresetId     String?
  audioUrl          String?
  audioMediaId      String?
  emotionPrompt     String? // TTS情感指令（如"愤怒的咆哮"）
  emotionStrength   Float?  @default(0.4) // 情感强度 0.0-1.0
  matchedPanelIndex Int?    // 匹配的面板索引
  matchedStoryboardId String?
  matchedPanelId    String?
  audioDuration     Int?    // 音频时长(ms)
}
```

### 2.3 阶段就绪检测

系统通过 `resolveEpisodeStageArtifacts()` 检测每个Episode的完成阶段：

```typescript
export type StageArtifactReadiness = {
  hasStory: boolean      // novelText 存在且非空
  hasScript: boolean     // clips 存在且至少一个含 screenplay
  hasStoryboard: boolean // storyboards 存在且至少一个含 panels
  hasVideo: boolean      // panels 存在且至少一个含 videoUrl
  hasVoice: boolean      // voiceLines 数组存在且长度>0
}
```

---

## 3. 核心工作流总览

整个 pipeline 分为 **两大工作流运行 (GraphRun)** 和 **多个独立媒体生成任务**：

```
Novel Text (用户上传的小说文本)
    │
    ▼
[Episode创建] ──► NovelPromotionEpisode.novelText
    │
    ▼
[可选: Episode拆分] ──► 多个 Episodes (NP_EPISODE_SPLIT)
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Workflow 1: STORY_TO_SCRIPT_RUN                                       │
│  任务类型: TASK_TYPE.STORY_TO_SCRIPT_RUN                               │
│  Worker: text.worker.ts → handleStoryToScriptTask                      │
│  编排器: story-to-script/orchestrator.ts                               │
│                                                                         │
│  Step 1: analyze_characters  ──► 角色档案JSON                           │
│  Step 2: analyze_locations   ──► 场景描述JSON                           │
│  Step 3: analyze_props       ──► 道具列表JSON                           │
│  Step 4: split_clips         ──► Clip边界数组 + 文本切片                 │
│  Step 5: screenplay_convert  ──► 每Clip结构化剧本JSON                    │
│  Step 6: persist_script_artifacts ──► 写入DB                            │
└─────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Workflow 2: SCRIPT_TO_STORYBOARD_RUN                                  │
│  任务类型: TASK_TYPE.SCRIPT_TO_STORYBOARD_RUN                          │
│  Worker: text.worker.ts → handleScriptToStoryboardTask                 │
│  编排器: script-to-storyboard/orchestrator.ts                          │
│                                                                         │
│  Per-Clip 3-Phase Process:                                              │
│  Phase 1 (plan_panels)        ──► 面板结构规划                          │
│  Phase 2a (cinematography)    ──► 摄影规则(构图/光影/色彩/氛围)          │
│  Phase 2b (acting_direction)  ──► 表演指导(表情/动作/视线)               │
│  Phase 3 (detail_panels)      ──► 细化面板 + video_prompt              │
│  voice_analyze                ──► 台词提取 + 面板匹配                   │
│  persist_storyboard_artifacts ──► 写入Storyboard + Panel + VoiceLine   │
└─────────────────────────────────────────────────────────────────────────┘
    │
    ├──► [IMAGE_PANEL task] × N panels ──► panel.imageUrl (图像队列, 并发20)
    │
    ├──► [VIDEO_PANEL task] × N panels ──► panel.videoUrl (视频队列, 并发4)
    │
    ├──► [VOICE_LINE task] × N lines ────► voiceLine.audioUrl (语音队列, 并发10)
    │
    ├──► [LIP_SYNC task] × N panels ─────► panel.lipSyncVideoUrl (视频队列)
    │
    ▼
[VideoEditorProject] ──► Remotion项目数据JSON (projectData)
    │
    ▼
[Remotion渲染] ────────► 最终视频 outputUrl
```

---

## 4. 第一阶段：Story-to-Script（故事解析与分镜脚本）

### 4.1 触发入口

| 属性 | 值 |
|------|-----|
| API路由 | `POST /api/novel-promotion/{projectId}/story-to-script-stream` |
| 任务类型 | `TASK_TYPE.STORY_TO_SCRIPT_RUN` |
| Worker | `src/lib/workers/text.worker.ts` → `handleStoryToScriptTask` |
| 编排器 | `src/lib/novel-promotion/story-to-script/orchestrator.ts` |
| AI模型 | 由 `resolveAnalysisModel()` 解析，来自 `project.analysisModel` |

### 4.2 工作流定义（依赖图）

```
                    ┌─────────────────┐
                    │  analyze_props  │
                    └────────┬────────┘
                             │
    ┌─────────────────┐      │      ┌─────────────────┐
    │analyze_characters│◄─────┼─────►│analyze_locations │
    └────────┬────────┘      │      └────────┬────────┘
             │               │               │
             └───────────────┼───────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   split_clips   │  ← 依赖前三步输出
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │screenplay_convert│  ← 每Clip并行执行
                    │  (per clip)     │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │persist_script_  │
                    │  artifacts      │  ← 纯持久化步骤
                    └─────────────────┘
```

**工作流定义文件**: `src/lib/workflow-engine/registry.ts:98-148`

| 步骤 | 依赖 | 可重试 | 产物类型 | artifactTypes |
|------|------|--------|---------|---------------|
| `analyze_characters` | 无 | 是 | `analysis.characters` | JSON角色数组 |
| `analyze_locations` | 无 | 是 | `analysis.locations` | JSON场景数组 |
| `analyze_props` | 无 | 是 | `analysis.props` | JSON道具数组 |
| `split_clips` | 前三步 | 是 | `clips.split` | Clip边界数组 |
| `screenplay_convert` | `split_clips` | 是 | `screenplay.clip` | 每Clip剧本JSON |
| `persist_script_artifacts` | `screenplay_convert` | 否 | 无 | DB持久化 |

### 4.3 编排器核心执行逻辑

**文件**: `src/lib/novel-promotion/story-to-script/orchestrator.ts:244-596`

```typescript
// 阶段1: 并行分析（角色 + 场景 + 道具）
const analysisResults = await mapWithConcurrency([
  () => runStepWithRetry(runStep, {stepId:'analyze_characters'}, characterPrompt, 'analyze_characters', 2200, safeParseJsonObject),
  () => runStepWithRetry(runStep, {stepId:'analyze_locations'}, locationPrompt, 'analyze_locations', 2200, safeParseJsonObject),
  () => runStepWithRetry(runStep, {stepId:'analyze_props'}, propPrompt, 'analyze_props', 1600, safeParseJsonObject),
], concurrency, async (run) => await run())

// 合并结果（新发现 + 已有库，避免覆盖丢失）
const mergedCharacterNames = [...analyzedCharacterNames, ...baseCharacters.filter(name => !analyzedNameSet.has(name))]
const charactersIntroduction = buildCharactersIntroduction(mergedCharacterIntroductions)

// 阶段2: 片段切分（带边界匹配重试，最多2次）
for (let attempt = 1; attempt <= MAX_SPLIT_BOUNDARY_ATTEMPTS; attempt++) {
  const matcher = createClipContentMatcher(content)
  for (const item of rawClipList) {
    const match = matcher.matchBoundary(startText, endText, searchFrom)
    // L1精确匹配 → L2标点变体 → L3近似匹配
    if (!match) { failedAt = ...; break }
    clipList.push({ id, startText, endText, summary, location, characters, props, content, matchLevel, matchConfidence })
    searchFrom = match.endIndex
  }
}

// 阶段3: 剧本转换（每Clip并行，受并发限制）
const screenplayResults = await mapWithConcurrency(clipList, concurrency, async (clip, index) => {
  const { parsed: screenplay } = await runStepWithRetry(
    runStep, {stepId: `screenplay_${clip.id}`}, screenplayPrompt,
    'screenplay_conversion', 2200, parseScreenplayObject
  )
  return { clipId: clip.id, success: true, sceneCount: scenes.length, screenplay }
})
```

### 4.4 提示词变量与模板系统

所有提示模板通过 `buildPrompt({ promptId, locale, variables })` 动态渲染。

**提示词目录**: `lib/prompts/novel-promotion/`（双语：`.en.txt` / `.zh.txt`）

#### 4.4.1 角色分析提示词 (`NP_AGENT_CHARACTER_PROFILE`)

**变量**: `{input}`, `{characters_lib_info}`

**核心指令**:
- 识别应在视觉上出现的角色
- 排除纯背景路人和抽象实体
- 解析别名/称号映射（如 "my husband", "boss", "I"）
- 第一人称叙事需明确 "I" 映射到谁

**输出JSON结构**:
```json
{
  "characters": [
    {
      "name": "Canonical Name",
      "aliases": ["alias 1"],
      "introduction": "Role, perspective mapping, relationships",
      "gender": "male/female/other",
      "age_range": "young adult",
      "role_level": "S",
      "archetype": "character archetype",
      "personality_tags": ["tag1"],
      "era_period": "modern/fantasy/historical/sci-fi",
      "social_class": "elite/middle/common",
      "occupation": "occupation",
      "costume_tier": 3,
      "suggested_colors": ["color1"],
      "primary_identifier": "signature visual marker",
      "visual_keywords": ["keyword1"],
      "expected_appearances": [
        { "id": 1, "change_reason": "initial appearance" }
      ]
    }
  ],
  "new_characters": [...],
  "updated_characters": [...]
}
```

#### 4.4.2 场景分析提示词 (`NP_SELECT_LOCATION`)

**变量**: `{input}`, `{locations_lib_name}`

**核心指令**:
- 提取需要独立背景资产的故事场景
- 排除抽象/隐喻空间和一次性路过提及
- 去重同一地点的别名

**输出JSON结构**:
```json
{
  "locations": [
    {
      "name": "location_name",
      "summary": "short usage summary",
      "has_crowd": false,
      "crowd_description": "",
      "available_slots": [
        "the position beneath the throne steps at the center of the palace hall",
        "the open space between the left column and the long table"
      ],
      "descriptions": [
        "[location_name] wide-angle description 1 with spatial layout and lighting",
        "[location_name] wide-angle description 2",
        "[location_name] wide-angle description 3"
      ]
    }
  ]
}
```

**关键约束**: 每个场景必须包含 2-6 个 `available_slots`，每个 slot 是完整的描述性放置短语（非短token），用于后续角色在画面中的位置锚定。

#### 4.4.3 片段切分提示词 (`NP_AGENT_CLIP`)

**变量**: `{input}`, `{locations_lib_name}`, `{characters_lib_name}`, `{props_lib_name}`, `{characters_introduction}`

**输出JSON结构**:
```json
[
  {
    "start": "exact start snippet from source text (>=5 chars)",
    "end": "exact end snippet from source text (>=5 chars)",
    "summary": "short clip summary",
    "location": "best matched location name",
    "characters": ["Character A", "Character B"],
    "props": ["Prop A"]
  }
]
```

**边界匹配约束** (代码中动态追加):
```
[Boundary Constraints]
1. The "start" and "end" anchors must come from the original text and be locatable.
2. Allow punctuation/whitespace differences, but do not rewrite key entities or events.
3. If anchors cannot be located reliably, return [] directly.
```

#### 4.4.4 剧本转换提示词 (`NP_SCREENPLAY_CONVERSION`)

**变量**: `{clip_content}`, `{locations_lib_name}`, `{characters_lib_name}`, `{props_lib_name}`, `{characters_introduction}`, `{clip_id}`

**输出JSON结构**:
```json
{
  "clip_id": "clip_1",
  "original_text": "original clip text",
  "scenes": [
    {
      "scene_number": 1,
      "heading": {
        "int_ext": "INT",
        "location": "Palace Throne Room",
        "time": "morning"
      },
      "description": "scene setup description",
      "characters": ["Character A"],
      "content": [
        { "type": "action", "text": "action description" },
        { "type": "dialogue", "character": "Character A", "parenthetical": "angrily", "lines": "spoken line" },
        { "type": "voiceover", "character": "Narrator", "text": "voiceover content" }
      ]
    }
  ]
}
```

### 4.5 Clip边界解析（三级匹配策略）

**文件**: `src/lib/novel-promotion/story-to-script/clip-matching.ts`

AI返回的片段边界是文本片段，需要解析回原始文本的精确位置：

| 级别 | 策略 | 说明 |
|------|------|------|
| L1 | 精确匹配 | 文本完全匹配 |
| L2 | 标点变体匹配 | 忽略中英文标点差异 |
| L3 | 近似匹配 | 基于文本相似度算法 |

```typescript
// 匹配结果结构
interface ClipMatchResult {
  startIndex: number   // 在原始文本中的起始索引
  endIndex: number     // 在原始文本中的结束索引
  level: 'L1' | 'L2' | 'L3'
  confidence: number   // 置信度分数
}
```

### 4.6 重试失效传播

当某个步骤重试时，下游依赖步骤自动失效（状态重置为 PENDING，产物删除）：

- 重试 `analyze_characters`/`analyze_locations`/`analyze_props` → `split_clips` 及所有 `screenplay_*` 步骤失效
- 重试 `split_clips` → 所有 `screenplay_*` 步骤失效
- 重试 `screenplay_{clipId}` → 仅该Clip的剧本步骤失效

**实现**: `src/lib/workflow-engine/registry.ts:26-52`

---

## 5. 第二阶段：Script-to-Storyboard（故事板与面板设计）

### 5.1 触发入口

| 属性 | 值 |
|------|-----|
| API路由 | `POST /api/novel-promotion/{projectId}/script-to-storyboard-stream` |
| 任务类型 | `TASK_TYPE.SCRIPT_TO_STORYBOARD_RUN` |
| Worker | `src/lib/workers/text.worker.ts` → `handleScriptToStoryboardTask` |
| 编排器 | `src/lib/novel-promotion/script-to-storyboard/orchestrator.ts` |

### 5.2 工作流定义（依赖图）

```
plan_panels ──► detail_panels ──► voice_analyze ──► persist_storyboard_artifacts
    ↑                ↑
    │         [phase2_cinematography]
    │         [phase2_acting]
    │
    └── 每Clip独立执行Phase 1-3
```

**工作流定义文件**: `src/lib/workflow-engine/registry.ts:150-190`

### 5.3 每Clip三阶段面板设计详解

**文件**: `src/lib/novel-promotion/script-to-storyboard/orchestrator.ts:285-508`

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Phase 1: plan_panels (面板规划)                                         │
│ 输入: clip内容 + 角色/场景/道具库 + 角色外观列表 + 角色完整描述          │
│ 输出: StoryboardPanel[] 基础面板结构                                     │
│                                                                         │
│ 每个面板包含:                                                            │
│   panel_number, description, characters[{name,appearance,slot}],        │
│   location, scene_type, source_text, shot_type, camera_move,            │
│   video_prompt, duration                                                │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Phase 2a: cinematography (摄影规则) ── 并行 ──► Phase 2b: acting (表演指导)│
│                                                                         │
│ 摄影规则输出 (PhotographyRule[]):                                        │
│   panel_number, composition, lighting, color_palette,                   │
│   atmosphere, technical_notes                                           │
│                                                                         │
│ 表演指导输出 (ActingDirection[]):                                        │
│   panel_number, characters[{name, acting}]                              │
│     acting包含: 情绪状态(可见的)、面部表情细节、肢体语言、微动作、视线方向  │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Phase 3: detail_panels (面板细化)                                       │
│ 输入: Phase 1面板 + Phase 2a摄影规则 + Phase 2b表演指导                  │
│ 输出: 最终 StoryboardPanel[]                                            │
│                                                                         │
│ mergePanelsWithRules():                                                 │
│   将photographyRules和actingNotes合并到每个面板中                        │
│   → panel.photographyPlan = {composition, lighting, colorPalette,...}   │
│   → panel.actingNotes = {characters:[{name, acting}]}                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.4 提示词详解

#### 5.4.1 Phase 1: 面板规划 (`NP_AGENT_STORYBOARD_PLAN`)

**变量替换**:
```
{characters_lib_name}      → "李明, 王芳, 张总"
{locations_lib_name}       → "总裁办公室, 咖啡厅"
{characters_introduction}  → 角色介绍映射文本
{characters_appearance_list} → 角色外观列表（如 "李明: ['初始形象', '受伤状态']"）
{characters_full_description} → 角色完整外貌描述
{props_description}        → 道具描述
{clip_json}                → Clip元数据JSON
{clip_content}             → 若存在screenplay则替换为剧本格式，否则用原始文本
```

**输出JSON示例**:
```json
[
  {
    "panel_number": 1,
    "description": "wide shot of the throne room with guards standing at attention",
    "characters": [
      { "name": "Emperor", "appearance": "initial appearance", "slot": "the elevated throne at the northern end of the hall" }
    ],
    "location": "Imperial Throne Room",
    "scene_type": "epic",
    "source_text": "皇帝端坐在龙椅上，百官朝拜",
    "shot_type": "wide shot",
    "camera_move": "static",
    "video_prompt": "static wide shot of an imperial throne room, emperor seated on elevated throne, officials bowing in formation",
    "duration": 3
  }
]
```

**关键规则**:
- `slot` 优先从 `available_slots` 中复制完整短语
- 运动/过渡/想象空间可省略 `slot`
- 严禁将slot替换为短token（如 `slot_1`, `left`）

#### 5.4.2 Phase 2a: 摄影规则 (`NP_AGENT_CINEMATOGRAPHER`)

**变量**: `{panels_json}`, `{panel_count}`, `{locations_description}`, `{characters_info}`, `{props_description}`

**输出JSON示例**:
```json
[
  {
    "panel_number": 1,
    "composition": "symmetrical framing, emperor centered, guards flanking both sides",
    "lighting": "golden hour light streaming through tall windows from camera left",
    "color_palette": "deep crimson, gold, dark wood tones",
    "atmosphere": "solemn and majestic",
    "technical_notes": "deep depth of field, f/8, slight upward angle to emphasize power"
  }
]
```

#### 5.4.3 Phase 2b: 表演指导 (`NP_AGENT_ACTING_DIRECTION`)

**变量**: `{panels_json}`, `{panel_count}`, `{characters_info}`

**核心要求**:
- 每个面板独立处理（同一角色在不同面板可有不同情绪）
- 适配 `scene_type` (daily/emotion/action/epic/suspense)
- 必须使用可观察描述，禁止抽象词如 "sad" 而无视觉证据

**输出JSON示例**:
```json
[
  {
    "panel_number": 1,
    "characters": [
      {
        "name": "Emperor",
        "acting": "back rigid against the throne, chin slightly raised, eyes narrowed with cold authority, left hand resting on carved armrest"
      }
    ]
  }
]
```

#### 5.4.4 Phase 3: 面板细化 (`NP_AGENT_STORYBOARD_DETAIL`)

**变量**: `{panels_json}`, `{characters_age_gender}`, `{locations_description}`, `{props_description}`

**任务**: 为每个面板输出完整的电影级细节，特别是 `video_prompt` 必须是 motion-ready 的具体描述。

**过滤逻辑**: Phase 3输出后会过滤掉 `description === '无'` 或 `location === '无'` 的面板。

### 5.5 Voice Analysis（台词提取与面板匹配）

**提示词ID**: `NP_VOICE_ANALYSIS`

**变量**: `{input}`(novelText), `{characters_lib_name}`, `{characters_introduction}`, `{storyboard_json}`

**输出JSON**:
```json
[
  {
    "lineIndex": 1,
    "speaker": "Emperor",
    "content": "How dare you disobey my command?",
    "emotionStrength": 0.3,
    "matchedPanel": {
      "storyboardId": "storyboard_id",
      "panelIndex": 2
    }
  }
]
```

**规则**:
- `emotionStrength`: 0.1 ~ 0.5
- 仅提取口语对话（引号内、直接引语）
- 排除纯叙述和场景描述
- 无可靠面板匹配时 `matchedPanel: null`

### 5.6 重试失效传播（Storyboard级）

**文件**: `src/lib/workflow-engine/registry.ts:65-96`

```
重试 phase1 ──► phase2_cinematography + phase2_acting + phase3 + voice_analyze 全部失效
重试 phase2_cinematography ──► phase3 + voice_analyze 失效
重试 phase2_acting ──► phase3 + voice_analyze 失效
重试 phase3 ──► voice_analyze 失效
重试 voice_analyze ──► 仅自身失效
```

---

## 6. 第三阶段：媒体生成流水线

### 6.1 图像生成

#### 6.1.1 触发方式

| 场景 | API路由 | 任务类型 | Worker |
|------|---------|---------|--------|
| 面板图像 | `POST /api/novel-promotion/{projectId}/regenerate-panel-image` | `IMAGE_PANEL` | image.worker.ts |
| 角色图像 | `POST /api/novel-promotion/{projectId}/generate-character-image` | `IMAGE_CHARACTER` | image.worker.ts |
| 场景图像 | `POST /api/novel-promotion/{projectId}/generate-image` | `IMAGE_LOCATION` | image.worker.ts |
| 面板变体 | - | `PANEL_VARIANT` | image.worker.ts |

#### 6.1.2 面板图像生成完整流程

**文件**: `src/lib/workers/handlers/panel-image-task-handler.ts`

```
1. 加载 panel 数据 + project 数据
2. getProjectModels() 解析模型配置
   → modelKey = project.storyboardModel || project.imageModel
3. collectPanelReferenceImages() 收集参考图像
   ├─ 角色参考图（来自 CharacterAppearance.selectedImage）
   ├─ 场景参考图（来自 LocationImage.selectedImage）
   └─ 之前生成的面板图（用于风格一致性）
4. normalizeReferenceImagesForGeneration() 归一化参考图像
5. buildPanelPromptContext() 构建提示词上下文
   ├─ 解析面板角色引用（characters JSON）
   ├─ 匹配角色外观（按 appearance name）
   ├─ 匹配场景（按 location name）
   └─ 提取 available_slots
6. buildPanelPrompt() 渲染最终提示词
   ├─ promptId: NP_SINGLE_PANEL_IMAGE
   ├─ variables: aspect_ratio, storyboard_text_json_input, source_text, style
7. generateImage() → 生成候选图像（1-4张）
8. uploadImageSourceToCos() → 上传候选图
9. 更新 Panel.imageUrl / candidateImages / previousImageUrl
```

#### 6.1.3 面板图像提示词上下文构建

**文件**: `src/lib/workers/handlers/panel-image-task-handler.ts:65-139`

```typescript
function buildPanelPromptContext({ panel, projectData }) {
  // 解析面板角色引用
  const panelCharacters = parsePanelCharacterReferences(panel.characters)
  // 例: [{"name":"Emperor","appearance":"initial appearance","slot":"the elevated throne..."}]

  // 为每个角色匹配外观描述
  const characterContexts = panelCharacters.map((ref) => {
    const character = findCharacterByName(projectData.characters, ref.name)
    const matchedAppearance = character.appearances.find(
      a => a.changeReason === ref.appearance
    ) || character.appearances[0]

    return {
      name: character.name,
      appearance: matchedAppearance?.changeReason,
      description: pickAppearanceDescription(matchedAppearance), // 选中外貌描述
      slot: ref.slot, // 位置锚定
    }
  })

  // 匹配场景上下文
  const locationContext = {
    name: matchedLocation.name,
    description: selectedImage?.description,
    available_slots: parseLocationAvailableSlots(selectedImage?.availableSlots),
  }

  return {
    panel: {
      panel_id, shot_type, camera_move, description, image_prompt,
      video_prompt, location, characters, source_text,
      photography_rules, acting_notes
    },
    context: {
      character_appearances: characterContexts,
      location_reference: locationContext,
    }
  }
}
```

**最终渲染的提示词示例** (`NP_SINGLE_PANEL_IMAGE`):

```
You are a professional storyboard image artist.
Generate exactly one high-quality image for one panel.

Absolute constraints:
1. No text in the image.
2. No subtitles, labels, numbers, watermarks, or symbols.
3. Do not create collage or multi-frame output.
4. Output exactly one frame.

Aspect ratio (must be exact):
9:16

Storyboard panel data:
{
  "panel": {
    "panel_id": "panel_abc123",
    "shot_type": "wide shot",
    "camera_move": "static",
    "description": "wide shot of the throne room with guards standing at attention",
    ...
  },
  "context": {
    "character_appearances": [
      {
        "name": "Emperor",
        "appearance": "initial appearance",
        "description": "middle-aged male, sharp angular face, long black beard...",
        "slot": "the elevated throne at the northern end of the hall"
      }
    ],
    "location_reference": {
      "name": "Imperial Throne Room",
      "description": "vast palace hall with red pillars and golden dragon carvings...",
      "available_slots": [...]
    }
  }
}

Source text:
皇帝端坐在龙椅上，百官朝拜

Style requirement:
American comic book style, bold ink lines, dramatic shadows, vibrant colors
```

#### 6.1.4 参考图像系统

```
参考图像来源（按优先级）:
├─ 角色外观图（CharacterAppearance.selectedImage）
├─ 场景参考图（LocationImage.selectedImage）
├─ 之前生成的面板图（panel.previousImageUrl）
└─ 全局资产图（GlobalCharacterAppearance / GlobalLocationImage）

参考图像处理:
normalizeReferenceImagesForGeneration()
  → 下载/转码/归一化为生成器可接受的格式
  → 支持 data: URL / HTTP URL / storageKey

generateImage() 中 referenceImages 传递:
  → OpenAI兼容: images.edit() 传入（当 referenceImages.length > 0）
  → 其他供应商: 通过各自API的 reference_image 参数
```

#### 6.1.5 模型选择优先级

```
面板图像: project.storyboardModel > project.imageModel > 用户偏好默认
角色图像: project.characterModel > project.imageModel > 用户偏好默认
场景图像: project.locationModel > project.imageModel > 用户偏好默认
```

### 6.2 视频生成

#### 6.2.1 触发方式

- **API路由**: `POST /api/novel-promotion/{projectId}/generate-video`
- **任务类型**: `TASK_TYPE.VIDEO_PANEL`
- **处理Worker**: `src/lib/workers/video.worker.ts`
- **并发**: `QUEUE_CONCURRENCY_VIDEO` (默认4)

#### 6.2.2 生成模式

| 模式 | 说明 | 输入 | 适用模型 |
|------|------|------|---------|
| `normal` | 标准图生视频 | panel.imageUrl + videoPrompt | 所有视频模型 |
| `firstlastframe` | 首尾帧驱动 | firstFrame(imageUrl) + lastFrame + videoPrompt | Seedance 2.0等 |

#### 6.2.3 生成流程

```
1. 加载面板数据
2. resolveModelSelection(userId, videoModel, 'video')
3. 解析视频生成模式:
   ├─ normal: imageUrl = panel.imageUrl
   └─ firstlastframe: imageUrl = panel.imageUrl, lastFrameImageUrl = panel.lastFrameImageUrl
4. 构建 videoPrompt:
   ├─ 优先使用 panel.videoPrompt
   └─ 回退到 panel.description + photographyRules + actingNotes
5. validateCapabilitySelectionForModel() 验证能力组合
6. 路由到供应商:
   ├─ bailian ────────► generateBailianVideo()
   ├─ siliconflow ────► generateSiliconFlowVideo()
   ├─ openai-compat ──┬─► generateVideoViaOpenAICompat()
   │                  └─► generateVideoViaOpenAICompatTemplate()
   └─ 其他(fal/google等) ──► createVideoGenerator() 工厂
7. 异步轮询结果（部分供应商返回任务ID）
8. uploadObject() → MediaObject → 更新 panel.videoUrl/videoMediaId
```

#### 6.2.4 视频提示词构建

视频提示词来源于面板数据的组合：

```typescript
// 伪代码：videoPrompt 构建逻辑
const videoPrompt = panel.videoPrompt
  || `${panel.description}. ${panel.cameraMove}. ${panel.shotType}.`
  || `${panel.photographyRules?.composition}. ${panel.photographyRules?.lighting}`
```

**OpenAI兼容视频选项**:
```typescript
interface OpenAICompatVideoOptions {
  duration?: 4 | 8 | 12           // 秒
  size?: '720x1280' | '1280x720' | '1024x1792' | '1792x1024'
  aspectRatio?: '16:9' | '9:16'
  generateAudio?: boolean         // 仅 Seedance 1.5 Pro
  lastFrameImageUrl?: string      // 首尾帧模式
}
```

### 6.3 语音/TTS生成

#### 6.3.1 触发方式

- **API路由**: `POST /api/novel-promotion/{projectId}/voice-generate`
- **任务类型**: `TASK_TYPE.VOICE_LINE`
- **处理Worker**: `src/lib/workers/voice.worker.ts`
- **并发**: `QUEUE_CONCURRENCY_VOICE` (默认10)

#### 6.3.2 核心生成逻辑详解

**文件**: `src/lib/voice/generate-voice-line.ts`

```
1. 加载 NovelPromotionVoiceLine (speaker, content, emotionPrompt, emotionStrength)
2. 加载项目角色列表和 episode.speakerVoices (speaker→voiceId映射)
3. matchCharacterBySpeaker() 匹配角色
   ├─ 精确匹配: character.name === speaker
   └─ 模糊匹配: character.name.includes(speaker) || speaker.includes(character.name)
4. resolveModelSelectionOrSingle(userId, audioModel, 'audio')
   → 返回 { provider, modelId, modelKey }
5. resolveVoiceBindingForProvider(providerKey, character, speakerVoice)
   ├─ FAL: 需要 referenceAudioUrl（上传的参考音频）
   └─ Bailian: 需要 voiceId（AI设计的音色ID）
6. 根据供应商生成:
```

#### 6.3.3 双供应商语音生成

**FAL / IndexTTS2**:
```typescript
generateVoiceWithIndexTTS2({
  endpoint: audioSelection.modelId,      // 如 "fal-ai/index-tts-2"
  referenceAudioUrl: fullAudioUrl,       // 参考音频（Base64 data URL）
  text: line.content,
  emotionPrompt: line.emotionPrompt,     // 如 "angry shouting"
  strength: line.emotionStrength ?? 0.4, // 0.0-1.0
})
// 调用: fal.subscribe(endpoint, { input: { audio_url, prompt, emotion_prompt, strength } })
```

**Bailian / Qwen3-TTS**:
```typescript
synthesizeWithBailianTTS({
  text,                                  // 自动分割为≤600字符段
  voiceId: voiceBinding.voiceId,
  modelId: audioSelection.modelId,
  languageType: 'Chinese',
}, apiKey)
// 文本分割: 按标点（。！？；，、.!?:;,）切分，确保每段≤600字符
// 分别合成后合并为单一WAV
```

#### 6.3.4 音频存储与元数据

```typescript
// 存储路径
const audioKey = `voice/${projectId}/${episodeId}/${lineId}.wav`

// WAV时长解析（从Buffer读取RIFF头）
function getWavDurationFromBuffer(buffer: Buffer): number {
  const byteRate = buffer.readUInt32LE(28)
  // 遍历RIFF chunk找到data chunk
  const dataSize = ...
  return Math.round((dataSize / byteRate) * 1000) // ms
}

// 更新数据库
await prisma.novelPromotionVoiceLine.update({
  where: { id: line.id },
  data: { audioUrl: cosKey, audioDuration: generated.audioDuration }
})
```

### 6.4 唇形同步（Lip-Sync）

#### 6.4.1 触发方式

- **API路由**: `POST /api/novel-promotion/{projectId}/lip-sync`
- **任务类型**: `TASK_TYPE.LIP_SYNC`
- **默认模型**: `fal-ai/kling-video/lipsync/audio-to-video`

#### 6.4.2 处理流程

**文件**: `src/lib/lipsync/index.ts`

```
1. 输入: panel.videoUrl + voiceLine.audioUrl
2. preprocessLipSyncParams() 供应商特定参数归一化
3. resolveModelSelection() 解析唇形同步模型
4. 路由:
   ├─ fal: fal.subscribe("fal-ai/kling-video/lipsync/audio-to-video", { video_url, audio_url })
   ├─ vidu: vidu API
   └─ bailian: bailian API
5. 生成结果 → 更新 panel.lipSyncVideoUrl / lipSyncVideoMediaId
```

---

## 7. 第四阶段：视频组装与导出

### 7.1 Remotion视频编辑器

- **API路由**: `PUT /api/novel-promotion/{projectId}/editor`
- **数据模型**: `VideoEditorProject`
- **核心字段**: `projectData` (JSON格式Remotion编辑数据)

### 7.2 编辑数据结构

`projectData` 存储完整的Remotion时间轴配置：

```typescript
interface RemotionProjectData {
  timeline: {
    clips: Array<{
      panelId: string
      videoUrl: string           // panel.videoUrl 或 panel.lipSyncVideoUrl
      voiceLineUrl?: string      // 对应匹配的 voiceLine.audioUrl
      startTime: number          // 在时间轴上的起始时间(秒)
      duration: number           // 片段时长(秒)
      transition?: {
        type: 'fade' | 'slide' | 'cut'
        duration: number
      }
    }>
  }
  composition: {
    width: number
    height: number
    fps: number
    durationInFrames: number
  }
  // ... 其他Remotion配置（字幕层、音频层、特效层）
}
```

### 7.3 渲染状态机

```
pending ──► rendering ──► completed
              │
              └──► failed
```

- `renderStatus`: 跟踪渲染状态
- `renderTaskId`: 渲染任务ID
- `outputUrl`: 最终渲染视频URL

---

## 8. 任务调度与执行引擎

### 8.1 双系统架构

系统同时运行两套任务执行系统：

| 维度 | 传统任务系统 (Legacy) | GraphRun工作流引擎 (New) |
|------|----------------------|-------------------------|
| **核心文件** | `src/lib/task/` | `src/lib/run-runtime/` |
| **状态** | queued/processing/completed/failed/canceled/dismissed | queued/running/completed/failed/canceling/canceled |
| **粒度** | 单个任务 | 工作流运行（多步骤） |
| **事件** | `task.created/progress/completed/failed` | `run.start/step.start/step.complete/run.complete` |
| **重试** | BullMQ级别（指数退避） | 步骤级别 + 依赖失效传播 |
| **用例** | 图像/视频/语音生成 | Story-to-Script / Script-to-Storyboard |

### 8.2 BullMQ队列配置

**文件**: `src/lib/task/queues.ts`

```typescript
const QUEUE_NAME = {
  IMAGE: 'waoowaoo-image',
  VIDEO: 'waoowaoo-video',
  VOICE: 'waoowaoo-voice',
  TEXT: 'waoowaoo-text',
}

const defaultJobOptions = {
  removeOnComplete: 500,
  removeOnFail: 500,
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 }, // 2s, 4s, 8s, 16s, 32s
}
```

**队列分配**:

| 任务类型 | 队列 | 并发 | 默认attempts |
|---------|------|------|-------------|
| `IMAGE_PANEL`, `IMAGE_CHARACTER`, `IMAGE_LOCATION`, `PANEL_VARIANT`, `MODIFY_ASSET_IMAGE`, `ASSET_HUB_IMAGE`, `ASSET_HUB_MODIFY` | image | 20 | 5 |
| `VIDEO_PANEL`, `LIP_SYNC` | video | 4 | 5 |
| `VOICE_LINE`, `VOICE_DESIGN`, `ASSET_HUB_VOICE_DESIGN` | voice | 10 | 5 |
| `STORY_TO_SCRIPT_RUN`, `SCRIPT_TO_STORYBOARD_RUN`, `ANALYZE_NOVEL`, 其他 | text | 10 | 1 (特殊) |

**特殊配置**: `STORY_TO_SCRIPT_RUN` / `SCRIPT_TO_STORYBOARD_RUN` 为单attempt任务（不允许BullMQ重试，由工作流引擎自身管理重试）。

### 8.3 任务生命周期包装器

**文件**: `src/lib/workers/shared.ts`

```typescript
async function withTaskLifecycle(job, handler) {
  // 1. 启动10秒心跳定时器 (touchTaskHeartbeat)
  const heartbeatTimer = setInterval(() => touchTaskHeartbeat(taskId), 10000)

  // 2. CAS切换状态: queued → processing
  const marked = await tryMarkTaskProcessing(taskId)
  if (!marked) throw new UnrecoverableError('Task already terminal')

  // 3. 发布 task.processing 事件到 Redis
  publishLifecycleEvent({ taskId, type: 'task.processing' })

  // 4. 在 withTextUsageCollection 中执行 handler（收集token用量）
  try {
    const result = await withTextUsageCollection(() => handler(job))

    // 5. 成功: 结算计费 → 标记完成 → 发布事件
    await settleTaskBilling(taskId, billingInfo)
    await tryMarkTaskCompleted(taskId)
    publishLifecycleEvent({ taskId, type: 'task.completed' })
    return result

  } catch (error) {
    const normalized = normalizeAnyError(error)

    // 6. TaskTerminatedError: 用户取消/租约过期
    if (error instanceof TaskTerminatedError) {
      await rollbackTaskBilling(taskId)
      throw new UnrecoverableError('Task terminated')
    }

    // 7. 可重试错误 + 有剩余attempt: 抛出让BullMQ重试
    if (normalized.retryable && job.attemptsMade < job.opts.attempts - 1) {
      throw error  // BullMQ handles retry with backoff
    }

    // 8. 不可重试/耗尽: 回滚计费 → 标记失败 → 发布事件 → UnrecoverableError
    await rollbackTaskBilling(taskId)
    await tryMarkTaskFailed(taskId, error)
    publishLifecycleEvent({ taskId, type: 'task.failed', error })
    throw new UnrecoverableError(error)
  } finally {
    clearInterval(heartbeatTimer)
  }
}
```

### 8.4 GraphRun执行引擎

#### 8.4.1 核心实体关系

```
GraphRun (1)
  ├── status: QUEUED | RUNNING | COMPLETED | FAILED | CANCELING | CANCELED
  ├── leaseOwner: string | null        // 租约持有者（防止并发执行）
  ├── leaseExpiresAt: DateTime | null  // 租约过期时间
  ├── workflowType: string             // "story_to_script_run" | "script_to_storyboard_run"
  ├── taskId: string | null            // 关联的Task
  └── GraphStep (N)
        ├── key: string                // 步骤标识，如 "analyze_characters"
        ├── status: PENDING | RUNNING | COMPLETED | FAILED | CANCELED
        ├── currentAttempt: number
        └── GraphStepAttempt (N)
              ├── attempt: number
              ├── status: RUNNING | COMPLETED | FAILED
              └── output: JSON
```

#### 8.4.2 租约机制（Lease-based Execution）

**文件**: `src/lib/run-runtime/workflow-lease.ts`

防止多个Worker并发执行同一个Run：

```typescript
async function withWorkflowRunLease({ runId, workerId, leaseMs = 60000 }, workflowFn) {
  // 1. 原子性获取租约
  const claimed = await claimRunLease({
    runId, workerId, leaseExpiresAt: new Date(Date.now() + leaseMs)
  })
  // 条件: status ∈ [QUEUED, RUNNING, CANCELING] AND
  //        (leaseOwner=null OR leaseOwner=workerId OR leaseExpiresAt < now)

  if (!claimed) throw new TaskTerminatedError('Could not claim lease')

  // 2. 设置心跳定时器: 每 leaseMs/3 续租
  const renewTimer = setInterval(() => {
    renewRunLease({ runId, workerId, leaseExpiresAt: new Date(Date.now() + leaseMs) })
  }, leaseMs / 3)

  try {
    // 3. 执行工作流
    return await workflowFn()
  } finally {
    clearInterval(renewTimer)
    await releaseRunLease({ runId, workerId })
  }
}
```

#### 8.4.3 事件投影系统

**文件**: `src/lib/run-runtime/service.ts`

```typescript
async function applyRunProjection(tx, event) {
  switch (event.eventType) {
    case 'run.start':
      await tx.graphRun.update({ status: RUNNING })
      break
    case 'step.start':
      await tx.graphStep.upsert({
        where: { runId_key: { runId, key: event.stepKey } },
        update: { status: RUNNING },
        create: { runId, key: event.stepKey, status: RUNNING, currentAttempt: event.attempt }
      })
      break
    case 'step.complete':
      await tx.graphStep.update({ status: COMPLETED })
      await tx.graphStepAttempt.update({ status: COMPLETED })
      break
    case 'run.complete':
      await tx.graphRun.update({
        status: COMPLETED,
        leaseOwner: null,
        leaseExpiresAt: null
      })
      // 标记所有pending步骤为COMPLETED
      break
    case 'run.error':
      await tx.graphRun.update({ status: FAILED })
      // 标记所有pending步骤为FAILED
      break
  }
}
```

#### 8.4.4 检查点（Checkpoints）

```typescript
// 最大64KB的JSON状态快照
const RUN_STATE_MAX_BYTES = 64 * 1024

createCheckpoint({ runId, nodeKey, version, stateJson })
listCheckpoints({ runId, nodeKey }) // 按version降序
```

用于长工作流的可恢复执行。

### 8.5 SSE进度流

#### 8.5.1 Task事件SSE

**API**: `POST /api/task-target-states`

```
Worker → reportTaskProgress(job, 50, { stage: 'generate' })
  → publishTaskEvent({ taskId, type: 'task.progress', payload: { progress: 50, stage: 'generate' } })
    → 持久化到 TaskEvent 表
    → 发布到 Redis channel: "task-events:project:{projectId}"
    → 客户端SSE订阅接收
```

#### 8.5.2 Run事件SSE

**API**: `GET /api/runs/{runId}/events?afterSeq=N`

对于 `STORY_TO_SCRIPT_RUN` / `SCRIPT_TO_STORYBOARD_RUN`:
```
Worker handler → publishRunEvent({ runId, eventType: 'step.start', stepKey: 'analyze_characters' })
  → appendRunEventWithSeq()  // DB持久化 + seq递增
  → 发布到 Redis channel: "run-events:project:{projectId}"
```

对于其他任务类型，通过 `task-bridge.ts` 将 task 事件映射为 run 事件：
- `task.created` → `RUN_START`
- `task.progress` (含stepKey) → `STEP_START` / `STEP_COMPLETE` / `STEP_ERROR`
- `task.completed` → `STEP_COMPLETE` + `RUN_COMPLETE`
- `task.failed` → `STEP_ERROR` + `RUN_ERROR`
- `task.stream` → `STEP_CHUNK` (lane: text/reasoning)

### 8.6 监控与恢复（Watchdog）

#### 8.6.1 进程内Watchdog

**文件**: `src/lib/task/reconcile.ts`

- **周期**: 60秒
- **功能**:
  - `sweepStaleTasks()`: heartbeat超时(90s)的PROCESSING任务标记为 `WATCHDOG_TIMEOUT`
  - `reconcileActiveTasks()`: DB与BullMQ状态对账
  - `reconcileActiveRunsFromTasks()`: Run级状态对账
  - 每小时项目日志清理

#### 8.6.2 独立Watchdog进程

**文件**: `scripts/watchdog.ts`

- **周期**: 30秒 (可配置 `WATCHDOG_INTERVAL_MS`)
- **功能**:
  - `recoverQueuedTasks()`: `status=queued` 但 `enqueuedAt=null` 的任务重新入队
  - `cleanupZombieProcessingTasks()`: heartbeat超时的任务根据attempt决定失败或重置

#### 8.6.3 Run级恢复

**文件**: `src/lib/run-runtime/reconcile.ts`

```
1. 租约过期: RUNNING + leaseExpiresAt < now - 30s → FAILED (RUN_LEASE_EXPIRED)
2. 取消超时: CANCELING + cancelRequestedAt > 5min → FAILED (RUN_CANCEL_TIMEOUT)
3. 关联任务完成: taskId对应任务COMPLETED → Run COMPLETED
4. 关联任务失败: taskId对应任务FAILED/CANCELED/DISSED → Run FAILED
```

---

## 9. AI模型网关与多供应商路由

### 9.1 路由架构

**文件**: `src/lib/model-gateway/router.ts`

```
                    ┌─────────────────┐
                    │  Model Gateway  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        official        openai-compat    factory
              │              │              │
    ┌─────────┴──┐    ┌─────┴──────┐   ┌──┴────────────────┐
    │ bailian    │    │ 自定义API   │   │ fal/google/ark    │
    │ siliconflow│    │ (模板渲染)  │   │ vidu/minimax      │
    │            │    │            │   │ gemini-compatible │
    └────────────┘    └────────────┘   └───────────────────┘
```

**路由决策**:
- `official`: bailian, siliconflow — 使用官方SDK
- `openai-compat`: `openai-compatible` provider key — 使用OpenAI SDK + 自定义baseURL
- `factory`: 其他供应商 — 通过工厂创建专用生成器

### 9.2 支持的供应商矩阵

| 供应商 | LLM | 图像 | 视频 | TTS | 唇形同步 | 路由方式 |
|--------|-----|------|------|-----|---------|---------|
| **OpenAI** | ✓ | ✓ | ✓ | - | - | openai-compat |
| **Google Gemini** | ✓ | ✓ | ✓ | - | - | factory |
| **FAL** | - | ✓ | ✓ | ✓ (IndexTTS2) | ✓ | factory |
| **OpenRouter** | ✓ | - | - | - | - | openai-compat |
| **Volcano Engine (ARK)** | ✓ | - | - | - | - | factory |
| **Alibaba Bailian** | ✓ | ✓ | ✓ | ✓ (Qwen3-TTS) | ✓ | official |
| **SiliconFlow** | ✓ | ✓ | ✓ | - | - | official |
| **Vidu** | - | - | ✓ | - | ✓ | factory |
| **MiniMax** | - | - | ✓ | - | - | factory |

### 9.3 模型选择解析

**文件**: `src/lib/generator-api.ts`

```typescript
// 统一入口
resolveModelSelection(userId, modelKey, mediaType)
// modelKey 格式: "provider::modelId" (如 "fal::fal-ai/flux/dev")
// mediaType: 'text' | 'image' | 'video' | 'audio' | 'lipsync'
// 返回: { provider, providerKey, modelId, modelKey, compatMediaTemplate? }
```

### 9.4 AI运行时

**文件**: `src/lib/ai-runtime/client.ts`

```typescript
// 文本步骤
executeAiTextStep(input: AiStepExecutionInput): AiStepExecutionResult
  → runModelGatewayTextCompletion()

// 视觉步骤
executeAiVisionStep(input: AiVisionStepExecutionInput): AiStepExecutionResult
  → runModelGatewayVisionCompletion()

// 错误标准化
toAiRuntimeError(error): AiRuntimeError
  // 错误码: NETWORK_ERROR, RATE_LIMIT, EMPTY_RESPONSE, PARSE_ERROR,
  //         TIMEOUT, SENSITIVE_CONTENT, INTERNAL_ERROR
  // EMPTY_RESPONSE 和 TIMEOUT 标记为 retryable: true
```

### 9.5 能力目录

**文件**: `src/lib/model-capabilities/catalog.ts`

能力声明以JSON文件形式存放在 `standards/capabilities/`，而非硬编码：

```typescript
interface BuiltinCapabilityCatalogEntry {
  modelType: 'llm' | 'image' | 'video' | 'audio' | 'lipsync'
  provider: string
  modelId: string
  capabilities?: ModelCapabilities  // resolutionOptions, generationModeOptions等
}
```

### 9.6 定价目录

**文件**: `src/lib/model-pricing/catalog.ts`

定价声明以JSON文件形式存放在 `standards/pricing/`：

```typescript
interface BuiltinPricingCatalogEntry {
  apiType: 'text' | 'image' | 'video' | 'voice' | 'voice-design' | 'lip-sync'
  provider: string
  modelId: string
  pricing: {
    mode: 'flat' | 'capability'
    // flat: flatAmount (固定费用)
    // capability: tiers[] (when条件匹配 → amount)
  }
}
```

---

## 10. 资产中心与视觉一致性

### 10.1 资产类型与层级

```
┌─────────────────────────────────────────────────────────┐
│                    资产中心 (Asset Hub)                  │
├─────────────┬─────────────────┬─────────────────────────┤
│  Global资产  │  Project资产     │ 说明                    │
├─────────────┼─────────────────┼─────────────────────────┤
│ GlobalCharacter│ NovelPromotionCharacter│ 角色形象+声音         │
│   └─ GlobalCharacterAppearance    └─ CharacterAppearance │  外观变体            │
│ GlobalLocation │ NovelPromotionLocation │ 场景/道具图像          │
│   └─ GlobalLocationImage          └─ LocationImage       │  场景描述+slot       │
│ GlobalVoice    │ -                 │ 全局声音预设            │
│ GlobalProp     │ NovelPromotionLocation │ 道具（assetKind="prop"）│
│ GlobalAssetFolder│ -               │ 扁平文件夹组织          │
└─────────────┴─────────────────┴─────────────────────────┘
```

### 10.2 角色外观系统

```
NovelPromotionCharacter
    │
    ├──1:N──► CharacterAppearance (多外观变体)
    │              ├── selectedIndex: 当前选中外观索引
    │              ├── descriptions: string[] 外观描述数组
    │              ├── description: string 单描述（兼容旧数据）
    │              └── changeReason: string 变化原因标签
    │                 例: "initial appearance", "injured", "formal attire"
    │
    └── voice: { voiceType, voiceId, customVoiceUrl, customVoiceMediaId }
```

### 10.3 提示词上下文注入（核心视觉一致性机制）

**文件**: `src/lib/assets/services/asset-prompt-context.ts`

```typescript
export function buildPromptAssetContext(input: PromptAssetContextInput): PromptAssetContext {
  // 输入:
  // - characters: PromptCharacterAsset[] (含appearances)
  // - locations: PromptLocationAsset[] (含images含availableSlots)
  // - props: PromptPropAsset[]
  // - clipCharacters: ClipCharacterRef[] (当前片段出场角色)
  // - clipLocation: string | null (当前片段场景)
  // - clipProps: string[] (当前片段道具)

  // 输出6个文本片段:
  return {
    subjectNames,           // ["李明", "王芳"]
    environmentName,        // "总裁办公室"
    propNames,              // ["文件", "咖啡杯"]
    appearanceListText,     // "李明: ['初始形象', '受伤状态']\n王芳: ['初始形象']"
    fullDescriptionText,    // "【李明 - 初始形象】中年男性，西装革履...\n【李明 - 受伤状态】左臂缠着绷带..."
    locationDescriptionText,// "总裁办公室: 落地窗外城市夜景...\n可用位置: 皮沙发前, 办公桌后..."
    propsDescriptionText,   // "【文件】一叠A4纸...\n【咖啡杯】白色陶瓷杯..."
    charactersIntroductionText // "李明: 前特种兵，性格坚毅...\n王芳: 李明的妻子..."
  }
}
```

**角色名匹配支持别名**:
```typescript
export function characterNameMatches(characterName: string, referenceName: string): boolean {
  // 支持 "李明/李队长" 形式的别名
  const charAliases = charLower.split('/').map(s => s.trim())
  const refAliases = refLower.split('/').map(s => s.trim())
  return refAliases.some(alias => charAliases.includes(alias))
}
```

### 10.4 提示词上下文在图像生成中的注入流程

```
用户请求生成面板图像
    │
    ▼
buildPanelPromptContext()
  ├─ parsePanelCharacterReferences(panel.characters)
  │   → [{name:"李明", appearance:"初始形象", slot:"皮沙发前"}]
  │
  ├─ findCharacterByName(projectData.characters, "李明")
  │   → 匹配到角色，获取appearances数组
  │
  ├─ pickAppearanceDescription(matchedAppearance)
  │   → 从 descriptions[selectedIndex] 获取选中描述
  │   → 回退到 appearance.description
  │
  ├─ 匹配场景: find location by panel.location
  │   → 获取 selectedImage.description + availableSlots
  │
  └─ 构建 JSON 上下文
      {
        panel: { shot_type, camera_move, description, ... },
        context: {
          character_appearances: [{name, appearance, description, slot}],
          location_reference: {name, description, available_slots}
        }
      }
    │
    ▼
buildPanelPrompt() → buildPrompt(NP_SINGLE_PANEL_IMAGE)
  → 渲染为完整提示词文本
    │
    ▼
generateImage(userId, modelKey, prompt, { referenceImages, aspectRatio })
  → 生成图像
```

### 10.5 资产复制

全局资产可复制到特定项目中：
- `GlobalCharacter` → `NovelPromotionCharacter` (含 `sourceGlobalCharacterId`)
- `GlobalLocation` → `NovelPromotionLocation` (含 `sourceGlobalLocationId`)

复制后保持视觉一致性：源资产的外观描述继续用于目标项目的图像生成提示词。

---

## 11. 存储与媒体对象管理

### 11.1 存储抽象

**文件**: `src/lib/storage/factory.ts`

```typescript
interface StorageProvider {
  uploadObject({ key, body, contentType }): Promise<{ key }>
  deleteObject(key): Promise<void>
  deleteObjects(keys[]): Promise<{ success, failed }>
  getSignedObjectUrl({ key, expiresInSeconds }): Promise<string>
  getObjectBuffer(key): Promise<Buffer>
  extractStorageKey(input): string | null
  toFetchableUrl(inputUrl): string
  generateUniqueKey({ prefix, ext }): string
}
```

**三种实现**:
- **MinIO** (`providers/minio.ts`): AWS SDK v3, 支持预签名URL
- **Local** (`providers/local.ts`): `./data/uploads` 目录, URL格式 `/api/files/...`
- **COS** (`providers/cos.ts`): 腾讯云COS

### 11.2 媒体对象（MediaObject）

**文件**: `prisma/schema.prisma`

`MediaObject` 是所有媒体文件的规范化引用，替代了旧的URL字符串模式：

```prisma
model MediaObject {
  id          String   @id @default(uuid())
  publicId    String   @unique
  storageKey  String   @unique @db.VarChar(512)
  sha256      String?  // 内容哈希（去重/完整性校验）
  mimeType    String?
  sizeBytes   BigInt?
  width       Int?
  height      Int?
  durationMs  Int?     // 音视频时长

  // 20+ 关系指向各业务实体
  novelPromotionPanelImages         NovelPromotionPanel[]  @relation("PanelImage")
  novelPromotionPanelVideos         NovelPromotionPanel[]  @relation("PanelVideo")
  novelPromotionPanelLipSyncVideos  NovelPromotionPanel[]  @relation("PanelLipSync")
  novelPromotionVoiceLineAudios     NovelPromotionVoiceLine[]
  characterAppearanceImages         CharacterAppearance[]
  // ... 其他关系
}
```

### 11.3 存储Key格式

```
images/{prefix}-{timestamp}-{random}.{ext}
// 例: images/panel-1745321465234-xyz9ab.png

voice/{projectId}/{episodeId}/{lineId}.wav

video/{prefix}-{timestamp}-{random}.mp4
```

### 11.4 图像后处理

```typescript
// 下载 → 重新编码为JPEG (mozjpeg, quality 95→60) → 上传
downloadAndUploadImage(imageUrl, key)

// 下载 → 重新上传
downloadAndUploadVideo(videoUrl, key)
```

---

## 12. 计费与成本追踪

### 12.1 计费模式

```typescript
type BillingMode = 'OFF' | 'SHADOW' | 'ENFORCE'
```

- **OFF** (开发默认): 代码路径活跃但不实际扣费
- **SHADOW**: 记录成本但不阻止执行
- **ENFORCE**: 余额不足时阻止任务提交

### 12.2 账本结构

```
UserBalance ──1:N──► BalanceFreeze ──1:N──► BalanceTransaction
```

- `UserBalance`: 用户当前余额
- `BalanceFreeze`: 任务提交时预冻结的金额
- `BalanceTransaction`: 实际扣费/退款记录

### 12.3 任务计费流程

```
1. submitTask() 调用 prepareTaskBilling()
   ├─ 解析定价 (resolveBuiltinPricing)
   ├─ 计算预估成本
   └─ 冻结余额 (BalanceFreeze)

2. 任务执行中: withTextUsageCollection() 收集实际用量

3. 任务完成: settleTaskBilling()
   ├─ 写入 UsageCost 记录
   ├─ 解冻余额
   └─ 创建扣费交易

4. 任务失败/取消: rollbackTaskBilling()
   └─ 解冻余额（全额退款）
```

---

## 13. 错误处理与恢复机制

### 13.1 错误分类

```typescript
interface NormalizedError {
  message: string
  retryable: boolean
  code?: string
}
```

| 错误类型 | retryable | 处理方式 |
|---------|-----------|---------|
| 网络错误 (NETWORK_ERROR) | true | BullMQ指数退避重试 |
| 速率限制 (RATE_LIMIT) | true | BullMQ指数退避重试 |
| 空响应 (EMPTY_RESPONSE) | true | BullMQ重试 |
| 超时 (TIMEOUT) | true | BullMQ重试 |
| JSON解析错误 (SyntaxError) | true | 编排器内重试(最多3次) |
| 敏感内容 (SENSITIVE_CONTENT) | false | 标记失败，不回滚计费 |
| 无效参数 (invalidparameter) | false | 标记失败，不回滚计费 |
| TaskTerminatedError | false | 用户取消/租约过期，回滚计费 |
| 其他未知错误 | true (默认) | BullMQ重试 |

### 13.2 编排器内部重试

**文件**: `src/lib/novel-promotion/story-to-script/orchestrator.ts:185-242`

```typescript
const MAX_STEP_ATTEMPTS = 3
const MAX_RETRY_DELAY_MS = 10_000

async function runStepWithRetry(runStep, meta, prompt, action, maxTokens, parse) {
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    try {
      const output = await runStep(meta, prompt, action, maxTokens)
      const parsed = parse(output.text)
      return { output, parsed }
    } catch (error) {
      const normalized = normalizeAnyError(error)
      const shouldRetry = attempt < MAX_STEP_ATTEMPTS
        && (normalized.retryable || isRecoverableJsonParseError(error, normalized.message))

      if (!shouldRetry) break

      // 指数退避 + 随机抖动
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS)
        + Math.floor(Math.random() * 300)
      await wait(delay)
    }
  }
  throw lastError
}
```

### 13.3 去重机制

**文件**: `src/lib/task/submitter.ts`

```
相同 dedupeKey 的任务:
├─ 已存在且活跃 + BullMQ作业存活 → 返回现有任务（去重）
├─ 已存在且活跃 + BullMQ作业死亡 → 标记旧任务失败，创建新任务
└─ 已终结 → 清除dedupeKey，允许新任务
```

### 13.4 用户并发限制

**文件**: `src/lib/workers/user-concurrency-gate.ts`

每个用户每个作用域有内存信号量限制：

```typescript
// 作用域格式: {queueType}:{userId}
// 例: "image:user123", "video:user123"
// 图像和视频Worker使用此限制
```

---

## 14. 架构守护脚本

项目通过 `scripts/guards/` 下的多个脚本强制执行架构约束：

| 脚本 | 目的 | 检查范围 |
|------|------|---------|
| `no-api-direct-llm-call.mjs` | API路由禁止直接调用LLM | `src/app/api/` |
| `no-provider-guessing.mjs` | 禁止供应商猜测 | 必须存在 `pickProviderStrict()` |
| `no-model-key-downgrade.mjs` | 使用 `modelKey` 而非 `modelId` | 所有模型字段 |
| `no-hardcoded-model-capabilities.mjs` | 能力来自JSON目录 | 禁止 `VIDEO_MODELS` 等硬编码常量 |
| `no-media-provider-bypass.mjs` | 媒体生成必须经过解析器 | `generator-api.ts` 调用次数 |
| `prompt-i18n-guard.mjs` | 提示模板必须双语 | `prompts/` 目录 |

---

## 附录A：完整提示词模板

### A.1 提示词目录结构

```
lib/prompts/
├── novel-promotion/
│   ├── agent_character_profile.{en,zh}.txt    # 角色档案提取
│   ├── agent_clip.{en,zh}.txt                  # 片段切分
│   ├── agent_cinematographer.{en,zh}.txt       # 摄影规则
│   ├── agent_acting_direction.{en,zh}.txt      # 表演指导
│   ├── agent_storyboard_plan.{en,zh}.txt       # 面板规划
│   ├── agent_storyboard_detail.{en,zh}.txt     # 面板细化
│   ├── agent_storyboard_insert.{en,zh}.txt     # 插入面板
│   ├── screenplay_conversion.{en,zh}.txt       # 剧本转换
│   ├── voice_analysis.{en,zh}.txt              # 台词提取
│   ├── select_location.{en,zh}.txt             # 场景提取
│   ├── select_prop.{en,zh}.txt                 # 道具提取
│   ├── single_panel_image.{en,zh}.txt          # 单面板图像生成
│   ├── episode_split.{en,zh}.txt               # 剧集拆分
│   ├── ai_story_expand.{en,zh}.txt             # AI故事扩写
│   ├── character_create.{en,zh}.txt            # 角色创建
│   ├── character_modify.{en,zh}.txt            # 角色修改
│   ├── character_regenerate.{en,zh}.txt        # 角色外观重生成
│   ├── location_create.{en,zh}.txt             # 场景创建
│   ├── location_modify.{en,zh}.txt             # 场景修改
│   ├── image_prompt_modify.{en,zh}.txt         # 图像提示词修改
│   ├── agent_shot_variant_analysis.{en,zh}.txt # 镜头变体分析
│   ├── agent_shot_variant_generate.{en,zh}.txt # 镜头变体生成
│   └── ...
└── character-reference/
    ├── character_image_to_description.{en,zh}.txt
    └── character_reference_to_sheet.{en,zh}.txt
```

### A.2 JSON安全机制

所有提示词模板末尾均包含 **JSON SAFETY** 约束：

```
⚠️ JSON SAFETY: All quotation marks in dialogue (""''「」 etc.) MUST be
converted to corner brackets「」in JSON string values. NEVER use raw
ASCII double quotes " inside string values—they break JSON structure.
```

这是因为在中文文本中，引号（""）会频繁出现（对话、引用等），直接嵌入JSON字符串会导致解析失败。系统要求AI将文本中的所有引号替换为中文直角引号「」，确保返回的JSON可被安全解析。

### A.3 提示词变量系统

**文件**: `src/lib/prompt-i18n/catalog.ts`

```typescript
export const PROMPT_CATALOG: Record<PromptId, PromptCatalogEntry> = {
  [PROMPT_IDS.NP_AGENT_CHARACTER_PROFILE]: {
    pathStem: 'novel-promotion/agent_character_profile',
    variableKeys: ['input', 'characters_lib_info'],
  },
  [PROMPT_IDS.NP_AGENT_CLIP]: {
    pathStem: 'novel-promotion/agent_clip',
    variableKeys: ['input', 'locations_lib_name', 'characters_lib_name', 'props_lib_name', 'characters_introduction'],
  },
  [PROMPT_IDS.NP_AGENT_CINEMATOGRAPHER]: {
    pathStem: 'novel-promotion/agent_cinematographer',
    variableKeys: ['panels_json', 'panel_count', 'locations_description', 'characters_info', 'props_description'],
  },
  [PROMPT_IDS.NP_AGENT_ACTING_DIRECTION]: {
    pathStem: 'novel-promotion/agent_acting_direction',
    variableKeys: ['panels_json', 'panel_count', 'characters_info'],
  },
  [PROMPT_IDS.NP_AGENT_STORYBOARD_PLAN]: {
    pathStem: 'novel-promotion/agent_storyboard_plan',
    variableKeys: ['characters_lib_name', 'locations_lib_name', 'characters_introduction',
                    'characters_appearance_list', 'characters_full_description', 'props_description', 'clip_json', 'clip_content'],
  },
  [PROMPT_IDS.NP_AGENT_STORYBOARD_DETAIL]: {
    pathStem: 'novel-promotion/agent_storyboard_detail',
    variableKeys: ['panels_json', 'characters_age_gender', 'locations_description', 'props_description'],
  },
  [PROMPT_IDS.NP_VOICE_ANALYSIS]: {
    pathStem: 'novel-promotion/voice_analysis',
    variableKeys: ['input', 'characters_lib_name', 'characters_introduction', 'storyboard_json'],
  },
  [PROMPT_IDS.NP_SCREENPLAY_CONVERSION]: {
    pathStem: 'novel-promotion/screenplay_conversion',
    variableKeys: ['clip_content', 'locations_lib_name', 'characters_lib_name', 'props_lib_name', 'characters_introduction', 'clip_id'],
  },
  [PROMPT_IDS.NP_SINGLE_PANEL_IMAGE]: {
    pathStem: 'novel-promotion/single_panel_image',
    variableKeys: ['storyboard_text_json_input', 'source_text', 'aspect_ratio', 'style'],
  },
  // ... 共32个提示词定义
}
```

---

## 附录B：文件索引

### 核心工作流

| 功能 | 文件路径 |
|------|---------|
| Story-to-Script编排器 | `src/lib/novel-promotion/story-to-script/orchestrator.ts` |
| Script-to-Storyboard编排器 | `src/lib/novel-promotion/script-to-storyboard/orchestrator.ts` |
| 分镜阶段处理器(3-Phase) | `src/lib/storyboard-phases.ts` |
| 工作流注册表 | `src/lib/workflow-engine/registry.ts` |
| 重试失效解析 | `src/lib/workflow-engine/dependencies.ts` |
| 阶段就绪检测 | `src/lib/novel-promotion/stage-readiness.ts` |
| Clip边界匹配 | `src/lib/novel-promotion/story-to-script/clip-matching.ts` |

### 任务系统

| 功能 | 文件路径 |
|------|---------|
| 任务类型定义 | `src/lib/task/types.ts` |
| 任务提交 | `src/lib/task/submitter.ts` |
| 任务服务 | `src/lib/task/service.ts` |
| 队列配置 | `src/lib/task/queues.ts` |
| 状态对账 | `src/lib/task/reconcile.ts` |
| SSE发布 | `src/lib/task/publisher.ts` |

### GraphRun引擎

| 功能 | 文件路径 |
|------|---------|
| Run服务 | `src/lib/run-runtime/service.ts` |
| Run类型 | `src/lib/run-runtime/types.ts` |
| 租约包装 | `src/lib/run-runtime/workflow-lease.ts` |
| 恢复决策 | `src/lib/run-runtime/recovery.ts` |
| Run对账 | `src/lib/run-runtime/reconcile.ts` |
| Task-Run桥接 | `src/lib/run-runtime/task-bridge.ts` |

### Worker

| 功能 | 文件路径 |
|------|---------|
| 图像Worker | `src/lib/workers/image.worker.ts` |
| 视频Worker | `src/lib/workers/video.worker.ts` |
| 语音Worker | `src/lib/workers/voice.worker.ts` |
| 文本Worker | `src/lib/workers/text.worker.ts` |
| 共享生命周期 | `src/lib/workers/shared.ts` |
| 面板图像处理 | `src/lib/workers/handlers/panel-image-task-handler.ts` |
| 语音生成逻辑 | `src/lib/voice/generate-voice-line.ts` |
| 用户并发门 | `src/lib/workers/user-concurrency-gate.ts` |

### AI模型与生成

| 功能 | 文件路径 |
|------|---------|
| 统一生成API | `src/lib/generator-api.ts` |
| 网关路由 | `src/lib/model-gateway/router.ts` |
| AI运行时 | `src/lib/ai-runtime/client.ts` |
| 能力目录 | `src/lib/model-capabilities/catalog.ts` |
| 定价目录 | `src/lib/model-pricing/catalog.ts` |

### 资产与存储

| 功能 | 文件路径 |
|------|---------|
| 资产提示上下文 | `src/lib/assets/services/asset-prompt-context.ts` |
| 资产读取 | `src/lib/assets/services/read-assets.ts` |
| 资产合约 | `src/lib/assets/contracts.ts` |
| 存储工厂 | `src/lib/storage/factory.ts` |
| 存储类型 | `src/lib/storage/types.ts` |

### 提示词系统

| 功能 | 文件路径 |
|------|---------|
| 提示词目录 | `src/lib/prompt-i18n/catalog.ts` |
| 提示词ID | `src/lib/prompt-i18n/prompt-ids.ts` |
| 提示词模板位置 | `lib/prompts/novel-promotion/*.en.txt` / `*.zh.txt` |

### API路由

| 功能 | 文件路径 |
|------|---------|
| 故事导入流 | `src/app/api/novel-promotion/[projectId]/story-to-script-stream/route.ts` |
| 故事板流 | `src/app/api/novel-promotion/[projectId]/script-to-storyboard-stream/route.ts` |
| 面板图像再生 | `src/app/api/novel-promotion/[projectId]/regenerate-panel-image/route.ts` |
| 视频生成 | `src/app/api/novel-promotion/[projectId]/generate-video/route.ts` |
| 语音生成 | `src/app/api/novel-promotion/[projectId]/voice-generate/route.ts` |
| 唇形同步 | `src/app/api/novel-promotion/[projectId]/lip-sync/route.ts` |
| 编辑器 | `src/app/api/novel-promotion/[projectId]/editor/route.ts` |
| 任务状态SSE | `src/app/api/task-target-states/route.ts` |
| Run事件 | `src/app/api/runs/[runId]/events/route.ts` |

---

## 附录C：完整数据流全景图

```
用户上传小说文本
    │
    ▼
NovelPromotionEpisode (novelText)
    │
    ├──► STORY_TO_SCRIPT_RUN (GraphRun)
    │   │
    │   ├─ analyze_characters ──► AI LLM调用
    │   │   提示词: NP_AGENT_CHARACTER_PROFILE
    │   │   输出: { characters[], new_characters[], updated_characters[] }
    │   │   持久化: NovelPromotionCharacter[]
    │   │
    │   ├─ analyze_locations ──► AI LLM调用
    │   │   提示词: NP_SELECT_LOCATION
    │   │   输出: { locations[{name,summary,available_slots,descriptions[]}] }
    │   │   持久化: NovelPromotionLocation[]
    │   │
    │   ├─ analyze_props ──► AI LLM调用
    │   │   提示词: NP_SELECT_PROP
    │   │   输出: { props[{name,summary}] }
    │   │   持久化: NovelPromotionLocation (assetKind="prop")
    │   │
    │   ├─ split_clips ──► AI LLM调用
    │   │   提示词: NP_AGENT_CLIP
    │   │   输出: [{start,end,summary,location,characters,props}]
    │   │   处理: createClipContentMatcher() 三级边界匹配
    │   │   持久化: NovelPromotionClip[]
    │   │
    │   └─ screenplay_convert ──► AI LLM调用（每Clip并行）
    │       提示词: NP_SCREENPLAY_CONVERSION
    │       输出: { clip_id, scenes[{heading,description,content[{type,character,lines}]}] }
    │       持久化: Clip.screenplay JSON
    │
    ▼
┌────────────────────────────────────────────────────────────────┐
│ SCRIPT_TO_STORYBOARD_RUN (GraphRun)                            │
│                                                                │
│ Per-Clip (并发受控):                                           │
│ ├─ Phase 1: plan_panels ──► AI LLM调用                         │
│ │   提示词: NP_AGENT_STORYBOARD_PLAN                           │
│ │   变量: clip_json, characters_full_description, ...          │
│ │   输出: StoryboardPanel[{panel_number,description,characters, │
│ │         location,shot_type,camera_move,video_prompt,duration}]│
│ │                                                              │
│ ├─ Phase 2a: cinematography ──► AI LLM调用 (并行)              │
│ │   提示词: NP_AGENT_CINEMATOGRAPHER                           │
│ │   输出: PhotographyRule[{panel_number,composition,lighting,  │
│ │         color_palette,atmosphere,technical_notes}]           │
│ │                                                              │
│ ├─ Phase 2b: acting_direction ──► AI LLM调用 (并行)            │
│ │   提示词: NP_AGENT_ACTING_DIRECTION                          │
│ │   输出: ActingDirection[{panel_number,characters[{name,acting}]}]│
│ │                                                              │
│ ├─ Phase 3: detail_panels ──► AI LLM调用                       │
│ │   提示词: NP_AGENT_STORYBOARD_DETAIL                         │
│ │   输出: refined StoryboardPanel[]                            │
│ │   合并: mergePanelsWithRules()                               │
│ │         → panel.photographyPlan + panel.actingNotes           │
│ │                                                              │
│ └─ voice_analyze ──► AI LLM调用                                │
│     提示词: NP_VOICE_ANALYSIS                                  │
│     输出: VoiceLine[{lineIndex,speaker,content,emotionStrength,│
│           matchedPanel{storyboardId,panelIndex}}]               │
│     持久化: NovelPromotionVoiceLine[]                          │
│                                                                │
│ 持久化: NovelPromotionStoryboard + NovelPromotionPanel[]       │
└────────────────────────────────────────────────────────────────┘
    │
    ├──► IMAGE_PANEL tasks × N ──► image.worker.ts
    │   提示词: NP_SINGLE_PANEL_IMAGE
    │   变量: storyboard_text_json_input, source_text, aspect_ratio, style
    │   参考图: collectPanelReferenceImages() → 角色图+场景图+前次面板图
    │   生成: generateImage() → 供应商路由 → 生成候选图(1-4张)
    │   存储: uploadImageSourceToCos() → MediaObject
    │   更新: panel.imageUrl / candidateImages / previousImageUrl
    │
    ├──► VIDEO_PANEL tasks × N ──► video.worker.ts
    │   输入: panel.imageUrl + videoPrompt
    │   生成: generateVideo() → 供应商路由
    │   模式: normal | firstlastframe
    │   更新: panel.videoUrl / videoMediaId
    │
    ├──► VOICE_LINE tasks × N ──► voice.worker.ts
    │   输入: line.content + speaker + emotionPrompt + emotionStrength
    │   供应商: FAL(IndexTTS2) 或 Bailian(Qwen3-TTS)
    │   参考音频: resolveVoiceBindingForProvider()
    │   存储: voice/{projectId}/{episodeId}/{lineId}.wav
    │   更新: voiceLine.audioUrl / audioDuration
    │
    ├──► LIP_SYNC tasks × N ──► video.worker.ts
    │   输入: panel.videoUrl + voiceLine.audioUrl
    │   模型: fal-ai/kling-video/lipsync/audio-to-video
    │   更新: panel.lipSyncVideoUrl
    │
    ▼
VideoEditorProject (Remotion projectData JSON)
    │
    ├── 时间轴组装: panel.videoUrl/lipSyncVideoUrl + voiceLine.audioUrl
    ├── 转场配置: fade/slide/cut
    ├── 字幕层: panel.srtSegment
    └── 音频层: voiceLine.audioUrl
    │
    ▼
Remotion渲染
    │
    ▼
最终视频 → VideoEditorProject.outputUrl
    │
    ▼
MediaObject (storageKey) → Storage (MinIO/Local)
```

---

*本文档由 Claude Code 基于项目源码自动生成，反映截至 v0.4.1 的代码实现。*
