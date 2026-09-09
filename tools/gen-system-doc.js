/**
 * 生成 Victor's CRM 系统说明文档 (DOCX) —— 唯一事实来源
 * 输出: docs/system-documentation.docx （不带版本号，始终代表最新；封面标注当前版本）
 * 系统变更后更新本脚本并重新生成。
 */
const DOC_VERSION = 'v1.7.7';
const DOC_DATE = '2026-09-09';
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  PageBreak, Header, Footer, PageNumber, NumberFormat,
  TableOfContents, StyleLevel, convertInchesToTwip, LevelFormat,
} = require('docx');

const BLUE = '2563eb', PINK = 'db2777', PURPLE = '7c3aed', CYAN = '0891b2';
const GRAY = '64748b', DARK = '1e293b', LIGHT_BG = 'f1f5f9';

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
sections.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: DOC_VERSION + ' — Activity Learning / AI活动经验', size: 26, color: GRAY })] }));
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
sections.push(spacer());

sections.push(h2('1.2 技术栈'));
sections.push(tbl(
  ['层次', '技术', '说明'],
  [
    ['前端', '原生 HTML + JS + CSS', '单文件 admin.html，无框架/构建工具，通过 callFn 调云函数'],
    ['后端', 'Node.js 云函数', '25 个云函数，rdb 链式 API 访问 PostgreSQL'],
    ['数据库', 'PostgreSQL (CloudBase 共享集群)', '20 张业务表 + 9 个视图，RLS 行级安全'],
    ['AI', 'Hunyuan 大模型 (hy3)', 'generateText API，结构化 JSON 输出'],
    ['存储', 'CloudBase 云存储', '客户照片、增员雷达图/报告等文件'],
    ['托管', 'CloudBase 静态托管', 'admin.html 单页部署'],
    ['部署', 'tcb CLI', '命令行部署云函数与前端'],
  ],
  [15, 30, 55]
));
sections.push(spacer());

sections.push(h2('1.3 设计原则'));
sections.push(bullet('零 DDL 运维：不新建表/字段需走迁移文件，幂等可重放'));
sections.push(bullet('AI 只建议不直接改：AI 输出分析结果，不写业务数据（v1.7.7 learning 尤为如此）'));
sections.push(bullet('信息不足透明返回："样本不足，暂不能判断。"而非虚构数据'));
sections.push(bullet('小步提交：每个版本独立验收，不跨版本耦合'));
sections.push(bullet('RLS 全覆盖：14 张业务表启用 fn_only 策略，仅云函数可访问'));
sections.push(pageBreak());

// ===== 2. 数据库设计 =====
sections.push(h1('2. 数据库设计'));
sections.push(p('PostgreSQL 共享集群，20 张业务表分属 4 个域，9 个视图。所有主对象表含软删除（deleted_at），14 张表启用 RLS fn_only 策略。'));
sections.push(spacer());

sections.push(h2('2.1 客户域 (Customer) — 10 张表'));
sections.push(tbl(
  ['表名', '说明', '关键列', 'RLS'],
  [
    ['customers', '客户主表', 'Id(PK), customer_name, phone, customer_stage(E), profile(J)', 'fn_only'],
    ['followups', '客户跟进记录', 'Id(PK), customer_id(FK), followup_date, recommendation_id(LFK), activity_id(LFK)', 'fn_only'],
    ['ai_recommendations', 'AI 经营建议', 'id(PK), customer_id(FK), nba(J), suggested_followup_date', '-'],
    ['opportunities', '经营机会', 'id(PK), customer_id(FK), opportunity_type, status, referred_name', 'fn_only'],
    ['gifts', '客户礼品', 'Id(PK), customer_id(FK), gift_name, given_date', '-'],
    ['photos', '客户照片', 'id(PK), customer_id(FK), photo_url, thumbnail_url', '-'],
    ['products', '产品额度', 'id(PK), customer_id(FK), ap_ipa/ap_ltc/ap_ann/ap_life/ap_ci/ap_pa/ap_ppa, items', '-'],
    ['ocr_records', 'OCR 识别记录', 'id(PK), customer_id(FK), raw_text, file_ids', 'fn_only'],
    ['policy_review_reports', '保单检视报告', 'id(PK), customer_id(FK), summary/gaps_found/recommendations + edited_*', '-'],
  ],
  [18, 14, 53, 15]
));
sections.push(spacer());

