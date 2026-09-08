/**
 * 生成 Victor's CRM 系统功能介绍 Word 文档（v1.6.0 现状）
 * 依赖: npm i docx
 */
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType,
  PageBreak, BorderStyle, ShadingType,
} = require('docx');

// ---------- 辅助 ----------
function h(text, level) {
  return new Paragraph({ children: [new TextRun({ text, bold: true })], heading: level, spacing: { before: 240, after: 120 } });
}
function p(text, opts = {}) {
  return new Paragraph({ children: [new TextRun({ text, ...opts })], spacing: { after: 80 } });
}
function bullet(text) {
  return new Paragraph({ children: [new TextRun({ text })], bullet: { level: 0 }, spacing: { after: 40 } });
}
function cell(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: !!opts.bold, size: opts.size || 18 })] })],
    shading: opts.shading ? { fill: opts.shading, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
  });
}
function table(rows, widths) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((r, i) => new TableRow({
      children: r.map((c, j) => cell(c, { bold: i === 0, shading: i === 0 ? '2E5090' : undefined, width: widths ? widths[j] : undefined })),
    })),
  });
}
const run = (text, opts = {}) => new TextRun({ text, ...opts });

// ---------- 文档内容 ----------
const children = [];

// 封面
children.push(new Paragraph({ spacing: { before: 2000 } }));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [run("Victor's CRM 系统功能介绍", { bold: true, size: 48, color: '2E5090' })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 200 },
  children: [run('基于 CloudBase 的个人保险客户经营与增员管理系统', { size: 28, color: '666666' })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 400 },
  children: [run('当前版本：v1.6.0（2026-09-08）', { size: 24 })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 100 },
  children: [run('维护者：Victor', { size: 24 })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 100 },
  children: [run('文档目的：完整记录系统现状，便于后续持续优化与开发规划', { size: 22, italics: true, color: '888888' })],
}));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 目录
children.push(h('目  录', HeadingLevel.HEADING_1));
[
  '一、项目概述',
  '二、版本演进历史',
  '三、整体技术架构',
  '四、功能模块详解',
  '五、数据库设计',
  '六、云函数清单（21 个）',
  '七、AI 能力全景',
  '八、前端路由与页面',
  '九、安全设计（RLS）',
  '十、部署与运维',
  '十一、后续优化建议',
].forEach(t => children.push(p(t)));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 一、项目概述
children.push(h('一、项目概述', HeadingLevel.HEADING_1));
children.push(p("Victor's CRM 是一套面向个人保险从业者（Victor）的轻量化客户经营与增员管理系统，部署在腾讯云 CloudBase 个人版上。系统采用单页前端（admin.html）+ 事件云函数（Node.js）+ 共享集群 PostgreSQL 的三层架构，集成混元大模型（hy3）提供 AI 辅助经营能力。"));
children.push(p('核心目标：帮助保险从业者高效管理客户关系、推进增员转化、记录经营活动，并通过 AI 提供个性化经营建议与每日复盘，实现"客户经营 + 组织发展 + 活动经营 + AI 教练"四位一体的数字化经营。'));
children.push(h('1.1 系统定位', HeadingLevel.HEADING_2));
children.push(bullet('面向对象：单用户（Victor 本人），不做多租户'));
children.push(bullet('使用场景：日常客户跟进、增员招募、活动管理、AI 辅助决策'));
children.push(bullet('设计原则：轻量、无构建步骤、AI 只建议不自动写库（需用户确认）、数据安全优先'));
children.push(h('1.2 核心特性', HeadingLevel.HEADING_2));
children.push(bullet('双模块架构：客户经营 + 组织发展，v1.3 起活动经营升格为第三大顶级模块'));
children.push(bullet('7 大 AI 能力：AI 解析新增、AI 跟进建议(NBA)、AI 沟通记录、客户画像、增员画像、AI 转介绍、AI 经营复盘'));
children.push(bullet('13 张业务表 + 8 视图，全部启用 RLS 行级安全策略'));
children.push(bullet('单文件前端（admin.html），零构建，直接部署到静态托管'));
children.push(bullet('21 个事件云函数，统一通过 app.rdb() 访问 PG，无需数据库凭证'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 二、版本演进
children.push(h('二、版本演进历史', HeadingLevel.HEADING_1));
children.push(p('从 v1.0.0 到 v1.6.0，系统经历了从基础客户 CRUD 到 AI 驱动经营教练的完整演进。以下是各版本的关键里程碑：'));
children.push(table([
  ['版本', '日期', '核心特性'],
  ['v1.0.0', '2026-08', '基础客户管理：客户 CRUD、跟进记录、保单额度、礼品、照片'],
  ['v1.0.2', '2026-08', '客户/增员回收站：级联软删除 + 恢复'],
  ['v1.0.3', '2026-08', '活动量日报：客户经营 + 增员双维度，今日实时/区间查询'],
  ['v1.0.4', '2026-09', '顶部模块切换器（客户经营/组织发展）、AI 建议库筛选搜索'],
  ['v1.0.5', '2026-09', 'AI 今日经营驾驶舱：规则筛选 + AI 结构化排序，失败降级规则版'],
  ['v1.0.6', '2026-09', '今日经营升级为独立功能页（#/today），展示 15 人'],
  ['v1.0.7', '2026-09', 'AI 跟进建议升级为 Next Best Action（NBA）：7 字段结构化方案'],
  ['v1.0.9', '2026-09', 'AI 沟通记录助手 + 轻量客户画像（profile jsonb 8 维度）'],
  ['v1.0.10', '2026-09', '客户画像 AI 补全与手动编辑：逐维度勾选确认后合并写入'],
  ['v1.1.1', '2026-09', 'NBA 执行闭环：完成/跳过按钮 + 状态徽标 + 执行结果记录'],
  ['v1.1.2', '2026-09', 'NBA → 沟通记录关联：followups 加 recommendation_id，一键记录并关联'],
  ['v1.2.1', '2026-09', '客户经营机会：opportunities 表 + 经营机会 Tab + AI 机会建议'],
  ['v1.3.0', '2026-09', '轻量活动经营：activities + activity_participants 表 + 活动 CRUD + AI 分析'],
  ['v1.3.1', '2026-09', '参与者按姓名搜索关联 + 暂存机制'],
  ['v1.3.2', '2026-09', '活动经营升格为第三大顶级模块（顶部导航玫红色高亮）'],
  ['v1.4.0', '2026-09', '轻量转介绍经营：转介绍线索 + AI 转介绍建议 + 进入今日经营'],
  ['v1.5.0', '2026-09', '增员候选人 AI 画像：profile jsonb 10 维度 + 人生事件 + AI 补全'],
  ['v1.6.0', '2026-09', 'AI 经营教练第一期：AI 每日经营复盘（今日/最近 7 天，7 段结构化输出）'],
], [1200, 1200, 6600]));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 三、技术架构
children.push(h('三、整体技术架构', HeadingLevel.HEADING_1));
children.push(h('3.1 架构分层', HeadingLevel.HEADING_2));
children.push(p('系统采用经典的三层架构，所有数据访问与 AI 调用均在云函数内完成，前端不直连数据库或 AI。'));
children.push(table([
  ['层级', '技术', '说明'],
  ['前端层', 'admin.html（单文件，原生 JS，无框架）', '@cloudbase/js-sdk CDN，callFunction 同域调用，零构建'],
  ['服务层', 'CloudBase 事件云函数 ×21（Nodejs18.15, CommonJS）', '统一共享模块 db.js（rdb() + AI 封装），@cloudbase/node-sdk@^4'],
  ['数据层', 'PostgreSQL 共享集群（SHARED）', 'app.rdb() 访问，不启用 VPC，无 PG 凭证'],
  ['AI 层', '混元大模型 hy3（cloudbase 组）', 'app.ai().createModel("cloudbase").generateText({model:"hy3"})'],
  ['存储层', 'CloudBase Storage（bucket: recruit，私有）+ photos 表（base64）', '增员文件走 signed URL；照片 base64 存库'],
], [1500, 3000, 4500]));
children.push(h('3.2 关键技术约束', HeadingLevel.HEADING_2));
children.push(bullet('AI 只用 hy3，禁止第三方 Key（无 deepseek/openai）'));
children.push(bullet('数据访问仅 app.rdb()（node-sdk 4.x），无 PGHOST/PGPASSWORD 等凭证'));
children.push(bullet('共享集群 PG，不启用 VPC'));
children.push(bullet('照片 base64 存 photos 表，不调多模态，不开云存储匿名登录'));
children.push(bullet('所有 SQL 参数化（$1, $2, ...），空串统一转 null'));
children.push(bullet('前端 apiBase 留空，通过 callFunction 同域调用'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 四、功能模块详解
children.push(h('四、功能模块详解', HeadingLevel.HEADING_1));

// 4.1 客户经营
children.push(h('4.1 客户经营模块', HeadingLevel.HEADING_2));
children.push(p('客户经营是系统的核心模块，覆盖客户全生命周期管理：建档 → 跟进 → 需求挖掘 → 方案 → 成交 → 转介绍。'));
children.push(h('4.1.1 客户工作台（#/）', HeadingLevel.HEADING_3));
children.push(bullet('分类统计卡：全部 / 今日待跟进 / 未来30天到期 / 已逾期 / 30天未联系 / 增员中'));
children.push(bullet('点击统计卡即筛选下方客户表格，支持排序（下次跟进日期、客户阶段、销售优先级等）'));
children.push(bullet('关键词搜索：姓名 / 电话 / 职业'));
children.push(bullet('快捷入口：今日经营、新增客户、全部客户、AI 解析新增、AI 建议、活动量'));
children.push(h('4.1.2 客户详情（#/customer/:id，7 个 Tab）', HeadingLevel.HEADING_3));
children.push(table([
  ['Tab', '功能', '关联云函数'],
  ['基本信息', '客户资料编辑（姓名、电话、职业、收入、MBTI、阶段、优先级等）', 'customers'],
  ['跟进记录', '跟进 CRUD + 下次跟进日期/目标 + NBA 关联徽标', 'followups, ai_recommendations'],
  ['保单检视', '保单额度（11 项 ap_* + items JSON）+ AI 5 段检视报告', 'products, policy_review_reports'],
  ['客户画像', 'profile jsonb（8 维度 + 人生事件），AI 补全 + 手动编辑 + 建议确认', 'ai_followup, customers'],
  ['经营机会', '机会 CRUD（含转介绍线索），AI 机会建议确认后创建', 'opportunities, ai_followup'],
  ['礼品', '伴手礼记录 CRUD', 'gifts'],
  ['照片', '照片 base64 存储，list 只返元数据', 'photos'],
], [1400, 4600, 3000]));
children.push(h('4.1.3 客户经营阶段（6 段）', HeadingLevel.HEADING_3));
children.push(p('新认识 → 关系维护 → 需求挖掘 → 方案沟通 → 成交推进 → 转介绍经营'));
children.push(h('4.1.4 回收站（#/customers/trash）', HeadingLevel.HEADING_3));
children.push(bullet('删除客户 = 级联软删除（deleted_at 标记，跟进/礼品/照片/报告/OCR/产品/AI建议 一并标记）'));
children.push(bullet('支持逐行恢复与批量恢复，恢复时级联恢复所有子记录'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 4.2 AI 客户经营能力
children.push(h('4.2 AI 客户经营能力', HeadingLevel.HEADING_2));
children.push(h('4.2.1 AI 解析新增（ai_parse）', HeadingLevel.HEADING_3));
children.push(bullet('粘贴名片/聊天文本 → hy3 解析为客户资料（姓名/电话/职业/收入等）'));
children.push(bullet('可选存图，解析结果回填表单供用户确认后入库'));
children.push(bullet('超时 120s'));
children.push(h('4.2.2 AI 跟进建议 / Next Best Action（ai_recommend）', HeadingLevel.HEADING_3));
children.push(bullet('基于客户画像 + 历史跟进，生成 7 字段结构化 NBA：assessment / goal / next_action / topic / avoid / success_criteria'));
children.push(bullet('写入 ai_recommendations 表（nba jsonb 列），可在详情页与今日经营页展示'));
children.push(bullet('支持 update_status：完成（记录执行结果）/ 跳过（记录原因）'));
children.push(h('4.2.3 AI 沟通记录助手（ai_followup.parse）', HeadingLevel.HEADING_3));
children.push(bullet('口语化描述 → 结构化跟进记录（跟进内容、日期换算、枚举清洗）'));
children.push(bullet('两步确认：可编辑 + 追加附加信息 + 阶段建议勾选'));
children.push(bullet('支持关联最近 3 条未完成 NBA（recommendation_id）'));
children.push(h('4.2.4 客户画像 AI 补全（ai_followup.analyze_profile）', HeadingLevel.HEADING_3));
children.push(bullet('通读近 50 条历史跟进 → 生成 8 维度画像建议（家庭/子女/父母/事业/需求/关系/爱好/职业）'));
children.push(bullet('AI 只返回建议不写库，用户逐维度勾选确认后合并写入 profile jsonb'));
children.push(bullet('合并规则：文本维度覆盖（仅勾选的），人生事件按文本追加去重'));
children.push(h('4.2.5 AI 转介绍建议（ai_referral）', HeadingLevel.HEADING_3));
children.push(bullet('基于客户关系阶段判断是否适合开口转介绍'));
children.push(bullet('输出 NBA 结构（assessment/goal/next_action/topic/avoid/success_criteria）'));
children.push(bullet('只建议需确认，转介绍线索进入今日经营候选池'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 4.3 组织发展（增员）
children.push(h('4.3 组织发展模块（增员）', HeadingLevel.HEADING_2));
children.push(p('增员模块管理增员候选人的招募全流程，采用 7 阶段漏斗模型。'));
children.push(h('4.3.1 增员工作台（#/recruit）', HeadingLevel.HEADING_3));
children.push(bullet('漏斗视图：7 阶段各阶段人数 + 转化率'));
children.push(bullet('候选人列表：支持筛选、排序'));
children.push(bullet('候选人姓名来自关联客户（customer_id → customers.customer_name）'));
children.push(h('4.3.2 增员阶段（7 段）', HeadingLevel.HEADING_3));
children.push(p('新增人才 → 互动暖客 → 初次面谈 → 增员活动 → 精准面谈 → 入职申请 → 签约入司'));
children.push(bullet('阶段变更自动写入 recruit_milestones 事件流，用于候选时间线展示'));
children.push(h('4.3.3 增员详情（#/recruit/:id，5 个 Tab）', HeadingLevel.HEADING_3));
children.push(table([
  ['Tab', '功能', '关联云函数'],
  ['基本信息', '候选人资料（动机、顾虑、工作经历、家庭情况、性格标签、职业规划）', 'recruit_candidates'],
  ['跟进记录', '增员跟进 CRUD（联系方式、意向度、顾虑反馈）', 'recruit_followups'],
  ['候选人画像', 'profile jsonb（10 维度 + 人生事件），AI 补全 + 手动编辑', 'ai_followup, recruit_candidates'],
  ['AI 评分', '6 维度加权高潜评分 + 雷达图 + AI 理由', 'recruit_score'],
  ['AI 接触建议', 'STAR 异议处理 + 称呼规则 + 五步法 NBA', 'recruit_recommend'],
], [1400, 4600, 3000]));
children.push(h('4.3.4 增员候选人画像（v1.5.0）', HeadingLevel.HEADING_3));
children.push(p('10 维度画像，复用客户 profile 设计思想（jsonb 单列 + AI 建议 + 用户确认 + 事件追加去重）：'));
children.push(bullet('职业背景、家庭情况、当前工作状态、职业诉求、收入诉求、创业动机、保险行业认知、主要顾虑、关键影响人'));
children.push(bullet('重要人生事件（数组，按 date + text 追加去重，上限 20 条）'));
children.push(bullet('AI 从 recruit_followups + 候选人资料 + 历史沟通提取，只建议不写库'));
children.push(h('4.3.5 目标管理（#/recruit/goals）', HeadingLevel.HEADING_3));
children.push(bullet('月度目标设置（7 阶段各阶段目标人数）'));
children.push(bullet('getProgress：与行业基准（recruit_goal_benchmarks）对照，展示转化率趋势'));
children.push(bullet('行业基准可自定义（7 阶段 min/avg/good 转化率）'));
children.push(h('4.3.6 增员回收站（#/recruit/trash）', HeadingLevel.HEADING_3));
children.push(bullet('删除候选人 = 级联软删除（跟进记录一并标记），可恢复'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 4.4 活动经营
children.push(h('4.4 活动经营模块（v1.3）', HeadingLevel.HEADING_2));
children.push(p('活动经营是 v1.3 新增的第三大顶级模块，管理客户/增员参与的经营活动。'));
children.push(h('4.4.1 活动列表与详情', HeadingLevel.HEADING_3));
children.push(bullet('活动 CRUD：名称、活动日期、活动类型、地点、描述'));
children.push(bullet('参与者管理：支持客户和增员两类人员（person_type=customer/recruit）'));
children.push(bullet('添加参与者：按姓名搜索，库中匹配则关联，未匹配可按姓名暂存（后续一键关联）'));
children.push(bullet('参与者状态：待确认/已确认/已参加/缺席，支持关系备注'));
children.push(h('4.4.2 AI 活动分析（ai_activity）', HeadingLevel.HEADING_3));
children.push(bullet('基于活动信息 + 参与者，AI 生成活动分析与跟进建议'));
children.push(bullet('为每个参与者生成 suggested_action（建议跟进动作）'));
children.push(h('4.4.3 活动与跟进关联', HeadingLevel.HEADING_3));
children.push(bullet('followups 表加 activity_id 列，跟进记录可关联到具体活动'));
children.push(bullet('客户/增员详情可查看其参与的所有活动（listByPerson）'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 4.5 AI 经营教练
children.push(h('4.5 AI 经营教练（v1.6.0 第一期）', HeadingLevel.HEADING_2));
children.push(p('AI 经营教练是 v1.6.0 引入的新模块，目标是整合客户经营、增员、活动等数据，为 Victor 提供智能经营复盘与建议。第一期实现"AI 每日经营复盘"。'));
children.push(h('4.5.1 AI 每日经营复盘（today_coach.daily_review）', HeadingLevel.HEADING_3));
children.push(p('聚合当日（或最近 7 天）10 类经营数据，AI 生成 7 段结构化复盘，控制在 300~500 字，必须具体不空泛。'));
children.push(h('输入数据（10 类）', HeadingLevel.HEADING_4));
children.push(bullet('客户新增、客户沟通（跟进）、NBA 推荐、机会变化（含转介绍）、活动'));
children.push(bullet('增员新增、增员沟通、增员阶段变化'));
children.push(h('输出结构（7 段）', HeadingLevel.HEADING_4));
children.push(bullet('今日经营概况（含关键数字）'));
children.push(bullet('今天完成得最好的一件事（具体到人+事）'));
children.push(bullet('今天最大的经营缺口（具体未做什么）'));
children.push(bullet('重要客户变化（1-3 人，含姓名+变化）'));
children.push(bullet('重要增员变化（1-3 人，含姓名+变化）'));
children.push(bullet('明天最重要的 3 件事（有序列表）'));
children.push(bullet('一条经营建议（具体可执行，不点泛泛的话）'));
children.push(h('使用方式', HeadingLevel.HEADING_4));
children.push(bullet('今日经营页头部新增「今日复盘」「最近 7 天复盘」按钮'));
children.push(bullet('点击后调用 today_coach.daily_review，结果展示在 NBA 列表下方'));
children.push(bullet('不写库，不缓存（每次实时生成）'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 4.6 今日经营驾驶舱
children.push(h('4.6 今日经营驾驶舱（#/today）', HeadingLevel.HEADING_2));
children.push(p('今日经营驾驶舱整合客户与增员的今日重点经营对象，通过规则筛选 + AI 排序生成 Top 15 行动清单。'));
children.push(h('4.6.1 规则筛选（不调 AI，快）', HeadingLevel.HEADING_3));
children.push(bullet('客户池（Top 12）：跟进逾期/今日待跟进/30天未联系/近期活跃/新客户/重点客户/转介绍线索'));
children.push(bullet('增员池（Top 9）：新阶段/今日待推进/近期接触/高潜评分/从未跟进待破冰'));
children.push(h('4.6.2 AI 排序 + NBA 生成', HeadingLevel.HEADING_3));
children.push(bullet('AI 综合紧迫度、经营价值、阶段节奏排序，为每人生成 NBA'));
children.push(bullet('客户若 14 天内已有详情页 NBA → 直接引用（nba_from=detail）'));
children.push(bullet('AI 失败自动降级为规则版（source=rule）'));
children.push(h('4.6.3 缓存策略', HeadingLevel.HEADING_3));
children.push(bullet('localStorage 按天缓存，打开页面不调 AI'));
children.push(bullet('数据指纹（五表 max updated_at）变化时提示"建议重新生成"'));
children.push(bullet('「重新生成今日建议」主动刷新'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 五、数据库设计
children.push(h('五、数据库设计', HeadingLevel.HEADING_1));
children.push(h('5.1 业务表清单（18 张）', HeadingLevel.HEADING_2));
children.push(table([
  ['业务域', '表名', '主键', '说明'],
  ['客户域', 'customers', 'Id', '中心表，含 profile jsonb、sales_priority、customer_stage 等'],
  ['', 'followups', 'Id', '跟进记录，含 followup_notes、next_followup_date、recommendation_id'],
  ['', 'products', 'id', '保单额度（11 个 ap_* + items JSON）'],
  ['', 'gifts', 'Id', '伴手礼记录'],
  ['', 'photos', 'id', '照片 base64 存储（data URL）'],
  ['', 'ai_recommendations', 'id', 'AI 建议历史（nba jsonb + status）'],
  ['画像增强', 'policy_review_reports', 'id', '保单检视 AI 报告（5 段 + edited_* 双写区）'],
  ['', 'ocr_records', 'id', 'OCR 记录 + customer_snapshot（可恢复）'],
  ['经营机会', 'opportunities', 'id', '经营机会（含转介绍线索：referred_name、status）'],
  ['活动经营', 'activities', 'id', '活动（name、activity_date、activity_type、location、description）'],
  ['', 'activity_participants', 'id', '活动参与者（person_type、person_id、person_name、status）'],
  ['增员域', 'recruit_candidates', 'id', '候选人（7 阶段 + profile jsonb + potential_score）'],
  ['', 'recruit_milestones', 'id', '阶段变更事件流'],
  ['', 'recruit_followups', 'id', '增员跟进（contact_method、interest_level、concern_feedback）'],
  ['', 'recruit_goals', 'id', '月度目标'],
  ['', 'recruit_goal_benchmarks', 'id', '行业基准（7 阶段 min/avg/good）'],
], [1200, 2200, 1200, 4400]));
children.push(h('5.2 视图清单（8 个）', HeadingLevel.HEADING_2));
children.push(table([
  ['视图', '用途'],
  ['customers_view / followups_view / gifts_view / photos_view / products_view / ai_recommendations_view', '6 张配套视图，已 REVOKE anon（防 owner 绕过 RLS）'],
  ['v_recruit_candidates', '增员候选人完整画像 JOIN customers（含 idle_days、profile）'],
  ['v_recruit_candidates_trash', '增员回收站（软删除候选人 + 客户基础信息）'],
], [3500, 5500]));
children.push(h('5.3 关键设计', HeadingLevel.HEADING_2));
children.push(bullet('客户 Id 大写 I（IDENTITY BY DEFAULT），增员 id 小写（bigserial）—— 历史遗留，需注意'));
children.push(bullet('profile jsonb：客户 8 维度 + 人生事件；增员 10 维度 + 人生事件'));
children.push(bullet('nba jsonb：AI 跟进建议 7 字段结构化存储'));
children.push(bullet('软删除：主对象（customers/recruit_candidates/activities/opportunities）deleted_at 级联子表'));
children.push(bullet('增员候选人姓名不存冗余，通过 customer_id JOIN customers 获取'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 六、云函数清单
children.push(h('六、云函数清单（21 个）', HeadingLevel.HEADING_1));
children.push(table([
  ['业务域', '云函数', '超时', 'Actions', '说明'],
  ['客户 CRUD', 'customers', '10s', 'list/get/create/update/remove/trashList/restore', '客户 CRUD + 回收站'],
  ['', 'followups', '10s', 'list/create/update/remove', '跟进记录 CRUD'],
  ['', 'products', '10s', 'list/upsert/remove', '保单额度 upsert'],
  ['', 'gifts', '10s', 'list/create/update/remove', '伴手礼 CRUD'],
  ['', 'photos', '10s', 'list/get/create/update/remove', '照片存储'],
  ['经营机会', 'opportunities', '10s', 'list/create/update/close/remove', '经营机会 CRUD（含转介绍）'],
  ['活动经营', 'activities', '10s', 'list/get/create/update/remove/addParticipant/searchPerson/linkParticipant/updateParticipant/removeParticipant/listByPerson', '活动 + 参与者管理'],
  ['AI 生成', 'ai_parse', '120s', '（默认）', 'AI 文本解析→客户资料'],
  ['', 'ai_recommend', '120s', '（默认）', 'AI 跟进建议 NBA→写 ai_recommendations'],
  ['', 'ai_followup', '120s', 'parse/analyze_profile/analyze_recruit_profile', 'AI 沟通记录 + 客户/增员画像'],
  ['', 'ai_referral', '120s', '（默认）', 'AI 转介绍建议'],
  ['', 'ai_activity', '120s', 'analyze', 'AI 活动分析'],
  ['', 'policy_review_reports', '120s', 'list/get/update/remove/generate', '保单检视报告'],
  ['AI 历史', 'ai_recommendations', '10s', 'list/listAll/get/create/update/update_status', 'AI 建议历史（含 NBA 状态）'],
  ['', 'ocr_records', '10s', 'list/create/update/remove', 'OCR 记录（可恢复）'],
  ['活动量', 'activity_reports', '10s', 'customer/recruit', '客户+增员双轨活动量日报'],
  ['今日经营', 'today_coach', '120s', 'candidates/generate/daily_review', '今日经营驾驶舱 + AI 经营复盘'],
  ['增员', 'recruit_candidates', '10s', 'list/get/create/update/remove/trashList/restore/funnel', '候选人 CRUD + 漏斗'],
  ['', 'recruit_followups', '10s', 'list/create/update/remove', '增员跟进 CRUD'],
  ['', 'recruit_goals', '10s', 'listGoals/saveGoals/getProgress/listBenchmarks/saveBenchmarks', '目标管理 + 行业基准'],
  ['', 'recruit_score', '120s', '（默认）', 'AI 高潜评分（6 维度加权）'],
  ['', 'recruit_recommend', '120s', '（默认）', 'AI 接触建议（STAR + 五步法）'],
], [900, 1600, 700, 3000, 3300]));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 七、AI 能力全景
children.push(h('七、AI 能力全景', HeadingLevel.HEADING_1));
children.push(p('系统共有 7 个 AI 云函数调用 hy3，覆盖客户经营全流程。所有 AI 函数统一原则：AI 只生成建议，用户确认后才写入数据库；信息不足时返回"信息不足"而非编造。'));
children.push(table([
  ['AI 能力', '云函数', '输入', '输出', '写库'],
  ['AI 解析新增', 'ai_parse', '名片/聊天文本', '客户资料 JSON', '否（用户确认后 customers.create）'],
  ['AI 跟进建议(NBA)', 'ai_recommend', '客户画像+跟进', '7 字段 NBA', '是（ai_recommendations）'],
  ['AI 沟通记录', 'ai_followup.parse', '口语描述', '结构化跟进记录', '否（用户确认后 followups.create）'],
  ['客户画像 AI 补全', 'ai_followup.analyze_profile', '近 50 条跟进', '8 维度画像建议', '否（用户确认后 customers.update profile）'],
  ['增员画像 AI 补全', 'ai_followup.analyze_recruit_profile', '增员资料+跟进', '10 维度画像建议', '否（用户确认后 recruit_candidates.update profile）'],
  ['AI 转介绍建议', 'ai_referral', '客户关系阶段', 'NBA 结构建议', '否（用户确认后 opportunities.create）'],
  ['AI 活动分析', 'ai_activity', '活动+参与者', '活动分析+参与者建议', '否'],
  ['AI 经营复盘', 'today_coach.daily_review', '10 类经营数据', '7 段复盘', '否'],
  ['AI 高潜评分', 'recruit_score', '候选人 6 维度', '评分+理由+雷达图', '是（recruit_candidates.potential_score）'],
  ['AI 增员接触建议', 'recruit_recommend', '候选人资料', 'STAR+五步法 NBA', '否'],
  ['AI 保单检视', 'policy_review_reports.generate', '保单额度', '5 段检视报告', '是（policy_review_reports）'],
], [1500, 1600, 1800, 1800, 1900]));
children.push(h('7.1 AI 安全原则', HeadingLevel.HEADING_2));
children.push(bullet('信息不足规则：资料不足以判断的字段必须填"信息不足"，严禁编造客户家庭/收入/需求/意向'));
children.push(bullet('AI 只建议不写库：除 ai_recommend（NBA 历史）、recruit_score（评分）、policy_review_reports（检视报告）外，其余 AI 函数只返回建议'));
children.push(bullet('用户确认机制：画像/沟通记录/转介绍等需用户勾选确认后才写入'));
children.push(bullet('降级兜底：today_coach AI 失败自动降级规则版，不阻塞页面'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 八、前端路由
children.push(h('八、前端路由与页面', HeadingLevel.HEADING_1));
children.push(table([
  ['路由', '页面', '说明'],
  ['#/', '客户工作台', '分类统计卡 + 客户表格 + 快捷入口'],
  ['#/customers', '全部客户', '客户列表 + 搜索 + 筛选'],
  ['#/customers/trash', '客户回收站', '已删除客户 + 恢复'],
  ['#/customer/:id', '客户详情', '7 个 Tab（基本信息/跟进/保单/画像/机会/礼品/照片）'],
  ['#/ai-suggestions', 'AI 建议历史', '按姓名/日期筛选 AI 建议库'],
  ['#/activity/customer', '客户活动量日报', '今日实时 + 区间查询'],
  ['#/today', '今日经营', 'Top 15 行动清单 + AI 经营复盘'],
  ['#/recruit', '增员工作台', '漏斗 + 候选人列表'],
  ['#/recruit/goals', '目标管理', '月度目标 + 行业基准对比'],
  ['#/recruit/trash', '增员回收站', '已删除候选人 + 恢复'],
  ['#/activity/recruit', '增员活动量日报', '今日实时 + 区间查询'],
  ['#/recruit/:id', '增员详情', '5 个 Tab（信息/跟进/画像/评分/建议）'],
  ['#/activity', '活动经营', '活动列表 + 详情 + 参与者 + AI 分析'],
], [1800, 1500, 4700]));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 九、安全设计
children.push(h('九、安全设计（RLS）', HeadingLevel.HEADING_1));
children.push(p('共享集群 PG 的 REST API 默认对匿名 token（role=anon）开放，云函数 app.rdb() 的实际身份也是 anon。为防止匿名直读客户数据，所有业务表全部启用 RLS。'));
children.push(h('9.1 RLS 策略（fn_only）', HeadingLevel.HEADING_2));
children.push(p('每张表的 policy 统一为 <table>_fn_only：'));
children.push(p("USING (current_setting('request.jwt.claims', true)::json->>'sub' IS NULL AND current_setting('request.jwt.claims', true)::json->>'role' = 'anon')", { color: 'C00000' }));
children.push(p('原理：云函数 token 不含 sub（仅 aud/exp/iat/iss/role），而任何用户 token（匿名 REST / js-sdk 登录）都带 sub。因此只有云函数能访问业务表。'));
children.push(h('9.2 纵深防御', HeadingLevel.HEADING_2));
children.push(bullet('GRANT SELECT/INSERT/UPDATE/DELETE 授予 anon（表级放行，行级由 policy 收口）'));
children.push(bullet('6 张 *_view 视图 REVOKE anon（视图以 owner 身份执行会绕过表 RLS）'));
children.push(bullet('2 张增员视图显式 GRANT SELECT TO anon（基表已 RLS，视图读出的已是安全数据）'));
children.push(bullet('网关 OPA 策略 authz.user.rego 显式 deny 匿名调用云函数'));
children.push(bullet('登录账号 crm_admin（PG 模式不支持自助注册，需手动 createUser）'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 十、部署与运维
children.push(h('十、部署与运维', HeadingLevel.HEADING_1));
children.push(h('10.1 环境信息', HeadingLevel.HEADING_2));
children.push(table([
  ['项', '值'],
  ['EnvId', 'crm-d1gkae8ddc930d151'],
  ['Region', 'ap-shanghai'],
  ['PackageId', 'baas_personal（个人版，资源点模式）'],
  ['后端', 'PostgreSQL 共享型 SHARED，不启用 VPC'],
  ['AI', 'hy3（cloudbase 组，Status=1）'],
  ['静态托管', 'crm-d1gkae8ddc930d151-1434199662.tcloudbaseapp.com'],
  ['登录账号', 'crm_admin'],
], [2000, 7000]));
children.push(h('10.2 日常迭代发布流程', HeadingLevel.HEADING_2));
children.push(bullet('1. 改代码 → MCP/SDK 部署云函数 + 上传 admin.html'));
children.push(bullet('2. 运行 tools/release.ps1 -Message "说明" [-Tag vX.Y.Z]：git 提交 + 推送 + 打标签'));
children.push(bullet('3. 自动调用 tools/sync-check.ps1 三方一致性体检（工作区/GitHub/线上 MD5）'));
children.push(h('10.3 命名规范', HeadingLevel.HEADING_2));
children.push(bullet('项目自有 .md 文件统一英文 kebab-case，禁止中文文件名和日期格式文件名'));
children.push(bullet('release.ps1 提交前自动检查 .md 命名规范，违规则中止'));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 十一、后续优化建议
children.push(h('十一、后续优化建议', HeadingLevel.HEADING_1));
children.push(p('基于 v1.6.0 现状，以下是可考虑的后续优化方向，按优先级排列：'));
children.push(h('11.1 AI 经营教练后续期', HeadingLevel.HEADING_2));
children.push(bullet('月报：扩展 daily_review 支持月度复盘（当前仅今日/7天）'));
children.push(bullet('经营趋势：对比近 7 天/30 天经营数据趋势，识别效率变化'));
children.push(bullet('个性化建议：基于历史复盘结果，学习 Victor 的经营习惯，给出更精准建议'));
children.push(bullet('复盘存档：将每日复盘存入数据库，支持历史复盘回看'));
children.push(h('11.2 客户经营增强', HeadingLevel.HEADING_2));
children.push(bullet('客户 360° 视图：整合跟进/保单/机会/活动/转介绍的时间线'));
children.push(bullet('智能提醒：逾期跟进、沉睡客户、生日/纪念日自动提醒'));
children.push(bullet('客户标签体系：当前仅 sales_priority，可增加行业/渠道/关系强度等标签'));
children.push(h('11.3 增员经营增强', HeadingLevel.HEADING_2));
children.push(bullet('增员活动管理：与活动经营模块联动，追踪候选人参加活动情况'));
children.push(bullet('入职流程管理：签约入司后的入职进度跟踪'));
children.push(bullet('团队管理：如果未来发展团队，可增加下属管理视图'));
children.push(h('11.4 数据与性能', HeadingLevel.HEADING_2));
children.push(bullet('分页优化：客户列表当前全量加载，数据量大时需分页'));
children.push(bullet('搜索优化：当前前端过滤，可考虑后端搜索'));
children.push(bullet('数据备份自动化：当前手动备份，可增加定时备份'));
children.push(h('11.5 体验优化', HeadingLevel.HEADING_2));
children.push(bullet('移动端适配：当前主要桌面端，可优化移动端体验'));
children.push(bullet('快捷操作：批量跟进、批量阶段变更等'));
children.push(bullet('数据可视化：经营漏斗、转化率趋势图表（当前轻量 div 图表）'));
children.push(new Paragraph({ spacing: { before: 400 } }));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [run('—— 文档结束 ——', { italics: true, color: '888888', size: 20 })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 100 },
  children: [run("Victor's CRM v1.6.0 · 2026-09-08", { color: '888888', size: 18 })],
}));

// ---------- 生成文档 ----------
const doc = new Document({
  sections: [{
    properties: {},
    children,
  }],
});

Packer.toBuffer(doc).then(buffer => {
  const outPath = path.join(__dirname, '..', 'docs', 'crm-system-overview-v1.6.0.docx');
  fs.writeFileSync(outPath, buffer);
  console.log('文档已生成:', outPath);
  console.log('大小:', (buffer.length / 1024).toFixed(1), 'KB');
}).catch(e => { console.error(e); process.exit(1); });
