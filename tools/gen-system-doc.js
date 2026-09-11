/**
 * 生成 Victor's CRM 系统说明文档 (DOCX) —— 唯一事实来源
 * 输出: docs/system-documentation.docx （不带版本号，始终代表最新；封面标注当前版本）
 * 系统变更后更新本脚本并重新生成。
 */
const DOC_VERSION = 'v1.8.7';
const DOC_DATE = '2026-09-10';
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  PageBreak, Header, Footer, PageNumber, NumberFormat,
  TableOfContents, StyleLevel, convertInchesToTwip, LevelFormat,
} = require('docx');

const BLUE = '2563eb', PINK = 'db2777', PURPLE = '7c3aed', CYAN = '0891b2';
const GOLD = 'd4a017', GREEN = '059669', GRAY = '64748b', DARK = '1e293b', LIGHT_BG = 'f1f5f9';

// helpers
const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 200 }, children: [new TextRun({ text, bold: true, size: 32, color: DARK })] });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 160 }, children: [new TextRun({ text, bold: true, size: 26, color: BLUE })] });
const h3 = (text, color) => new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 220, after: 120 }, children: [new TextRun({ text, bold: true, size: 22, color: color || PURPLE })] });
const p = (text, opts) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text, size: 21, ...(opts || {}) })] });
const pBold = (text) => p(text, { bold: true });
const pColor = (text, color) => p(text, { color });
const bullet = (text, level) => new Paragraph({ bullet: { level: level || 0 }, spacing: { after: 60 }, children: [new TextRun({ text, size: 20 })] });
const spacer = () => new Paragraph({ spacing: { after: 100 }, children: [] });
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

function tbl(headers, rows, colWidths) {
  const hdrCells = headers.map((h, i) => new TableCell({
    width: colWidths ? { size: colWidths[i], type: WidthType.PERCENTAGE } : undefined,
    shading: { type: ShadingType.SOLID, color: '2563eb' },
    children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'ffffff', size: 19 })] })],
  }));
  const dataRows = rows.map(row => new TableRow({
    children: row.map(cell => new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: String(cell || ''), size: 18 })] })],
    })),
  }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: hdrCells }), ...dataRows],
  });
}

const sections = [];

// ===== 封面 =====
sections.push(new Paragraph({ spacing: { before: 3000 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Victor's CRM", size: 52, bold: true, color: DARK })] }));
sections.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: '系统说明文档', size: 40, bold: true, color: BLUE })] }));
sections.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: DOC_VERSION + ' — AI 经营驾驶舱 + 三漏斗 + Quick Capture', size: 26, color: GRAY })] }));
sections.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [new TextRun({ text: DOC_DATE, size: 22, color: GRAY })] }));
sections.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'CloudBase: crm-d1gkae8ddc930d151', size: 18, color: GRAY })] }));
sections.push(pageBreak());