sections.push(h2('2.2 活动经营域 (Activity) — 5 张表'));
sections.push(tbl(
  ['表名', '说明', '关键列', 'RLS'],
  [
    ['activities', '活动主表', 'id(PK), name, activity_date, status, goal_types(J), topic_ids(J), review_summary', 'fn_only'],
    ['activity_participants', '活动参与者（多态）', 'id(PK), activity_id(FK), person_type, person_id(多态), status, followup_status', 'fn_only'],
    ['activity_tasks', '活动待办（硬删除）', 'id(PK), activity_id(FK), task_type(CHECK), status(CHECK), priority(CHECK), source(CHECK)', 'fn_only'],
    ['activity_speakers', '嘉宾资源池', 'id(PK), name, organization, relationship_stage(CHECK), cooperation_count', 'fn_only'],
    ['activity_topics', '主题资源池', 'id(PK), topic_name, category, keywords(J), use_count, status(CHECK)', 'fn_only'],
  ],
  [18, 16, 51, 15]
));
sections.push(spacer());

sections.push(h2('2.3 增员域 (Recruit) — 3 张表'));
sections.push(tbl(
  ['表名', '说明', '关键列', 'RLS'],
  [
    ['recruit_candidates', '增员候选人（与 customers 软关联）', 'id(PK), customer_id(FK,UNIQUE), stage, potential_score, profile(J), radar_image_file_id', 'fn_only'],
    ['recruit_followups', '增员跟进记录', 'id(PK), candidate_id(LFK), contact_method, interest_level, followup_date', 'fn_only'],
    ['recruit_milestones', '阶段里程碑', 'id(PK), candidate_id(FK), from_stage, to_stage, happened_at', 'fn_only'],
  ],
  [20, 22, 43, 15]
));
sections.push(spacer());

sections.push(h2('2.4 目标基准域 — 2 张表'));
sections.push(tbl(
  ['表名', '说明', '关键列', 'RLS'],
  [
    ['recruit_goals', '增员月度目标', 'id(PK), goal_month, stage, target_count, UNIQUE(goal_month, stage)', 'fn_only'],
    ['recruit_goal_benchmarks', '行业基准（可修改）', 'id(PK), stage_from, stage_to, conversion_min/avg/good, UNIQUE(stage_from, stage_to)', 'fn_only'],
  ],
  [22, 20, 43, 15]
));
sections.push(spacer());

sections.push(h2('2.5 视图层 — 9 个视图'));
sections.push(tbl(
  ['视图名', '基于', '说明'],
  [
    ['customers_view', 'customers JOIN gifts/followups/ai_recommendations/photos', '客户聚合视图；REVOKE anon'],
    ['followups_view', 'followups', 'REVOKE anon'],
    ['gifts_view', 'gifts', 'REVOKE anon'],
    ['photos_view', 'photos', 'REVOKE anon'],
    ['products_view', 'products', 'REVOKE anon'],
    ['ai_recommendations_view', 'ai_recommendations JOIN customers/followups/gifts', 'REVOKE anon'],
    ['v_recruit_candidates', 'recruit_candidates JOIN customers', '完整视图含 idle_days；GRANT anon'],
    ['v_recruit_candidates_trash', 'recruit_candidates JOIN customers (soft-deleted)', '回收站视图；GRANT anon'],
    ['activity_participants_view', 'activity_participants', 'REVOKE anon'],
  ],
  [25, 40, 35]
));
sections.push(spacer());

sections.push(h2('2.6 关联关系'));
sections.push(bullet('真实外键（FK）：customers → followups/gifts/photos/products/ocr_records/policy_review_reports/opportunities/ai_recommendations；activities → activity_participants/activity_tasks；recruit_candidates → recruit_milestones'));
sections.push(bullet('逻辑外键（无 FK 约束）：followups.recommendation_id → ai_recommendations.id；followups.activity_id → activities.id；recruit_followups.candidate_id → recruit_candidates.id；recruit_candidates.recommender_id'));
sections.push(bullet('多态关联：activity_participants.person_id 按 person_type 指向 customers.Id / recruit_candidates.id / activity_speakers.id'));
sections.push(bullet('弱关联：activities.topic_ids (jsonb) → activity_topics.id[]；activity_speakers.customer_id / recruit_candidate_id'));
sections.push(pageBreak());

