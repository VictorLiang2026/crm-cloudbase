/**
 * 生成 CRM 架构与功能介绍 Word 文档
 * 运行: node tools/gen-crm-doc.js
 * 输出: docs/CRM系统架构与功能介绍-v1.0.4.docx
 */
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType,
  PageOrientation, convertInchesToTwip, ShadingType, VerticalAlign
} = require('docx');
const fs = require('fs');
const path = require('path');

// ===== 样式常量 =====
const COLOR_PRIMARY = '1A56DB';   // 品牌蓝
const COLOR_DARK    = '1F2937';   // 深灰
const COLOR_GREEN   = '059669';   // 绿色
const COLOR_AMBER   = 'D97706';   // 琥珀色
const COLOR_RED     = 'DC2626';   // 红色
const COLOR_PURPLE  = '7C3AED';   // 紫色
const COLOR_GREY_BG = 'F3F4F6';   // 浅灰背景
const COLOR_BLUE_BG = 'EFF6FF';   // 浅蓝背景

const BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'D1D5DB' };
const ALL_BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

// ===== 辅助函数 =====
function heading(text, level = HeadingLevel.HEADING_1, color = COLOR_PRIMARY) {
  return new Paragraph({
    heading: level,
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text, bold: true, color, size: level === HeadingLevel.HEADING_1 ? 32 : 26 })],
  });
}

function para(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    alignment: opts.align || AlignmentType.JUSTIFIED,
    children: [new TextRun({
      text, size: opts.size || 22,
      color: opts.color || COLOR_DARK,
      bold: opts.bold || false,
      italics: opts.italic || false,
    })],
  });
}

function richPara(runs, opts = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    alignment: opts.align || AlignmentType.JUSTIFIED,
    children: runs.map(r => new TextRun({
      text: r.text, size: r.size || 22, color: r.color || COLOR_DARK,
      bold: r.bold || false, italics: r.italic || false,
    })),
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    bullet: { level },
    spacing: { before: 30, after: 30 },
    children: [new TextRun({ text, size: 22, color: COLOR_DARK })],
  });
}

function cell(text, opts = {}) {
  return new TableCell({
    borders: ALL_BORDERS,
    verticalAlign: VerticalAlign.CENTER,
    shading: opts.bg ? { type: ShadingType.SOLID, color: opts.bg, fill: opts.bg } : undefined,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    children: [new Paragraph({
      spacing: { before: 20, after: 20 },
      alignment: opts.align || AlignmentType.LEFT,
      children: Array.isArray(text) ? text : [new TextRun({
        text: String(text), size: opts.size || 20,
        color: opts.color || COLOR_DARK,
        bold: opts.bold || false,
      })],
    })],
  });
}

function headerCell(text, bg = COLOR_PRIMARY) {
  return cell(text, { bg, color: 'FFFFFF', bold: true, align: AlignmentType.CENTER });
}

function table(headers, rows, colWidths) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => headerCell(h, COLOR_PRIMARY)),
  });
  const dataRows = rows.map(row =>
    new TableRow({
      children: row.map((c, i) => cell(c, { width: colWidths ? colWidths[i] : undefined })),
    })
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

function spacer() {
  return new Paragraph({ spacing: { before: 80, after: 80 }, children: [] });
}

function divider() {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: COLOR_PRIMARY } },
    spacing: { before: 120, after: 120 },
    children: [],
  });
}

// ===== 文档内容 =====
const sections = [];