// ===== 目录 =====
sections.push(h1('目录'));
sections.push(new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' }));
sections.push(pageBreak());

// ===== 1. 系统概述 =====
sections.push(h1('1. 系统概述'));
sections.push(h2('1.1 项目简介'));
sections.push(p("Victor's CRM 是一套基于腾讯云开发（CloudBase）的轻量级保险行业客户关系管理系统，面向保险代理人提供客户经营、活动管理、增员追踪、AI 智能建议等一体化能力。"));
sections.push(p('系统采用 Serverless 架构，前端为单文件 HTML 应用（无框架、无构建工具），后端为云函数 + PostgreSQL，所有数据访问通过云函数中转，前端不直连数据库。'));
sections.push(p('v1.8.x 系列重构了首页为"AI 经营驾驶舱"，核心目标是帮助代理人决定今天做什么，并提供客户/机会/增员三漏斗的事实展示 + AI 解读能力。'));
sections.push(spacer());

sections.push(h2('1.2 技术栈'));
sections.push(tbl(
  ['层次', '技术', '说明'],
  [
    ['前端', '原生 HTML + JS + CSS', '单文件 admin.html（~430KB），无框架/构建工具，通过 callFn 调云函数'],
    ['后端', 'Node.js 云函数', '25 个云函数，rdb 链式 API 访问 PostgreSQL'],
    ['数据库', 'PostgreSQL (CloudBase 共享集群)', '20 张业务表 + 9 个视图，RLS 行级安全'],
    ['AI 文本模型', 'Hunyuan hy3', 'generateText API，结构化 JSON 输出；21 处调用'],
    ['AI 视觉模型', 'glm-5v-turbo', '多模态图片 OCR + 客户资料提取（hy3 不支持图片）'],
    ['存储', 'CloudBase 云存储', '客户照片、增员雷达图/报告等文件'],
    ['托管', 'CloudBase 静态托管', 'admin.html 单页部署，根路径直接服务'],
    ['部署', 'tcb CLI + MCP', '命令行/MCP 双通道部署云函数与前端'],
  ],
  [18, 28, 54]
));
sections.push(spacer());

sections.push(h2('1.3 设计原则'));
sections.push(bullet('驾驶舱优先：首页核心目标是帮助决定今天做什么，不显示大量统计卡片/表格/AI 评分/历史数据'));
sections.push(bullet('AI 只建议不直接改：AI 输出分析结果与建议，不写核心业务数据（阶段/机会/客户字段保持由用户确认）'));
sections.push(bullet('信息不足透明返回："样本不足，暂不能判断。"而非虚构数据/成功率/ROI/因果'));
sections.push(bullet('三漏斗复用现有字段：不新建 Funnel 业务表，用 customer_stage / opportunities.status / recruit_candidates.stage 实现'));
sections.push(bullet('AI 失败降级：AI 超时/失败自动降级规则版，绝不导致页面白屏（funnel_insight 50s 超时回退）'));
sections.push(bullet('小步提交：每个版本独立验收，不跨版本耦合；改 db.js 同步所有受影响函数目录'));
sections.push(bullet('RLS 全覆盖：14 张业务表启用 fn_only 策略，仅云函数可访问'));
sections.push(bullet('敏感文件永不入库：数据库信息.txt、测试文件不入 git、不部署托管'));
sections.push(spacer());

sections.push(h2('1.4 顶部导航三模块'));
sections.push(p('顶部导航为三个并列顶级模块，按业务流向排列：'));
sections.push(tbl(
  ['模块', '颜色', '路由前缀', '职责'],
  [
    ['客户经营', '蓝 #2563eb', '#/customers, #/today, #/funnels', '客户档案、跟进、Today5、客户漏斗'],
    ['组织发展', '金 #d4a017', '#/recruit, #/activities/recruit', '增员候选人、阶段漏斗、月度目标'],
    ['活动经营', '玫红 #db2777', '#/activities, #/activity/<id>', '活动 CRUD、参与者、嘉宾/主题资源池'],
  ],
  [18, 18, 30, 34]
));
sections.push(p('高亮规则：活动列表 #/activities 和活动详情 #/activity/<数字> 归活动经营；活动量日报（#/activity/customer、#/activity/recruit）仍分别归客户经营和组织发展。'));
sections.push(pageBreak());

// ===== 2. 数据库设计 =====
sections.push(h1('2. 数据库设计'));
sections.push(p('PostgreSQL 共享集群，20 张业务表分属 4 个域，9 个视图。所有主对象表含软删除（deleted_at），14 张表启用 RLS fn_only 策略。'));
sections.push(spacer());

sections.push(h2('2.1 客户域 (Customer) — 10 张表'));
sections.push(tbl(
  ['表', '关键字段', '用途'],
  [
    ['customers', 'Id, customer_name, customer_stage, profile(jsonb), sales_priority', '客户主档，profile 8 维度画像'],
    ['followups', 'Id, customer_id, followup_notes, next_followup_goal(TEXT)', '跟进记录，v1.8.10 起 goal 列由 ENUM 改为自由文本'],
    ['gifts', 'Id, customer_id, gift_name, given_date', '礼品记录'],
    ['photos', 'Id, customer_id, photo_url, thumbnail_url', '客户照片'],
    ['products', 'Id, customer_id, product_name', '产品额度'],
    ['opportunities', 'Id, customer_id, opportunity_type, status', '经营机会（含转介绍，opportunity_type=转介绍）'],
    ['ai_recommendations', 'Id, customer_id, suggested_followup_goal(TEXT), nba', 'AI 建议，v1.8.10 起 goal 列由 ENUM 改为自由文本'],
    ['ocr_records', 'Id, customer_id, ocr_text', 'OCR 识别记录（含身份证等敏感信息）'],
    ['policy_review_reports', 'Id, customer_id, summary, gaps, recommendations', '保单检视报告 5 段'],
    ['customer_goal_benchmarks', 'benchmark_name, target_value', '客户经营目标基准'],
  ],
  [25, 40, 35]
));
sections.push(spacer());

sections.push(h2('2.2 活动经营域 (Activity) — 5 张表'));
sections.push(tbl(
  ['表', '关键字段', '用途'],
  [
    ['activities', 'Id, activity_name, status, type, planned_date', '活动主档'],
    ['activity_participants', 'Id, activity_id, person_type, person_id, status', '参与者多态（customer/recruit/speaker）'],
    ['activity_tasks', 'Id, activity_id, task_type, status', '活动待办（硬删除语义）'],
    ['activity_speakers', 'Id, name, relationship_stage', '嘉宾资源池（可复用）'],
    ['activity_topics', 'Id, topic_name, category', '主题资源池（可复用）'],
  ],
  [25, 40, 35]
));
sections.push(spacer());

sections.push(h2('2.3 增员域 (Recruit) — 3 张表'));
sections.push(tbl(
  ['表', '关键字段', '用途'],
  [
    ['recruit_candidates', 'Id, name, stage, potential_score, profile(jsonb)', '增员候选人主档（7 阶段漏斗）'],
    ['recruit_milestones', 'Id, candidate_id, milestone_type', '里程碑时间线'],
    ['recruit_followups', 'Id, candidate_id, followup_notes', '增员跟进记录'],
  ],
  [25, 40, 35]
));
sections.push(spacer());

sections.push(h2('2.4 目标基准域 — 2 张表'));
sections.push(tbl(
  ['表', '用途'],
  [
    ['recruit_goals', '增员月度目标（候选人 × 年月）'],
    ['recruit_goal_benchmarks', '行业基准（用于目标对比）'],
  ],
  [40, 60]
));
sections.push(spacer());

sections.push(h2('2.5 视图层 — 9 个视图'));
sections.push(p('所有列表/详情查询都走视图（云函数 rdb.from("v_xxx").select("*")）。视图缺列是静默故障：写入成功但前端读到 undefined。表结构变更后必须 DROP + CREATE 重建视图并重新 GRANT。'));
sections.push(tbl(
  ['视图', '基表', '用途'],
  [
    ['customers_view', 'customers + gifts + followups + ai_recommendations + photos', '客户列表/详情'],
    ['followups_view', 'followups + customers + gifts + ai_recommendations', '跟进列表'],
    ['gifts_view', 'gifts + customers + followups + ai_recommendations', '礼品列表'],
    ['products_view', 'products + customers', '产品列表'],
    ['ai_recommendations_view', 'ai_recommendations + customers + followups + gifts', 'AI 建议列表'],
    ['v_action_center', '跨域聚合', '今日经营行动池（v1.8.7 cockpit 复用）'],
    ['v_funnel_stats', 'v_action_center + customers + opportunities + recruit_candidates', '三漏斗统计（当前数/阶段变化/超期/停留）'],
    ['v_recruit_candidates', 'recruit_candidates + goals + benchmarks', '增员候选人列表'],
    ['v_recruit_candidates_trash', 'recruit_candidates WHERE deleted_at IS NOT NULL', '回收站'],
  ],
  [28, 42, 30]
));
sections.push(spacer());

sections.push(h2('2.6 v1.8.10 ENUM→TEXT 迁移修复'));
sections.push(p('问题：v1.8 Sprint10 UI 改为自由文本输入后，AI 生成的长句子无法写入 followups.next_followup_goal 和 ai_recommendations.suggested_followup_goal（原为 ENUM"跟进目标"，7 固定值）。'));
sections.push(p('修复（迁移 20260910150000_followup_goal_enum_to_text.sql）：', { bold: true }));
sections.push(bullet('DROP 7 个依赖视图（v_funnel_stats 依赖 v_action_center，需级联 CASCADE）'));
sections.push(bullet('ALTER 两列 ENUM → TEXT USING col::text'));
sections.push(bullet('DROP TYPE "跟进目标"'));
sections.push(bullet('按原始定义重建 7 个视图（UNION 类型须一致，否则报 cannot be matched）'));
sections.push(bullet('重新 GRANT SELECT ON 所有视图 TO anon, authenticated, service_role'));
sections.push(bullet('视图不能 ENABLE ROW LEVEL SECURITY（PG 限制），RLS 只在基表上'));
sections.push(pageBreak());

// ===== 3. 云函数架构 =====
sections.push(h1('3. 云函数架构'));
sections.push(p('25 个云函数，分为业务 CRUD、AI 智能、共享模块三类。所有 AI 函数通过共享 db.js 的 generateText 调用混元大模型。'));
sections.push(spacer());

sections.push(h2('3.1 业务 CRUD 函数'));
sections.push(tbl(
  ['函数', '主要 action', '说明'],
  [
    ['customers', 'list/get/create/update/remove/restore', '客户管理（软删除+级联）'],
    ['followups', 'list/get/create/update/remove', '跟进记录'],
    ['gifts', 'list/get/create/update/remove', '礼品记录'],
    ['photos', 'list/get/create/update/remove', '客户照片'],
    ['products', 'list/get/create/update/remove', '产品额度'],
    ['opportunities', 'list/get/create/update/remove', '经营机会'],
    ['activities', 'list/get/create/update/remove', '活动管理'],
    ['recruit_candidates', 'list/get/create/update/remove/restore', '增员候选人'],
    ['recruit_followups', 'list/get/create/update/remove', '增员跟进'],
    ['recruit_milestones', 'list/get/create/remove', '增员里程碑'],
    ['recruit_goals', 'list/get/create/update', '月度目标'],
  ],
  [22, 38, 40]
));
sections.push(spacer());

sections.push(h2('3.2 AI 智能函数（10 个，共 22 处模型调用）'));
sections.push(tbl(
  ['函数', '模型', 'Action / 用途'],
  [
    ['ai_parse', 'hy3 + glm-5v-turbo', 'parse：文本/多图→客户资料；quick_capture：自然语言拆解（人/事件/事实/需求/阶段/下一步）'],
    ['today_coach', 'hy3', 'daily_review：每日复盘；generate：Today 5（Must×2/Rec×2/Opt×1）；cockpit：只读 dashboard 数据（不调 AI，复用 loadAll，~2.4s）'],
    ['ai_recommend', 'hy3', '客户 NBA 下一最佳行动（含保险金字塔/双十原则/普尔象限）'],
    ['ai_followup', 'hy3', 'parse：口语→结构化跟进；analyze_profile：通读 50 条历史生成画像更新建议'],
    ['ai_activity', 'hy3', 'analyze/prepare/decompose/recommendSpeakers/recommendTopics/postReview/participantReview/learning（8 个只读建议 action）'],
    ['ai_referral', 'hy3', '转介绍建议（suitable/confidence/时机/话术/NBA）'],
    ['funnel_insight', 'hy3', 'explain：对 v_funnel_stats 事实做口语化解读（失败自动降级规则版）'],
    ['policy_review_reports', 'hy3', 'generate：保单检视报告 5 段（summary/gaps/recommendations/asset_allocation/next_action）'],
    ['recruit_score', 'hy3', '增员候选人 6 维度潜力评分（回写 potential_score/reason）'],
    ['recruit_recommend', 'hy3', '增员话术/NBA 生成（含增员五步法/STAR 异议处理）'],
  ],
  [18, 20, 62]
));
sections.push(spacer());

sections.push(h2('3.3 共享模块 db.js'));
sections.push(p('AI 函数共享 cloudfunctions/<name>/db.js，提供统一的 rdb 链式 API 和 AI 调用封装：'));
sections.push(bullet('rdb：CloudBase 数据库链式查询 API（from/where/select/insert/update/remove）'));
sections.push(bullet('generateText：调用 app.ai().createModel("cloudbase").generateText()，返回文本'));
sections.push(bullet('extractJson：从 AI 输出中提取 JSON（容错：处理 ```json 代码块、前后噪声文本）'));
sections.push(bullet('assertOk：统一响应封装 { ok: true/false, data/error }'));
sections.push(bullet('改 db.js 或任何 db.js 副本 → 必须同步全部受影响函数目录并重新部署'));
sections.push(pageBreak());

// ===== 4. 前端架构 =====
sections.push(h1('4. 前端架构'));
sections.push(h2('4.1 概述'));
sections.push(p('单文件 admin.html（~430KB，~6000+ 行），原生 HTML + JS + CSS，无框架/构建工具。通过 hash 路由（#/xxx）切换页面，app.callFunction 调云函数，不直连数据库。'));
sections.push(p('admin.html 保留 no-cache meta（Cache-Control: no-store），防止 CDN/浏览器缓存导致版本漂移。'));
sections.push(spacer());

sections.push(h2('4.2 核心工具函数'));
sections.push(tbl(
  ['函数', '用途'],
  [
    ['callFn(name, data)', '封装 app.callFunction，统一错误处理与 loading'],
    ['el(tag, attrs, children)', 'DOM 工厂函数，避免 innerHTML 注入'],
    ['route(hash)', 'hash 路由分发，支持参数（#/activity/123）'],
    ['toast(msg, type)', '轻量提示（success/error/info）'],
    ['confirmDialog(msg)', '确认弹窗（删除操作前置）'],
  ],
  [30, 70]
));
sections.push(spacer());

sections.push(h2('4.3 路由（v1.8.7 主要路由）'));
sections.push(tbl(
  ['Hash', '页面', '所属模块'],
  [
    ['#/', 'AI 经营驾驶舱（首页）', '全局'],
    ['#/today', '今日经营 Top15', '客户经营'],
    ['#/customers', '客户列表', '客户经营'],
    ['#/customer/<id>', '客户详情', '客户经营'],
    ['#/funnels', '三漏斗', '客户经营（共享）'],
    ['#/recruit', '增员候选人列表', '组织发展'],
    ['#/recruit/<id>', '增员详情', '组织发展'],
    ['#/activities', '活动列表', '活动经营'],
    ['#/activity/<id>', '活动详情', '活动经营'],
    ['#/activity/customer', '客户活动量日报', '客户经营'],
    ['#/activity/recruit', '增员活动量日报', '组织发展'],
    ['#/trash', '回收站', '全局'],
  ],
  [25, 45, 30]
));
sections.push(spacer());

sections.push(h2('4.4 AI 经营驾驶舱（v1.8.7 首页）'));
sections.push(p('首页重构为"AI 经营驾驶舱"，四段式结构，核心目标：帮助决定今天做什么。', { bold: true }));
sections.push(spacer());
sections.push(h3('4.4.1 dash-hero 快速记录'));
sections.push(bullet('一键打开 Quick Capture（ai_parse.quick_capture）'));
sections.push(bullet('支持客户上下文：从客户详情 Hero 区"✍️ 告诉 AI 刚刚发生了什么"按钮进入，预填 cid+name'));
sections.push(spacer());
sections.push(h3('4.4.2 Today 5（renderDashT5）'));
sections.push(bullet('2 个 Must Do + 2 个 Recommended + 1 个 Optional'));
sections.push(bullet('每项显示：人物、原因、建议行动、沟通渠道、话术（蓝底）、日期'));
sections.push(bullet('dashT5Go 三类路由：客户详情/活动详情/增员详情'));
sections.push(bullet('与 #/today 共用 COACH_KEY v5 当天缓存（全 App 当天只调一次 AI）'));
sections.push(bullet('tier 徽标：①-⑤ 标识优先级'));
sections.push(spacer());
sections.push(h3('4.4.3 trend-grid 四线箭头'));
sections.push(bullet('客户/机会/组织/活动经营四个方向的简洁趋势'));
sections.push(bullet('滚动 7 天窗口（-6~0 vs -13~-7）up/flat/down，只给方向不给数字'));
sections.push(spacer());
sections.push(h3('4.4.4 rem-list AI 提醒'));
sections.push(bullet('6 类确定性事实：overdue（逾期）/today 到期/近30天活动认识无下一步/增员停留14天+/活动未复盘/活动3天内有待办'));
sections.push(bullet('按 level 取 4 条，target 为 hash 可点击跳转'));
sections.push(bullet('person_type=activity 时 person_id 即 activity_id，today 到期文案区分"任务到期"与"约定沟通日"'));
sections.push(spacer());
sections.push(h3('4.4.5 dash-entry 药丸入口'));
sections.push(bullet('保旧功能可达：客户/活动/增员/回收站入口药丸'));
sections.push(bullet('cockpit 失败只降级两卡，不白屏'));
sections.push(spacer());

sections.push(h2('4.5 三漏斗（v1.8）'));
sections.push(p('使用现有字段实现三个漏斗，不新建 Funnel 业务表：', { bold: true }));
sections.push(tbl(
  ['漏斗', '字段', '阶段'],
  [
    ['客户漏斗', 'customers.customer_stage', '新认识→关系维护→需求挖掘→方案沟通→成交推进→转介绍经营'],
    ['机会漏斗', 'opportunities.status', '发现→沟通→方案→成交→关闭'],
    ['增员漏斗', 'recruit_candidates.stage', '新增人才→互动暖客→初次面谈→增员活动→精准面谈→入职申请→签约入司→流失'],
  ],
  [18, 35, 47]
));
sections.push(spacer());
sections.push(p('实现：', { bold: true }));
sections.push(bullet('SQL 视图 v_funnel_stats：当前数/阶段变化/超期/停留时间'));
sections.push(bullet('云函数 funnel_insight：stats（纯事实）+ explain（AI 解读）'));
sections.push(bullet('前端路由 #/funnels：三个事实卡（客户蓝/机会紫/增员金）+ 一个 AI 解读卡'));
sections.push(bullet('小样本保护：总样本 <10 不显示比率，分母 <10 不显示转化率'));
sections.push(bullet('AI 失败/超时（50s）自动降级规则版，防止白屏'));
sections.push(bullet('AI 解释必须对空漏斗明确返回"信息不足"'));
sections.push(spacer());

sections.push(h2('4.6 其他主要功能模块'));
sections.push(tbl(
  ['模块', '功能点'],
  [
    ['今日经营 Top15', 'AI 教练行动池（客户跟进 + 活动行动混合排序）、NBA 建议、今日待办'],
    ['客户管理', '客户档案、跟进记录、礼品记录、照片管理、产品额度、保单检视、经营机会、客户画像'],
    ['活动经营', '活动 CRUD、参与者管理（多态）、活动待办、嘉宾资源池、主题资源池、AI 分析/筹备/分解/嘉宾推荐/主题推荐/复盘/活动经验'],
    ['增员管理', '候选人档案、阶段流转（7 阶段漏斗）、跟进记录、里程碑时间线、AI 评分、月度目标 vs 行业基准'],
    ['转介绍', '复用 opportunities 承载（opportunity_type=转介绍），独立状态机'],
    ['回收站', '客户/增员软删除恢复，级联子表'],
  ],
  [18, 82]
));
sections.push(pageBreak());

// ===== 5. 安全设计 =====
sections.push(h1('5. 安全设计'));
sections.push(h2('5.1 RLS 行级安全'));
sections.push(p('14 张业务表启用 ROW LEVEL SECURITY + fn_only 策略，仅云函数匿名上下文（sub IS NULL AND role = anon）可访问，阻止前端直连绕过。'));
sections.push(spacer());
sections.push(tbl(
  ['表', '策略名'],
  [
    ['customers', 'customers_fn_only'], ['followups', 'followups_fn_only'],
    ['opportunities', 'opportunities_fn_only'], ['ocr_records', 'ocr_records_fn_only'],
    ['activities', 'activities_fn_only'], ['activity_participants', 'activity_participants_fn_only'],
    ['activity_tasks', 'activity_tasks_fn_only'], ['activity_speakers', 'activity_speakers_fn_only'],
    ['activity_topics', 'activity_topics_fn_only'], ['recruit_candidates', 'recruit_candidates_fn_only'],
    ['recruit_milestones', 'recruit_milestones_fn_only'], ['recruit_followups', 'recruit_followups_fn_only'],
    ['recruit_goals', 'recruit_goals_fn_only'], ['recruit_goal_benchmarks', 'recruit_goal_benchmarks_fn_only'],
  ],
  [50, 50]
));
sections.push(spacer());

sections.push(h2('5.2 视图安全'));
sections.push(p('6 张 *_view 视图 REVOKE anon 权限，防止通过视图绕过基表 RLS。v_recruit_candidates 和 v_recruit_candidates_trash 面向前端只读，GRANT anon SELECT。'));
sections.push(p('视图不能启用 RLS（PG 限制），RLS 只在基表上生效。视图重建后授权丢失，必须重新 GRANT。'));
sections.push(spacer());

sections.push(h2('5.3 数据安全原则'));
sections.push(bullet('AI 只输出分析结果与建议，不写核心业务数据（阶段/机会/客户字段由用户确认）'));
sections.push(bullet('信息不足时明确返回"样本不足，暂不能判断。"，禁止虚构数据/成功率/ROI/因果'));
sections.push(bullet('OCR 记录含身份证等敏感信息，已启用 RLS fn_only'));
sections.push(bullet('级联软删除：删除客户/增员主对象 → 关联子表打 deleted_at（同一 deleted_at）'));
sections.push(bullet('子记录删除保持硬删除语义，不混用软删除'));
sections.push(bullet('AI 失败降级：AI 超时/失败自动回退规则版，绝不白屏'));
sections.push(bullet('所有 SQL 必须参数化，空字符串按现有项目规则处理为 null'));
sections.push(bullet('敏感文件（数据库信息.txt、测试文件）永不入库、不部署托管'));
sections.push(pageBreak());

// ===== 6. 部署与运维 =====
sections.push(h1('6. 部署与运维'));
sections.push(h2('6.1 环境信息'));
sections.push(tbl(
  ['项', '值'],
  [
    ['环境 ID', 'crm-d1gkae8ddc930d151'],
    ['区域', 'ap-shanghai'],
    ['运行时', 'Nodejs20.19'],
    ['数据库', 'PostgreSQL（CloudBase 共享集群）'],
    ['静态托管域名', 'crm-d1gkae8ddc930d151-1434199662.tcloudbaseapp.com'],
    ['前端入口', 'admin.html（根路径直接服务，errorDocument=admin.html）'],
    ['AI 文本模型', 'Hunyuan hy3（21 处调用）'],
    ['AI 视觉模型', 'glm-5v-turbo（1 处 OCR）'],
    ['GitHub 仓库', 'https://github.com/VictorLiang2026/crm-v1'],
  ],
  [30, 70]
));
sections.push(spacer());

sections.push(h2('6.2 发布三地同步铁律'));
sections.push(p('每次更新结束前必须确保四步完成，才算更新结束：', { bold: true }));
sections.push(bullet('① 本地工作区干净且已提交'));
sections.push(bullet('② 云端最新：云函数 tcb fn code update + 静态托管（含 docs 三份文件），经实际调用验证'));
sections.push(bullet('③ GitHub master 推送最新（代理：git -c http.proxy=http://127.0.0.1:7897 -c http.sslBackend=schannel push）'));
sections.push(bullet('④ 版本发布打 tag 并推送（git tag vX.Y.Z <commit>；git push origin vX.Y.Z），GitHub API 复核'));
sections.push(spacer());

sections.push(h2('6.3 部署命令'));
sections.push(p('云函数部署：', { bold: true }));
sections.push(p('  tcb fn code update <fnName> --dir cloudfunctions/<fnName> --json'));
sections.push(p('静态托管（用 MCP manageHosting 精准上传，避免泄露 .git/、cloudfunctions/）：', { bold: true }));
sections.push(p('  MCP manageHosting(action="uploadFiles", files=[{localPath, cloudPath}])'));
sections.push(p('调用验证（云函数无 MD5 比对，必须实际调用）：', { bold: true }));
sections.push(p('  tcb fn invoke <fnName> --params \'{\\"action\\":\\"learning\\",\\"range\\":\\"all\\"}\''));
sections.push(p('发布脚本：', { bold: true }));
sections.push(p('  powershell -File tools/release.ps1 -Message "feat: 说明" [-Tag v1.8.7]'));
sections.push(spacer());

sections.push(h2('6.4 一致性体检'));
sections.push(p('release.ps1 末尾自动调用 sync-check.ps1 做三方一致性体检：'));
sections.push(bullet('本地 git 工作区干净'));
sections.push(bullet('云函数线上版本与本地一致（MCP 拉取比对）'));
sections.push(bullet('静态托管 admin.html MD5 与本地一致'));
sections.push(bullet('GitHub master 与本地一致'));
sections.push(bullet('版本 tag 存在且指向正确 commit'));
sections.push(pageBreak());

// ===== 7. 版本历史 =====
sections.push(h1('7. 版本历史'));
sections.push(tbl(
  ['版本', '名称', '主要功能'],
  [
    ['v1.0', '基础 CRM', '客户/跟进/礼品/照片/产品/OCR/保单检视'],
    ['v1.2', '经营机会', 'opportunities 轻量机会跟踪'],
    ['v1.3', '活动经营', 'activities + activity_participants 多态参与'],
    ['v1.4', '转介绍经营', '复用 opportunities 承载转介绍线索'],
    ['v1.5', '增员重构 + 画像', 'recruit_candidates 重构、客户/增员 profile jsonb'],
    ['v1.6', '客户画像', 'customers.profile jsonb 8 维度 AI 提取'],
    ['v1.7.0-2', '活动待办 + AI 分析', 'activity_tasks 硬删除、ai_activity analyze/prepare/decompose'],
    ['v1.7.3', '嘉宾资源池', 'activity_speakers 可复用嘉宾档案'],
    ['v1.7.4', '主题资源池', 'activity_topics 可复用主题档案'],
    ['v1.7.5', 'AI 活动复盘', 'postReview 6 维度经营机会发现'],
    ['v1.7.6', 'Activity→NBA→Today', '活动行动接入今日经营 Top15'],
    ['v1.7.7', 'Activity Learning', 'AI 活动经验总结（learning 只读聚合 + 防虚构）'],
    ['v1.8 Sprint4', 'Quick Capture', 'AI 快速记录自然语言拆解（只读解析，不落库）'],
    ['v1.8 Sprint7', 'AI 经营驾驶舱', '首页重构四段式（Today5/趋势/提醒/入口），today_coach 新增 cockpit 只读 action（2.4s），零 DDL 零新表'],
    ['v1.8 三漏斗', '客户/机会/增员漏斗', '复用现有字段 + v_funnel_stats 视图 + funnel_insight 云函数（AI 解读+降级）'],
    ['v1.8.7', '驾驶舱稳定版', 'tag=58f8ffc，cockpit 复用 loadAll 不调 AI，Today5 与 #/today 共用 v5 缓存'],
    ['v1.8.10', 'ENUM→TEXT 修复', 'followups.next_followup_goal 与 ai_recommendations.suggested_followup_goal 由 ENUM 改 TEXT，DROP+CREATE 7 视图'],
  ],
  [14, 22, 64]
));
sections.push(spacer());

sections.push(h2('7.1 v1.8.7 详细说明'));
sections.push(p('版本名称：AI 经营驾驶舱 + 三漏斗 + Quick Capture', { bold: true }));
sections.push(spacer());
sections.push(p('首页重构目标：', { bold: true }));
sections.push(bullet('核心目标是帮助决定今天做什么'));
sections.push(bullet('不显示大量统计卡片、表格、AI 评分或历史数据'));
sections.push(bullet('四段式：dash-hero 快速记录 → Today5 → trend-grid 四线箭头 → rem-list 提醒 → dash-entry 药丸入口'));
sections.push(spacer());
sections.push(p('today_coach 新增 cockpit action（零 DDL 零新表）：', { bold: true }));
sections.push(bullet('只读 action，不调 AI，复用 loadAll 逻辑'));
sections.push(bullet('实测响应 ~2.4s'));
sections.push(bullet('trends[4]：滚动 7 天窗口（-6~0 vs -13~-7）up/flat/down 只给方向'));
sections.push(bullet('reminders：6 类确定性事实（overdue/today 到期/近30天活动认识无下一步/增员停留14天+/活动未复盘/活动3天内有待办）按 level 取 4'));
sections.push(bullet('person_type=activity 时 person_id 即 activity_id，today 到期文案区分"任务到期"与"约定沟通日"'));
sections.push(spacer());
sections.push(p('Today5 缓存策略：', { bold: true }));
sections.push(bullet('与 #/today 共用 COACH_KEY v5 当天缓存'));
sections.push(bullet('全 App 当天只调一次 AI'));
sections.push(bullet('cockpit 失败只降级两卡，不白屏'));
sections.push(spacer());
sections.push(p('三漏斗实现：', { bold: true }));
sections.push(bullet('客户漏斗：customers.customer_stage（6 阶段）'));
sections.push(bullet('机会漏斗：opportunities.status（5 阶段）'));
sections.push(bullet('增员漏斗：recruit_candidates.stage（8 阶段含流失）'));
sections.push(bullet('SQL 视图 v_funnel_stats：当前数/阶段变化/超期/停留时间'));
sections.push(bullet('云函数 funnel_insight：stats（纯事实）+ explain（AI 解读，50s 超时降级规则版）'));
sections.push(bullet('前端 #/funnels：三个事实卡（客户蓝/机会紫/增员金）+ 一个 AI 解读卡'));
sections.push(bullet('小样本保护：总样本 <10 不显示比率，分母 <10 不显示转化率'));
sections.push(spacer());
sections.push(p('约束：', { bold: true }));
sections.push(bullet('不新建 Funnel 业务表，复用现有字段'));
sections.push(bullet('AI 只建议、不直接修改核心业务数据'));
sections.push(bullet('AI 失败不能导致页面不可用'));
sections.push(bullet('AI 信息不足时必须明确返回"信息不足"'));
sections.push(bullet('AI 负责解释漏斗数据，SQL 负责提供事实'));
sections.push(pageBreak());

// ===== 8. 附录 =====
sections.push(h1('8. 附录'));
sections.push(h2('8.1 枚举值参考'));
sections.push(tbl(
  ['枚举/状态', '可选值'],
  [
    ['customer_stage', '新认识 / 关系维护 / 需求挖掘 / 方案沟通 / 成交推进 / 转介绍经营'],
    ['优先级 (A-E)', 'A / B / C / D / E'],
    ['next_followup_goal', '自由文本（v1.8.10 起原 ENUM 改为 TEXT，AI 可产出长句子）'],
    ['suggested_followup_goal', '自由文本（v1.8.10 起原 ENUM 改为 TEXT，同上）'],
    ['activities.status', 'idea / preparing / confirmed / in_progress / ended / reviewed'],
    ['activity_participants.status', 'invited / attended / absent'],
    ['activity_participants.person_type', 'customer / recruit / speaker'],
    ['activity_tasks.task_type', 'preparation / invitation / speaker / onsite / followup / review / other'],
    ['activity_tasks.status', 'pending / in_progress / completed / skipped'],
    ['activity_speakers.relationship_stage', 'new / contacted / cooperated / stable / deep / inactive'],
    ['opportunities.opportunity_type', '医疗保障 / 重疾保障 / 养老规划 / 教育规划 / 财富规划 / 家庭保障 / 转介绍'],
    ['opportunities.status', '发现 / 沟通 / 方案 / 成交 / 关闭'],
    ['recruit_candidates.stage', '新增人才 / 互动暖客 / 初次面谈 / 增员活动 / 精准面谈 / 入职申请 / 签约入司 / 流失'],
  ],
  [30, 70]
));
sections.push(spacer());

sections.push(h2('8.2 文件结构'));
sections.push(tbl(
  ['路径', '说明'],
  [
    ['admin.html', '前端单文件应用（~430KB，~6000+ 行）'],
    ['cloudfunctions/<name>/index.js', '25 个云函数入口'],
    ['cloudfunctions/<name>/db.js', 'AI 函数共享模块（app/rdb/generateText/extractJson/assertOk）'],
    ['cloudfunctions/<name>/package.json', '函数依赖声明'],
    ['cloudbase/migrations/*.sql', '数据库迁移文件（幂等可重放）'],
    ['cloudbaserc.json', 'CloudBase 环境与函数配置'],
    ['docs/db-schema.svg', '数据库 Schema 关系图（始终最新）'],
    ['docs/data-dictionary.html', '数据字典（始终最新）'],
    ['docs/system-documentation.docx', '本说明文档（始终最新）'],
    ['tools/gen-schema-svg.js', 'Schema SVG 生成脚本'],
    ['tools/gen-system-doc.js', '本说明文档生成脚本'],
    ['tools/release.ps1', '发布脚本（提交+推送+打标签+体检）'],
    ['tools/sync-check.ps1', '三方一致性体检脚本'],
  ],
  [35, 65]
));
sections.push(spacer());

sections.push(h2('8.3 相关文档'));
sections.push(bullet('数据库 Schema 关系图：docs/db-schema.svg'));
sections.push(bullet('数据字典：docs/data-dictionary.html'));
sections.push(bullet('GitHub 仓库：https://github.com/VictorLiang2026/crm-v1'));

// ===== 构建 =====
const doc = new Document({
  creator: "Victor's CRM",
  title: "Victor's CRM 系统说明文档",
  description: "System documentation for Victor's CRM (current: " + DOC_VERSION + ')',
  styles: {
    default: {
      document: { run: { font: 'Microsoft YaHei', size: 21 } },
    },
  },
  numbering: {
    config: [{
      reference: 'bullets',
      levels: [
        { level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: 0.25 } } } },
      ],
    }],
  },
  sections: [{
    properties: {
      page: {
        margin: { top: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1), right: convertInchesToTwip(1) },
      },
    },
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Victor's CRM 系统说明文档（" + DOC_VERSION + '）', size: 16, color: '94a3b8' })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '第 ', size: 16, color: '94a3b8' }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '94a3b8' }), new TextRun({ text: ' 页', size: 16, color: '94a3b8' })] })] }) },
    children: sections,
  }],
});

const outPath = path.join(__dirname, '..', 'docs', 'system-documentation.docx');
Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(outPath, buffer);
  console.log('DOCX 已生成:', outPath, (fs.statSync(outPath).size / 1024).toFixed(1) + ' KB');
});