// ===== 3. 云函数架构 =====
sections.push(h1('3. 云函数架构'));
sections.push(p('共 25 个云函数，按功能分为 CRUD 业务函数和 AI 智能函数两类。所有函数通过 rdb 链式 API 访问 PostgreSQL，AI 函数通过 generateText 调用 Hunyuan 大模型。'));
sections.push(spacer());

sections.push(h2('3.1 业务 CRUD 函数'));
sections.push(tbl(
  ['函数名', '超时', '说明'],
  [
    ['customers', '10s', '客户 CRUD + 列表/搜索/批量操作'],
    ['followups', '10s', '客户跟进记录 CRUD'],
    ['gifts', '10s', '客户礼品 CRUD'],
    ['photos', '10s', '客户照片 CRUD + 云存储上传'],
    ['products', '10s', '客户产品额度 CRUD'],
    ['ocr_records', '10s', 'OCR 识别记录 CRUD'],
    ['policy_review_reports', '10s', '保单检视报告 CRUD'],
    ['opportunities', '10s', '经营机会/转介绍线索 CRUD'],
    ['activities', '10s', '活动 CRUD + 状态流转'],
    ['activity_tasks', '10s', '活动待办任务 CRUD（硬删除）'],
    ['activity_speakers', '10s', '嘉宾资源池 CRUD'],
    ['activity_topics', '10s', '主题资源池 CRUD + 使用计数'],
    ['recruit_candidates', '10s', '增员候选人 CRUD + 阶段流转'],
    ['recruit_followups', '10s', '增员跟进记录 CRUD'],
    ['recruit_goals', '10s', '增员月度目标 CRUD'],
  ],
  [25, 12, 63]
));
sections.push(spacer());

sections.push(h2('3.2 AI 智能函数'));
sections.push(tbl(
  ['函数名', '超时', 'Actions', '说明'],
  [
    ['ai_activity', '60s', 'analyze/prepare/decompose/recommendSpeakers/recommendTopics/postReview/learning', '活动经营 AI 中枢（7 个 action）'],
    ['ai_recommend', '60s', '-', 'AI 经营建议生成（NBA 7 字段结构）'],
    ['ai_recommendations', '10s', '-', 'AI 建议 CRUD'],
    ['ai_followup', '60s', '-', 'AI 跟进话术生成 + 客户画像提取'],
    ['ai_referral', '60s', '-', 'AI 转介绍机会识别'],
    ['ai_parse', '60s', '-', 'AI OCR 解析（证件/名片→结构化数据）'],
    ['recruit_score', '60s', '-', 'AI 增员高潜评分（0-100）'],
    ['recruit_recommend', '60s', '-', 'AI 增员建议生成'],
    ['today_coach', '60s', '-', 'AI 今日经营教练（Top15 行动候选池）'],
    ['activity_reports', '10s', '-', '活动报告查询'],
  ],
  [20, 10, 35, 35]
));
sections.push(spacer());

sections.push(h2('3.3 共享模块 db.js'));
sections.push(p('AI 函数共享 db.js 模块，导出：'));
sections.push(tbl(
  ['导出', '类型', '说明'],
  [
    ['app', '对象', 'CloudBase app 实例（app.rdb() 访问 PG）'],
    ['rdb', '对象', 'PostgreSQL 链式 API 链'],
    ['getAi', '函数', '获取 AI 客户端实例'],
    ['AI_MODEL', '字符串', '模型标识 hy3 (Hunyuan)'],
    ['generateText', '函数', '调 AI 返回 {text, raw}；支持 timeout 参数'],
    ['extractJson', '函数', '从文本提取首个 JSON 对象，失败返回 null'],
    ['assertOk', '函数', '检查 rdb 响应，有 error 抛异常'],
    ['nowIso', '函数', '当前 ISO 时间'],
    ['normFields', '函数', '字段规范化'],
  ],
  [18, 12, 70]
));
sections.push(pageBreak());