// ── 封面 ──
sections.push({
  properties: {
    page: {
      margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
      size: { orientation: PageOrientation.PORTRAIT },
    },
  },
  children: [
    new Paragraph({ spacing: { before: 2400 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 200 },
      children: [new TextRun({ text: "Victor's CRM", size: 56, bold: true, color: COLOR_PRIMARY })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 100, after: 100 },
      children: [new TextRun({ text: '系统架构与功能介绍', size: 40, color: COLOR_DARK })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400, after: 100 },
      children: [new TextRun({ text: '版本 v1.0.4', size: 28, color: COLOR_GREEN, bold: true })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 60, after: 60 },
      children: [new TextRun({ text: '2026-09-06', size: 24, color: '6B7280' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 60, after: 60 },
      children: [new TextRun({ text: '维护者：Victor', size: 24, color: '6B7280' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400 },
      children: [new TextRun({ text: 'CloudBase 个人版 + PostgreSQL 共享集群', size: 22, color: '6B7280', italics: true })],
    }),
  ],
});

// ── 正文 ──
const content = [];

// 一、系统概述
content.push(heading('一、系统概述'));
content.push(para('Victor\'s CRM 是一套基于腾讯云 CloudBase 个人版构建的轻量级客户关系管理系统，面向保险行业个人代理人，覆盖客户经营与组织发展（增员）两大核心业务模块。系统采用单文件前端 + 事件云函数 + 共享集群 PostgreSQL 的极简架构，无需构建步骤、零运维负担、单文件部署即可上线。'));
content.push(spacer());

// 核心数据
content.push(heading('核心数据', HeadingLevel.HEADING_2, COLOR_GREEN));
content.push(table(
  ['维度', '数量', '说明'],
  [
    ['云函数', '16 个', 'CommonJS / Node.js 18.15，含 5 个 AI 函数（hy3 模型）'],
    ['业务表', '13 张', '客户域 6 + 画像增强 2 + 增员域 5'],
    ['数据库视图', '8 个', '6 张 *_view + 2 张增员视图（v_recruit_candidates / _trash）'],
    ['迁移 SQL', '16 个', '按时间戳命名，含 RLS / 软删除 / 增员模块'],
    ['前端函数', '120+ 个', 'admin.html 单文件约 3900 行，IIFE + strict mode'],
    ['版本标签', '5 个', 'v1.0.0 ~ v1.0.4，GitHub 可追溯'],
  ],
  [15, 12, 73]
));
content.push(spacer());

// 二、技术架构
content.push(heading('二、技术架构'));
content.push(para('系统遵循「前端不直连 PG、不直连 AI」的安全边界：所有数据库访问与 AI 调用均在云函数内完成，前端通过 callFunction 同域调用。'));
content.push(spacer());

content.push(heading('架构图', HeadingLevel.HEADING_2, COLOR_GREEN));
content.push(richPara([
  { text: 'admin.html', bold: true, color: COLOR_PRIMARY },
  { text: '（单页, @cloudbase/js-sdk CDN, callFunction 同域）' },
]));
content.push(para('  ├─ 顶栏 [客户经营] [组织发展] 模块切换器'));
content.push(para('  ├─ 路由：10 条 hash 路径（客户 6 + 增员 4）'));
content.push(para('  └─ window.APP_CONFIG.envId'));
content.push(para('        │'));
content.push(richPara([
  { text: '事件云函数 ×16', bold: true, color: COLOR_PRIMARY },
  { text: ' (CommonJS, Nodejs18.15)' },
]));
content.push(para('  ├─ _shared/db.js（rdb() 数据访问 + AI(hy3) 封装）'));
content.push(para('  └─ @cloudbase/node-sdk@^4'));
content.push(para('       └─ app.rdb()        → 共享集群 PG（RLS fn_only 策略）'));
content.push(para('       └─ app.ai()          → hy3（5 个 AI 函数）'));
content.push(spacer());

content.push(heading('环境配置', HeadingLevel.HEADING_2, COLOR_GREEN));
content.push(table(
  ['项', '值', '备注'],
  [
    ['EnvId', 'crm-d1gkae8ddc930d151', 'ap-shanghai'],
    ['PackageId', 'baas_personal', '个人版，资源点模式'],
    ['后端', 'PostgreSQL 共享型 SHARED', '不启用 VPC'],
    ['AI 模型', 'hy3', 'cloudbase 组，Status=1'],
    ['静态托管', 'crm-...tcloudbaseapp.com', 'admin.html 单文件'],
    ['登录账号', 'crm_admin', 'PG 模式不支持自助注册'],
    ['网关', 'authz.user.rego', '显式 deny 匿名用户'],
  ],
  [20, 45, 35]
));
content.push(spacer());

// 三、功能模块
content.push(heading('三、功能模块'));
content.push(para('系统采用顶部模块切换器在「客户经营」与「组织发展」两大模块间切换，路由根据 hash 前缀自动归属。'));
content.push(spacer());

// 3.1 客户经营
content.push(heading('3.1 客户经营', HeadingLevel.HEADING_2, COLOR_PRIMARY));
content.push(para('客户经营模块是系统的核心模块，涵盖客户全生命周期管理。'));
content.push(spacer());

content.push(heading('路由与页面', HeadingLevel.HEADING_3, COLOR_GREEN));
content.push(table(
  ['路由', '页面', '功能'],
  [
    ['#/', '客户工作台', '6 个统计卡（客户总数/今日跟进/逾期/30 天内/长期未联系）+ 客户列表，统计卡可点击筛选'],
    ['#/customers', '全部客户列表', '支持姓名/电话/职业搜索、排序、分页'],
    ['#/customers/trash', '客户回收站', '批量恢复已软删除客户（含关联子记录）'],
    ['#/customer/:id', '客户详情', '7 Tab：基本信息/跟进记录/保单检视/伴手礼/照片附件/AI 解析记录/AI 建议'],
    ['#/ai-suggestions', 'AI 建议库', '三种筛选搜索：按姓名/按给出建议日期/按建议跟进日期'],
    ['#/activity/customer', '客户活动量日报', '今日实时 + 区间查询，含指标卡、趋势表、活动流水'],
  ],
  [22, 18, 60]
));
content.push(spacer());

content.push(heading('工具栏', HeadingLevel.HEADING_3, COLOR_GREEN));
content.push(bullet('客户工作台：搜索框 / 搜索 / + 新增客户（蓝）/ 全部客户（绿）/ AI 解析新增 / AI 建议 / 活动量'));
content.push(bullet('增员入口已迁至顶部模块切换器「组织发展」'));
content.push(spacer());

content.push(heading('核心功能', HeadingLevel.HEADING_3, COLOR_GREEN));
content.push(bullet('客户 CRUD：支持姓名/电话/职业/优先级/阶段/生日等全字段管理'));
content.push(bullet('跟进记录：CRUD + 今日跟进/逾期/30 天内到期/长期未联系智能提醒'));
content.push(bullet('保单检视：11 类产品额度二维表 + AI 5 段检视报告（标准普尔+双十原则+保险金字塔）'));
content.push(bullet('伴手礼管理：CRUD + 客户维度关联'));
content.push(bullet('照片附件：base64 存储，list 懒加载 data URL'));
content.push(bullet('AI 文本解析：输入文本 → hy3 解析 → 预填客户资料（可存图）'));
content.push(bullet('AI 跟进建议：hy3 生成 → 写入 ai_recommendations → 库页可筛选搜索'));
content.push(bullet('OCR 识别记录：Tesseract/pdf.js 前端 OCR + customer_snapshot 回退'));
content.push(bullet('客户回收站：级联软删除 + 逐行/批量恢复'));
content.push(bullet('活动量日报：今日实时/区间查询，指标含新增/首联/跟进/接触/计划完成率/礼品/照片/OCR/AI 建议/保单检视/产品更新'));
content.push(spacer());

// 3.2 组织发展
content.push(heading('3.2 组织发展（增员）', HeadingLevel.HEADING_2, COLOR_PRIMARY));
content.push(para('组织发展模块管理保险代理人增员全流程，采用 7 阶段漏斗模型。'));
content.push(spacer());

content.push(heading('路由与页面', HeadingLevel.HEADING_3, COLOR_GREEN));
content.push(table(
  ['路由', '页面', '功能'],
  [
    ['#/recruit', '增员工作台', '7 阶段漏斗看板 + 候选人列表'],
    ['#/recruit/goals', '目标管理', '行业基准对比 + 当月目标对照 + 目标转化率'],
    ['#/recruit/trash', '增员回收站', '批量恢复已软删除候选人'],
    ['#/activity/recruit', '增员活动量日报', '今日实时/区间 + goalProgress 当月目标对照'],
  ],
  [22, 18, 60]
));
content.push(spacer());

content.push(heading('7 阶段漏斗', HeadingLevel.HEADING_3, COLOR_GREEN));
content.push(para('新增人才 → 互动暖客 → 初次面谈 → 增员活动 → 精准面谈 → 入职申请 → 签约入司'));
content.push(spacer());

content.push(heading('核心功能', HeadingLevel.HEADING_3, COLOR_GREEN));
content.push(bullet('候选人 CRUD + 7 阶段阶段变更 + 候选人时间线（里程碑事件流）'));
content.push(bullet('增员跟进记录：CRUD + contact_method / interest_level / 顾虑记录'));
content.push(bullet('目标管理：月度目标 + getProgress（与 recruit_goal_benchmarks 对照）+ 7 阶段行业基准（min/avg/good + 来源）'));
content.push(bullet('AI 高潜评分：hy3 6 维度加权评分（120s）'));
content.push(bullet('AI 接触建议：hy3 STAR 异议处理 + 称呼规则 + 五步法（120s）'));
content.push(bullet('雷达图/报告附件：私有 bucket recruit，signed URL 1 小时有效'));
content.push(bullet('增员回收站：级联软删除 + 恢复'));
content.push(bullet('活动量日报：新增候选人/RC 跟进/接触/计划完成率/暖客/初面/增员活动/深面/申请/入职'));
content.push(spacer());

// 四、数据库设计
content.push(heading('四、数据库设计'));
content.push(spacer());

content.push(heading('业务表（13 张）', HeadingLevel.HEADING_2, COLOR_GREEN));
content.push(table(
  ['业务域', '表名', '主键', '说明'],
  [
    ['客户域', 'customers', 'Id (int)', '中心表，含优先级/阶段/MBTI 等'],
    ['', 'followups', 'Id (int)', '跟进记录，含下次跟进日期/目标'],
    ['', 'products', 'id (bigint)', '保单额度（11 个 ap_* + items JSON）'],
    ['', 'gifts', 'Id (bigint)', '伴手礼'],
    ['', 'photos', 'id (int)', 'base64 存储，无序列手动分配'],
    ['', 'ai_recommendations', 'id (bigint)', '只读表，由 ai_recommend 写入'],
    ['画像增强', 'policy_review_reports', 'id (bigint)', 'AI 5 段检视报告 + edited_* 双写区'],
    ['', 'ocr_records', 'id (bigint)', 'OCR 记录 + customer_snapshot'],
    ['增员域', 'recruit_candidates', 'id (bigserial)', '7 阶段候选人'],
    ['', 'recruit_milestones', 'id (bigserial)', '阶段变更事件流'],
    ['', 'recruit_followups', 'id (bigserial)', '增员接触记录'],
    ['', 'recruit_goals', 'id (bigserial)', '月度目标'],
    ['', 'recruit_goal_benchmarks', 'id (serial)', '行业基准（7 阶段 min/avg/good）'],
  ],
  [13, 25, 20, 42]
));
content.push(spacer());

content.push(heading('枚举类型', HeadingLevel.HEADING_2, COLOR_GREEN));
content.push(bullet('客户经营阶段：新认识 / 关系维护 / 需求挖掘 / 方案沟通 / 成交推进 / 转介绍经营'));
content.push(bullet('优先级：A / B / C / D / E'));
content.push(bullet('跟进目标：建立联系 / 约见面 / 邀请活动 / 获取家庭信息 / 推进签单 / 推进招募 / 推进转介绍'));
content.push(para('增员阶段采用 text 列 + 应用层约束（便于阶段名演进），不强制使用枚举。'));
content.push(spacer());

content.push(heading('软删除 / 回收站语义', HeadingLevel.HEADING_2, COLOR_GREEN));
content.push(richPara([
  { text: '硬删除', bold: true, color: COLOR_RED },
  { text: '：跟进/礼品/照片/报告/AI 解析/产品额度/增员跟进等子记录（DELETE，不进回收站）' },
]));
content.push(richPara([
  { text: '级联软删除', bold: true, color: COLOR_GREEN },
  { text: '：删除客户/增员候选人（主对象）→ 打 deleted_at 标记 + 关联子记录一并标记 → 可从回收站恢复' },
]));
content.push(spacer());

// 五、安全设计
content.push(heading('五、安全设计'));
content.push(spacer());

content.push(heading('RLS（行级安全）', HeadingLevel.HEADING_2, COLOR_RED));
content.push(para('共享集群 PG 的 REST API 默认对匿名 token 开放，且云函数 app.rdb() 的身份也是 anon。为防止匿名 REST 直读客户数据，13 张业务表全部启用 RLS fn_only 策略：'));
content.push(spacer());
content.push(table(
  ['安全层', '措施', '状态'],
  [
    ['表级 RLS', '13 张表 fn_only policy（仅放行无 sub 的云函数 token）', '已启用'],
    ['视图保护', '6 张 *_view 视图 REVOKE anon（防 owner 绕过 RLS）', '已配置'],
    ['增员视图', '2 张增员视图 GRANT SELECT TO anon（RLS 已在基表生效）', '已配置'],
    ['网关策略', 'authz.user.rego deny 匿名/未登录用户调用 functions', '已配置'],
    ['登录认证', 'auth.signInWithPassword（PG 模式必须登录才能调用）', '已配置'],
    ['5 分钟超时', '无操作弹遮罩强制重新登录（ensureSession）', '已配置'],
  ],
  [15, 60, 25]
));
content.push(spacer());
content.push(richPara([
  { text: '原理', bold: true, color: COLOR_PRIMARY },
  { text: '：云函数 token 不含 sub（仅 aud/exp/iat/iss/role），而任何用户 token 都带 sub。fn_only policy 仅放行无 sub 的请求，从根本上阻断匿名 REST 直读。' },
]));
content.push(spacer());

content.push(heading('硬性限制', HeadingLevel.HEADING_2, COLOR_RED));
content.push(bullet('AI 仅用 hy3，禁止 deepseek/openai/任何第三方 Key'));
content.push(bullet('禁止前端直连 PG 或 AI'));
content.push(bullet('数据访问仅 app.rdb()（node-sdk 4.x），无 PG 凭证、无 VPC'));
content.push(bullet('照片 base64 存 photos 表，不调多模态，不开云存储匿名登录'));
content.push(bullet('所有 SQL 参数化（$1, $2, ...），空串统一转 null'));
content.push(bullet('不启用 VPC'));
content.push(bullet('admin.html apiBase 留空（callFunction 同域调用）'));
content.push(spacer());

// 六、云函数清单
content.push(heading('六、云函数清单（16 个）'));
content.push(table(
  ['业务域', '云函数', '超时', '说明'],
  [
    ['客户域 CRUD', 'customers', '10s', '客户 CRUD'],
    ['', 'followups', '10s', '跟进记录 CRUD'],
    ['', 'products', '10s', '保单额度 upsert'],
    ['', 'gifts', '10s', '伴手礼 CRUD'],
    ['', 'photos', '10s', '照片存储（base64）'],
    ['AI 历史', 'ai_recommendations', '10s', 'AI 建议历史（只读，list + listAll）'],
    ['AI 生成', 'ai_parse', '120s', 'AI 文本解析 → 客户资料'],
    ['', 'ai_recommend', '120s', 'AI 跟进建议生成'],
    ['画像增强', 'policy_review_reports', '120s', '保单检视 5 段 AI 报告'],
    ['', 'ocr_records', '10s', 'OCR 识别记录'],
    ['活动量', 'activity_reports', '10s', 'today/range 双轨聚合'],
    ['增员域', 'recruit_candidates', '10s', '候选人 CRUD + 漏斗'],
    ['', 'recruit_followups', '10s', '增员跟进 CRUD'],
    ['', 'recruit_goals', '10s', '月度目标 + getProgress'],
    ['', 'recruit_score', '120s', 'AI 高潜评分'],
    ['', 'recruit_recommend', '120s', 'AI 接触建议'],
  ],
  [13, 25, 8, 54]
));
content.push(spacer());

// 七、部署与运维
content.push(heading('七、部署与运维'));
content.push(spacer());

content.push(heading('部署步骤（首次）', HeadingLevel.HEADING_2, COLOR_GREEN));
content.push(bullet('1. 配置环境变量：每个云函数注入 TCB_ENV，5 个 AI 函数额外注入 AI_MODEL=hy3'));
content.push(bullet('2. 打包共享模块：_shared/db.js 复制为各函数 ./db.js'));
content.push(bullet('3. 部署云函数：MCP manageFunctions 或 tcb fn deploy'));
content.push(bullet('4. 部署前端：MCP manageHosting 上传 admin.html（禁用 tcb hosting deploy）'));
content.push(bullet('5. 创建登录用户：managePermissions createUser 或控制台'));
content.push(bullet('6. 网关 OPA 策略：authz.user.rego deny 匿名用户'));
content.push(bullet('7. 端到端验证：登录 → 客户工作台 → 新增 → 详情 → AI → 组织发展 → 回收站'));
content.push(spacer());

content.push(heading('日常迭代流程', HeadingLevel.HEADING_2, COLOR_GREEN));
content.push(richPara([
  { text: '改代码', bold: true, color: COLOR_PRIMARY },
  { text: ' → ' },
  { text: 'MCP 部署', bold: true, color: COLOR_PRIMARY },
  { text: '（云函数/托管）→ ' },
  { text: 'release.ps1', bold: true, color: COLOR_PRIMARY },
  { text: '（提交+推送+打标签）→ ' },
  { text: 'sync-check.ps1', bold: true, color: COLOR_PRIMARY },
  { text: '（三方体检全绿）' },
]));
content.push(spacer());

content.push(heading('发布脚本', HeadingLevel.HEADING_3, COLOR_GREEN));
content.push(richPara([
  { text: 'tools/release.ps1', bold: true, color: COLOR_PRIMARY },
  { text: '：一键提交→推送→打标签→自动体检' },
]));
content.push(richPara([
  { text: 'tools/sync-check.ps1', bold: true, color: COLOR_PRIMARY },
  { text: '：三方一致性体检（工作区/git/线上 MD5）' },
]));
content.push(spacer());

content.push(heading('版本标签台账', HeadingLevel.HEADING_2, COLOR_GREEN));
content.push(table(
  ['版本', '提交', '内容'],
  [
    ['v1.0.0', '1206d62', '工作台升级 + 保单额度 11 类二维表'],
    ['v1.0.1', 'aa5aa48', '增员目标管理 + 跟进记录 + 6 列看板 + 行业基准'],
    ['v1.0.2', 'd8868d5', '客户/增员回收站 + RLS 安全加固 + 增员状态列'],
    ['v1.0.3', '9f4b0f7', '活动量日报（客户经营+增员双维度）'],
    ['v1.0.4', '4abdaa5', '双模块导航 + AI 建议库筛选 + 文档全面校对'],
  ],
  [12, 15, 73]
));
content.push(spacer());
content.push(richPara([
  { text: '回滚方式', bold: true, color: COLOR_AMBER },
  { text: '：git checkout vX.Y.Z -- admin.html 后重新上传托管；云函数检出后需重新 MCP 部署；数据库走反向迁移 SQL。' },
]));
content.push(spacer());

// 八、经验教训
content.push(heading('八、关键经验教训'));
content.push(table(
  ['#', '教训', '影响'],
  [
    ['1', '同文件并行 Edit 导致按钮丢失', '同一文件的多个 Edit 不放在同一并行块中'],
    ['2', 'appendChild 传数字导致渲染崩溃', 'el() 公共函数加类型兜底（数字/布尔自动转文本）'],
    ['3', '时区 toISOString 回退一天', '改 UTC 算术（new Date(start+T00:00:00Z) + setUTCDate）'],
    ['4', 'MCP ENV_REQUIRED', '调用 manageFunctions 前先 auth set_env envId'],
    ['5', 'PowerShell 不支持 &&/heredoc', '用 ; 和 here-string @\'...\'@'],
    ['6', '视图不自动包含基表新列', '基表加列后必须重建依赖视图'],
    ['7', 'tcb hosting deploy 泄露文件', '改用 MCP manageHosting 上传单文件'],
    ['8', 'ai_recommendations feed 重复', '里程碑仅在 STAGE_KEYS 命中时进 feed'],
    ['9', 'PowerShell 5.1 中文乱码', '脚本存为 UTF-8 带 BOM'],
    ['10', '同步靠人工易漂移', '引入 release.ps1 + sync-check.ps1 制度化'],
  ],
  [5, 38, 57]
));
content.push(spacer());

// 九、架构评估
content.push(heading('九、单文件架构评估'));
content.push(richPara([
  { text: '结论', bold: true, color: COLOR_GREEN },
  { text: '：对于当前项目（单用户、内网工具、约 3900 行），单文件结构是合理且近乎最优的选择。' },
]));
content.push(spacer());
content.push(heading('优势', HeadingLevel.HEADING_3, COLOR_GREEN));
content.push(bullet('部署/运维原子化：一个文件上传即发布，无版本错位/缓存混搭问题'));
content.push(bullet('零构建链：不依赖 npm/webpack，打开即改，MD5 即知线上是否最新'));
content.push(bullet('git 标签=完整版本快照，回滚即检出'));
content.push(bullet('gzip 后约 50KB，手机端一次性加载可接受'));
content.push(spacer());
content.push(heading('演进阈值', HeadingLevel.HEADING_3, COLOR_GREEN));
content.push(bullet('超过 6000~8000 行或出现第二人开发时，按"源码拆分→构建单文件"方式演进'));
content.push(bullet('引入 Vue/React 或 webpack 对单用户工具是杀鸡用牛刀，不推荐'));
content.push(spacer());

// 文档尾部
content.push(divider());
content.push(para('本文档由 Victor\'s CRM 项目自动生成', { align: AlignmentType.CENTER, color: '6B7280', size: 20, italic: true }));
content.push(para('生成时间：2026-09-06 | 版本：v1.0.4 | 对应代码提交：4abdaa5', { align: AlignmentType.CENTER, color: '6B7280', size: 20 }));

sections.push({
  properties: {
    page: {
      margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
      size: { orientation: PageOrientation.PORTRAIT },
    },
  },
  children: content,
});

// ===== 生成文档 =====
const doc = new Document({
  sections,
  styles: {
    default: {
      document: {
        run: { font: 'Microsoft YaHei', size: 22 },
      },
    },
  },
});

const outputPath = path.join(__dirname, '..', 'docs', 'CRM系统架构与功能介绍-v1.0.4.docx');
const buffer = Packer.toBuffer(doc);

// Packer.toBuffer returns a Promise in newer versions
if (buffer instanceof Promise || (buffer && typeof buffer.then === 'function')) {
  buffer.then(buf => {
    fs.writeFileSync(outputPath, buf);
    console.log('文档已生成: ' + outputPath);
    console.log('文件大小: ' + (buf.length / 1024).toFixed(1) + ' KB');
  }).catch(err => {
    console.error('生成失败:', err);
    process.exit(1);
  });
} else {
  // 同步模式（旧版 docx）
  fs.writeFileSync(outputPath, buffer);
  console.log('文档已生成: ' + outputPath);
  console.log('文件大小: ' + (buffer.length / 1024).toFixed(1) + ' KB');
}