// ===== 4. 前端架构 =====
sections.push(h1('4. 前端架构'));
sections.push(h2('4.1 概述'));
sections.push(p('前端为单文件 admin.html，无框架、无构建工具、无 npm 依赖。通过 callFn(fnName, params) 调用云函数，所有数据经云函数中转。'));
sections.push(spacer());

sections.push(h2('4.2 核心工具函数'));
sections.push(tbl(
  ['函数', '说明'],
  [
    ['el(tag, attrs, children)', '创建 DOM 元素；children 数组，null/false 跳过，string/number 转 textNode'],
    ['esc(s)', 'HTML 转义'],
    ['$(id)', 'getElementById 简写'],
    ['callFn(fnName, params)', '调用云函数（异步）'],
    ['toast(msg, type)', '轻提示（success/error/info）'],
    ['modal(title, FIELDS, pref, onSubmit, opts)', '表单弹窗（支持 wide 选项）'],
  ],
  [35, 65]
));
sections.push(spacer());

sections.push(h2('4.3 路由'));
sections.push(p('基于 hash 路由，无框架依赖：'));
sections.push(tbl(
  ['Hash', '功能'],
  [
    ['#/dashboard', '今日经营总览（Today Coach）'],
    ['#/customers', '客户列表'],
    ['#/customer/<id>', '客户详情（跟进/礼品/照片/产品/报告/机会）'],
    ['#/activities', '活动列表（含活动经验入口）'],
    ['#/activity/<id>', '活动详情（参与者/任务/复盘）'],
    ['#/recruits', '增员候选人列表'],
    ['#/recruit/<id>', '增员详情（跟进/里程碑/评估附件）'],
    ['#/recruit-goals', '增员目标 + 行业基准'],
    ['#/recycle-bin', '回收站（软删除恢复）'],
  ],
  [30, 70]
));
sections.push(spacer());

sections.push(h2('4.4 主要功能模块'));
sections.push(tbl(
  ['模块', '功能点'],
  [
    ['今日经营', 'AI 教练 Top15 行动池（客户跟进 + 活动行动混合排序）、NBA 建议、今日待办'],
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
sections.push(spacer());

sections.push(h2('5.3 数据安全原则'));
sections.push(bullet('AI 只输出分析结果，不写业务数据（v1.7.7 learning 纯只读）'));
sections.push(bullet('信息不足时明确返回"样本不足，暂不能判断。"，禁止虚构数据/成功率/ROI/因果'));
sections.push(bullet('OCR 记录含身份证等敏感信息，已启用 RLS fn_only'));
sections.push(bullet('级联软删除：删除客户/增员主对象 → 关联子表打 deleted_at'));
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
    ['静态托管', 'admin.html 单页部署'],
    ['AI 模型', 'Hunyuan (hy3)'],
  ],
  [30, 70]
));
sections.push(spacer());

sections.push(h2('6.2 部署命令'));
sections.push(p('登录：', { bold: true }));
sections.push(p('  tcb login --apiKeyId "<secretId>" --apiKey "<secretKey>" --token "<token>"'));
sections.push(p('选择环境：', { bold: true }));
sections.push(p('  tcb env use crm-d1gkae8ddc930d151'));
sections.push(p('部署云函数：', { bold: true }));
sections.push(p('  tcb fn code update <fnName> --dir cloudfunctions/<fnName> --json'));
sections.push(p('部署前端：', { bold: true }));
sections.push(p('  tcb hosting deploy ./admin.html /admin.html --env-id crm-d1gkae8ddc930d151 --yes'));
sections.push(p('调用验证：', { bold: true }));
sections.push(p('  tcb fn invoke <fnName> --params \'{\\"action\\":\\"learning\\",\\"range\\":\\"all\\"}\''));
sections.push(spacer());

sections.push(h2('6.3 发布流程'));
sections.push(bullet('1. 代码自检：node --check 语法检查 + rdb 列名核实'));
sections.push(bullet('2. 部署：云函数 + 前端托管'));
sections.push(bullet('3. 真实调用验证（tcb fn invoke）'));
sections.push(bullet('4. 浏览器冒烟测试'));
sections.push(bullet('5. 用户人工验收'));
sections.push(bullet('6. git commit + tag + proxy push'));
sections.push(bullet('7. GitHub API 验证 tag 存在'));
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
    ['v1.7.0-v1.7.2', '活动待办 + AI 分析', 'activity_tasks 硬删除、ai_activity analyze/prepare/decompose'],
    ['v1.7.3', '嘉宾资源池', 'activity_speakers 可复用嘉宾档案'],
    ['v1.7.4', '主题资源池', 'activity_topics 可复用主题档案'],
    ['v1.7.5', 'AI 活动复盘', 'postReview 6 维度经营机会发现'],
    ['v1.7.6', 'Activity→NBA→Today', '活动行动接入今日经营 Top15'],
    ['v1.7.7', 'Activity Learning', 'AI 活动经验总结（learning 只读聚合 + 防虚构 + 样本不足判定）'],
  ],
  [15, 22, 63]
));
sections.push(spacer());

sections.push(h2('7.1 v1.7.7 详细说明'));
sections.push(p('版本名称：Activity Learning / AI活动经验', { bold: true }));
sections.push(spacer());
sections.push(p('目标：', { bold: true }));
sections.push(bullet('让 AI 基于已有活动历史总结经验'));
sections.push(bullet('不建 activity_metrics / activity_statistics / activity_analytics'));
sections.push(bullet('不新增数据库表'));
sections.push(spacer());
sections.push(p('新增 action：', { bold: true }));
sections.push(bullet('ai_activity.learning — 只读聚合 9 个数据源 + AI 分析 + JSON 校验'));
sections.push(spacer());
sections.push(p('数据源（全部只读 select）：', { bold: true }));
sections.push(bullet('activities, activity_participants, activity_tasks, activity_speakers, activity_topics'));
sections.push(bullet('followups, opportunities'));
sections.push(bullet('recruit_candidates, customers（关联客户/增员数据）'));
sections.push(spacer());
sections.push(p('输出结构：', { bold: true }));
sections.push(bullet('worth_continuing（值得继续）'));
sections.push(bullet('worth_optimizing（值得优化）'));
sections.push(bullet('worth_reusing（值得复用）'));
sections.push(bullet('worth_trying（值得尝试）'));
sections.push(p('每条：{ title, reason, evidence, suggestion }，每类 0-3 条'));
sections.push(spacer());
sections.push(p('防虚构机制：', { bold: true }));
sections.push(bullet('样本不足（已结束/已复盘活动 < 2 场）→ 直接返回"样本不足，暂不能判断。"，不调 AI'));
sections.push(bullet('AI system prompt 7 条纪律：禁虚构数据/成功率/ROI/因果；evidence 必须引用真实活动名/数字/日期'));
sections.push(bullet('opportunities 无 activity_id 列 → 机会统计仅做窗口内同期计数，不做活动归因'));
sections.push(bullet('输出层 clip 长度 + 丢弃无标题项 + 每类 slice(0,3)'));
sections.push(spacer());
sections.push(p('约束：', { bold: true }));
sections.push(bullet('纯只读：不写业务数据、不改活动/客户/增员、不创建 NBA、不改 Today'));
sections.push(bullet('AI 只输出分析结果'));
sections.push(pageBreak());

// ===== 8. 附录 =====
sections.push(h1('8. 附录'));
sections.push(h2('8.1 枚举值参考'));
sections.push(tbl(
  ['枚举/状态', '可选值'],
  [
    ['customer_stage', '新认识 / 关系维护 / 需求挖掘 / 方案沟通 / 成交推进 / 转介绍经营'],
    ['优先级 (A-E)', 'A / B / C / D / E'],
    ['跟进目标', '建立联系 / 约见面 / 邀请活动 / 获取家庭信息 / 推进签单 / 推进招募 / 推进转介绍'],
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
    ['admin.html', '前端单文件应用（~6000+ 行）'],
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
    ['tools/release.ps1', '发布脚本'],
  ],
  [35, 65]
));
sections.push(spacer());

sections.push(h2('8.3 相关文档'));
sections.push(bullet('数据库 Schema 关系图：docs/db-schema.svg'));
sections.push(bullet('数据字典：docs/data-dictionary.html'));
sections.push(bullet('GitHub 仓库：https://github.com/VictorLiang2026/crm-cloudbase'));

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
