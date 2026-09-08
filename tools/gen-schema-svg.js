/**
 * 生成 Victor's CRM 数据库 Schema 关系图 (SVG)
 * 数据来源: 2026-09-08 从 crm-d1gkae8ddc930d151 生产库 information_schema 实测
 * 输出: docs/db-schema-v1.6.0.svg
 */
const fs = require('fs');
const path = require('path');

// ---------- 类型缩写 ----------
const TYPE_ABBR = {
  'integer': 'int', 'bigint': 'bigint', 'smallint': 'small', 'text': 'text',
  'date': 'date', 'jsonb': 'jsonb', 'numeric': 'numeric',
  'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp',
  'USER-DEFINED': 'enum',
};
const abbr = t => TYPE_ABBR[t] || t;

// 列定义: [名称, 类型, 标记] 标记: PK|FK|LFK(逻辑外键)|J(jsonb)|E(enum)|空
const T = (name, domain, color) => ({ name, domain, color });

// ---------- 表数据 (x,y 为左上角; h 自动计算) ----------
const tables = [
  // ===== 客户域 =====
  { id: 'customers', x: 450, y: 200, w: 380, domain: '客户域', color: '#2563eb', cols: [
    ['Id', 'integer', 'PK'], ['customer_name', 'text', ''], ['phone', 'text', ''], ['gender', 'text', ''],
    ['birthday', 'date', ''], ['occupation', 'text', ''], ['annual_income', 'integer', ''],
    ['source', 'text', ''], ['tags', 'text', ''], ['marital_status', 'text', ''],
    ['customer_stage', '客户经营阶段', 'E'], ['sales_priority', '优先级', 'E'],
    ['recruitment_priority', '优先级', 'E'], ['referral_priority', '优先级', 'E'],
    ['hobbies', 'text', ''], ['education', 'text', ''], ['mbti', 'text', ''],
    ['additional_info', 'text', ''], ['profile', 'jsonb', 'J'],
  ]},
  { id: 'ai_recommendations', x: 60, y: 200, w: 340, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'integer', 'FK'], ['customer_name', 'text', ''],
    ['recommendation_date', 'date', ''], ['suggested_message', 'text', ''],
    ['suggested_strategy', 'text', ''], ['suggested_followup_date', 'date', ''],
    ['suggested_customer_stage', '客户经营阶段', 'E'], ['suggested_followup_goal', '跟进目标', 'E'],
    ['nba', 'jsonb', 'J'],
  ]},
  { id: 'followups', x: 60, y: 560, w: 340, domain: '客户域', color: '#2563eb', cols: [
    ['Id', 'integer', 'PK'], ['customer_id', 'integer', 'FK'], ['customer_name', 'text', ''],
    ['followup_notes', 'text', ''], ['followup_date', 'date', ''],
    ['next_followup_date', 'date', ''], ['next_followup_goal', '跟进目标', 'E'],
    ['recommendation_id', 'integer', 'LFK'], ['activity_id', 'integer', 'LFK'],
  ]},
  { id: 'gifts', x: 60, y: 900, w: 340, domain: '客户域', color: '#2563eb', cols: [
    ['Id', 'bigint', 'PK'], ['customer_id', 'integer', 'FK'], ['customer_name', 'text', ''],
    ['gift_name', 'text', ''], ['quantity', 'smallint', ''], ['given_date', 'date', ''], ['notes', 'text', ''],
  ]},
  { id: 'photos', x: 60, y: 1190, w: 340, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'integer', 'PK'], ['customer_id', 'integer', 'FK'], ['customer_name', 'text', ''],
    ['photo_url', 'text', ''], ['thumbnail_url', 'text', ''], ['file_name', 'text', ''],
    ['content_type', 'text', ''], ['category', 'text', ''], ['sort_order', 'integer', ''],
  ]},
  { id: 'products', x: 450, y: 760, w: 380, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'bigint', 'FK'], ['customer_name', 'text', ''],
    ['ap_ipa', 'bigint', ''], ['ap_ltc', 'bigint', ''], ['ap_ann', 'bigint', ''],
    ['ap_life', 'bigint', ''], ['ap_term', 'bigint', ''], ['ap_wl', 'bigint', ''],
    ['ap_pa', 'bigint', ''], ['ap_ci', 'bigint', ''], ['ap_hi', 'bigint', ''],
    ['ap_all', 'bigint', ''], ['ap_ppa', 'bigint', ''], ['items', 'jsonb', 'J'],
  ]},
  { id: 'ocr_records', x: 450, y: 1230, w: 380, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'bigint', 'FK'], ['summary', 'text', ''],
    ['raw_text', 'text', ''], ['file_ids', 'text', ''], ['file_names', 'text', ''],
    ['customer_snapshot', 'text', ''],
  ]},
  { id: 'policy_review_reports', x: 900, y: 760, w: 420, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'bigint', 'FK'], ['customer_name', 'text', ''],
    ['report_date', 'date', ''], ['report_type', 'text', ''], ['summary', 'text', ''],
    ['gaps_found', 'text', ''], ['recommendations', 'text', ''], ['asset_allocation', 'text', ''],
    ['next_action', 'text', ''], ['raw', 'text', ''],
    ['edited_summary…edited_next_action', 'text', ''],
  ]},
  { id: 'opportunities', x: 900, y: 1160, w: 420, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'integer', 'FK'], ['opportunity_type', 'text', ''],
    ['status', 'text', ''], ['referred_name', 'text', ''], ['referred_relation', 'text', ''],
    ['discovered_at', 'date', ''], ['last_progress', 'text', ''], ['next_action', 'text', ''],
    ['ai_summary', 'text', ''],
  ]},
  // ===== 活动经营域 =====
  { id: 'activities', x: 1510, y: 200, w: 420, domain: '活动经营域', color: '#db2777', cols: [
    ['id', 'bigint', 'PK'], ['name', 'text', ''], ['activity_date', 'date', ''],
    ['activity_type', 'text', ''], ['location', 'text', ''], ['description', 'text', ''],
  ]},
  { id: 'activity_participants', x: 1510, y: 440, w: 420, domain: '活动经营域', color: '#db2777', cols: [
    ['id', 'bigint', 'PK'], ['activity_id', 'integer', 'FK'], ['person_type', 'text', ''],
    ['person_id', 'integer', 'LFK'], ['person_name', 'text', ''], ['status', 'text', ''],
    ['relationship_note', 'text', ''], ['ai_followup_suggestion', 'text', ''],
  ]},
  // ===== 增员域 =====
  { id: 'recruit_candidates', x: 1510, y: 780, w: 420, domain: '增员域', color: '#7c3aed', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'bigint', 'FK'], ['recommender_id', 'bigint', 'LFK'],
    ['stage', 'text', ''], ['stage_changed_at', 'timestamptz', ''],
    ['potential_score', 'integer', ''], ['potential_reason', 'text', ''],
    ['education', 'text', ''], ['mbti', 'text', ''], ['motivation', 'text', ''],
    ['concerns', 'text', ''], ['work_experience', 'text', ''], ['family_situation', 'text', ''],
    ['personality_tags', 'text', ''], ['career_plan', 'text', ''],
    ['next_action_date', 'date', ''], ['next_action', 'text', ''],
    ['profile', 'jsonb', 'J'], ['radar_image_file_id', 'text', ''], ['winner_report_file_id', 'text', ''],
  ]},
  { id: 'recruit_followups', x: 1510, y: 1330, w: 420, domain: '增员域', color: '#7c3aed', cols: [
    ['id', 'bigint', 'PK'], ['candidate_id', 'bigint', 'LFK'], ['contact_method', 'text', ''],
    ['followup_notes', 'text', ''], ['followup_date', 'date', ''], ['interest_level', 'text', ''],
    ['concern_feedback', 'text', ''], ['next_followup_date', 'date', ''],
    ['next_followup_goal', 'text', ''], ['operator', 'text', ''],
  ]},
  { id: 'recruit_milestones', x: 1510, y: 1660, w: 420, domain: '增员域', color: '#7c3aed', cols: [
    ['id', 'bigint', 'PK'], ['candidate_id', 'bigint', 'FK'], ['from_stage', 'text', ''],
    ['to_stage', 'text', ''], ['happened_at', 'timestamptz', ''], ['note', 'text', ''],
  ]},
  // ===== 目标基准域 =====
  { id: 'recruit_goals', x: 2020, y: 200, w: 440, domain: '增员域', color: '#7c3aed', cols: [
    ['id', 'bigint', 'PK'], ['goal_month', 'date', ''], ['stage', 'text', ''],
    ['target_count', 'integer', ''], ['note', 'text', ''],
  ]},
  { id: 'recruit_goal_benchmarks', x: 2020, y: 420, w: 440, domain: '增员域', color: '#7c3aed', cols: [
    ['id', 'bigint', 'PK'], ['stage_from', 'text', ''], ['stage_to', 'text', ''],
    ['conversion_min', 'numeric', ''], ['conversion_avg', 'numeric', ''],
    ['conversion_good', 'numeric', ''], ['source', 'text', ''], ['note', 'text', ''],
  ]},
];

// ---------- 关系线 ----------
// type: fk=真实外键约束(实线蓝) logic=应用层逻辑关联(虚线橙) poly=多态(虚线红)
// pts: 折线点序列; label 标注; lx/ly 标注位置
const rels = [
  { type: 'fk', pts: [[400, 300], [450, 300]], label: '1:N', lx: 412, ly: 292 },
  { type: 'fk', pts: [[400, 640], [450, 360]], label: '1:N', lx: 415, ly: 480 },
  { type: 'fk', pts: [[400, 960], [450, 420]], label: '1:N', lx: 415, ly: 700 },
  { type: 'fk', pts: [[400, 1280], [450, 480]], label: '1:N', lx: 415, ly: 900 },
  { type: 'fk', pts: [[640, 760], [640, 652]], label: 'N:1', lx: 650, ly: 710 },
  { type: 'fk', pts: [[450, 1320], [425, 1320], [425, 540], [450, 540]], label: 'N:1', lx: 395, ly: 940 },
  { type: 'fk', pts: [[900, 800], [860, 800], [860, 550], [830, 550]], label: 'N:1', lx: 862, ly: 680 },
  { type: 'fk', pts: [[900, 1250], [880, 1250], [880, 610], [830, 610]], label: 'N:1', lx: 884, ly: 900 },
  { type: 'fk', pts: [[1510, 850], [1500, 850], [1500, 742], [870, 742], [870, 320], [830, 320]], label: 'N:1', lx: 1150, ly: 734 },
  { type: 'fk', pts: [[1720, 1660], [1720, 1254]], label: 'N:1', lx: 1730, ly: 1470 },
  { type: 'logic', pts: [[230, 560], [230, 454]], label: '1:N', lx: 240, ly: 510 },
  { type: 'logic', pts: [[400, 700], [1450, 700], [1450, 250], [1510, 250]], label: 'N:1', lx: 1000, ly: 692 },
  { type: 'logic', pts: [[1720, 440], [1720, 366]], label: 'N:1', lx: 1730, ly: 408 },
  { type: 'poly', pts: [[1510, 520], [1440, 520], [1440, 615], [830, 615]], label: '多态', lx: 1150, ly: 607 },
  { type: 'poly', pts: [[1930, 560], [1950, 560], [1950, 790], [1930, 790]], label: '多态', lx: 1955, ly: 680 },
  { type: 'logic', pts: [[1720, 1330], [1720, 1254]], label: 'N:1', lx: 1730, ly: 1296 },
  { type: 'logic', pts: [[1510, 950], [1498, 950], [1498, 726], [875, 726], [875, 340], [830, 340]], label: 'N:1', lx: 1150, ly: 718 },
];

// ---------- 渲染 ----------
const HEAD_H = 34, ROW_H = 22;
const eh = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tableH = t => HEAD_H + t.cols.length * ROW_H + 6;

let svg = [];
svg.push('<svg xmlns="http://www.w3.org/2000/svg" width="2520" height="2200" viewBox="0 0 2520 2200" font-family="Microsoft YaHei, PingFang SC, Segoe UI, sans-serif">');
svg.push('<defs><marker id="arr" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#475569"/></marker></defs>');
svg.push('<rect width="2520" height="2200" fill="#f8fafc"/>');

// 标题
svg.push('<text x="60" y="56" font-size="30" font-weight="bold" fill="#0f172a">Victor&#8217;s CRM 数据库 Schema 关系图 (v1.6.0)</text>');
svg.push('<text x="60" y="92" font-size="16" fill="#475569">PostgreSQL 共享集群 (CloudBase: crm-d1gkae8ddc930d151) &#183; 18 张业务表 &#183; 8 个视图 &#183; 9 条真实外键 + 7 条应用层逻辑关联 &#183; 实测于 2026-09-08</text>');

// 域背景块
const domains = [
  { name: '客户域 (Customer)', x: 30, y: 130, w: 1430, h: 1390, color: '#2563eb' },
  { name: '活动经营域 (Activity)', x: 1480, y: 130, w: 480, h: 580, color: '#db2777' },
  { name: '增员域 (Recruit)', x: 1480, y: 740, w: 480, h: 1160, color: '#7c3aed' },
  { name: '增员目标/行业基准', x: 1990, y: 130, w: 500, h: 560, color: '#0891b2' },
  { name: '视图层 (8 Views)', x: 1990, y: 740, w: 500, h: 780, color: '#64748b' },
];
domains.forEach(d => {
  svg.push(`<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" rx="14" fill="${d.color}" opacity="0.05" stroke="${d.color}" stroke-opacity="0.35" stroke-dasharray="6 4"/>`);
  svg.push(`<text x="${d.x + 18}" y="${d.y + 30}" font-size="17" font-weight="bold" fill="${d.color}">${eh(d.name)}</text>`);
});

// 关系线（画在表盒下层）
const relStyle = {
  fk:    { stroke: '#2563eb', dash: '', width: 2 },
  logic: { stroke: '#d97706', dash: '7 5', width: 2 },
  poly:  { stroke: '#dc2626', dash: '3 4', width: 2 },
};
rels.forEach(r => {
  const st = relStyle[r.type];
  const d = r.pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ');
  svg.push(`<path d="${d}" fill="none" stroke="${st.stroke}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} marker-end="url(#arr)" opacity="0.85"/>`);
  svg.push(`<text x="${r.lx}" y="${r.ly}" font-size="12" font-weight="bold" fill="${st.stroke}" opacity="0.95">${eh(r.label)}</text>`);
});

// 表盒
tables.forEach(t => {
  const h = tableH(t);
  svg.push(`<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${h}" rx="8" fill="#ffffff" stroke="${t.color}" stroke-width="2" filter="drop-shadow(0 2px 3px rgba(0,0,0,0.12))"/>`);
  svg.push(`<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${HEAD_H}" rx="8" fill="${t.color}"/>`);
  svg.push(`<rect x="${t.x}" y="${t.y + HEAD_H - 8}" width="${t.w}" height="8" fill="${t.color}"/>`);
  svg.push(`<text x="${t.x + 12}" y="${t.y + 23}" font-size="16" font-weight="bold" fill="#ffffff">${eh(t.id)}</text>`);
  t.cols.forEach((c, i) => {
    const ry = t.y + HEAD_H + i * ROW_H;
    if (i % 2 === 1) svg.push(`<rect x="${t.x + 1}" y="${ry}" width="${t.w - 2}" height="${ROW_H}" fill="#f1f5f9"/>`);
    const [n, ty, tag] = c;
    let tagTxt = '', tagColor = '#94a3b8', nameColor = '#1e293b';
    if (tag === 'PK') { tagTxt = 'PK'; tagColor = '#b45309'; nameColor = '#b45309'; }
    else if (tag === 'FK') { tagTxt = 'FK'; tagColor = '#7c3aed'; nameColor = '#5b21b6'; }
    else if (tag === 'LFK') { tagTxt = '&#8594;'; tagColor = '#d97706'; nameColor = '#92400e'; }
    else if (tag === 'J') { tagTxt = 'J'; tagColor = '#059669'; }
    else if (tag === 'E') { tagTxt = 'E'; tagColor = '#0891b2'; }
    svg.push(`<text x="${t.x + 10}" y="${ry + 15}" font-size="12" font-family="Consolas, monospace" fill="${nameColor}" font-weight="${tag === 'PK' ? 'bold' : 'normal'}">${tagTxt ? `<tspan fill="${tagColor}" font-weight="bold">[${tagTxt}]</tspan> ` : ''}${eh(n)}</text>`);
    svg.push(`<text x="${t.x + t.w - 10}" y="${ry + 15}" font-size="11" font-family="Consolas, monospace" fill="#94a3b8" text-anchor="end">${eh(abbr(ty))}</text>`);
  });
});

// 视图层内容
const views = [
  ['customers_view', 'customers'], ['followups_view', 'followups'], ['gifts_view', 'gifts'],
  ['photos_view', 'photos'], ['products_view', 'products'], ['ai_recommendations_view', 'ai_recommendations'],
  ['v_recruit_candidates', 'recruit_candidates JOIN customers'], ['v_recruit_candidates_trash', 'recruit_candidates (软删)'],
];
views.forEach((v, i) => {
  const vx = 2015, vy = 785 + i * 62;
  svg.push(`<rect x="${vx}" y="${vy}" width="450" height="50" rx="6" fill="#ffffff" stroke="#64748b" stroke-width="1.5"/>`);
  svg.push(`<text x="${vx + 12}" y="${vy + 20}" font-size="13" font-weight="bold" font-family="Consolas, monospace" fill="#334155">${eh(v[0])}</text>`);
  svg.push(`<text x="${vx + 12}" y="${vy + 39}" font-size="11" fill="#64748b">基于: ${eh(v[1])}${i < 6 ? ' &#183; 已 REVOKE anon' : ' &#183; GRANT anon SELECT'}</text>`);
});
svg.push('<text x="2015" y="1300" font-size="12" fill="#475569">6 张 *_view 防 owner 绕过 RLS &#183;</text>');
svg.push('<text x="2015" y="1320" font-size="12" fill="#475569">2 张 v_recruit_* 供前端直读（基表已 RLS）</text>');

// 枚举说明（右上域内补充）
svg.push('<text x="2020" y="660" font-size="12" fill="#0e7490">ENUM: 客户经营阶段(新认识/关系维护/需求挖掘/</text>');
svg.push('<text x="2020" y="678" font-size="12" fill="#0e7490">方案沟通/成交推进/转介绍经营) &#183; 优先级(A-E) &#183;</text>');
svg.push('<text x="2020" y="696" font-size="12" fill="#0e7490">跟进目标(建立联系/约见面/邀请活动/获取家庭信息/推进签单/推进招募/推进转介绍)</text>');

// 底部图例
const ly0 = 1930;
svg.push(`<rect x="30" y="${ly0}" width="2460" height="230" rx="12" fill="#ffffff" stroke="#cbd5e1"/>`);
svg.push(`<text x="55" y="${ly0 + 34}" font-size="17" font-weight="bold" fill="#0f172a">图例</text>`);
const legends = [
  { c: '#2563eb', dash: '', t: '实线箭头 = 真实外键约束（数据库强制，共 9 条）' },
  { c: '#d97706', dash: '7 5', t: '橙色虚线 = 应用层逻辑关联（无 FK 约束，共 5 条：followups.recommendation_id/activity_id、activity_participants.activity_id、recruit_followups.candidate_id、recruit_candidates.recommender_id）' },
  { c: '#dc2626', dash: '3 4', t: '红色虚线 = 多态关联（activity_participants.person_id：person_type=customer &#8594; customers.Id；person_type=recruit &#8594; recruit_candidates.id）' },
];
legends.forEach((l, i) => {
  const yy = ly0 + 66 + i * 30;
  svg.push(`<line x1="55" y1="${yy - 4}" x2="105" y2="${yy - 4}" stroke="${l.c}" stroke-width="2.5"${l.dash ? ` stroke-dasharray="${l.dash}"` : ''}/>`);
  svg.push(`<text x="115" y="${yy}" font-size="13" fill="#334155">${l.t}</text>`);
});
const tags = [
  ['PK', '#b45309', '主键'], ['FK', '#7c3aed', '真实外键列'], ['&#8594;', '#d97706', '逻辑外键列'],
  ['J', '#059669', 'JSONB 列'], ['E', '#0891b2', '枚举列(PG USER-DEFINED)'],
];
tags.forEach((tg, i) => {
  const xx = 55 + i * 300;
  svg.push(`<text x="${xx}" y="${ly0 + 190}" font-size="13" font-family="Consolas, monospace"><tspan fill="${tg[1]}" font-weight="bold">[${tg[0]}]</tspan><tspan fill="#334155" font-family="Microsoft YaHei"> ${tg[2]}</tspan></text>`);
});
svg.push(`<text x="1560" y="${ly0 + 190}" font-size="13" fill="#475569">注：所有表均含 created_at/updated_at；主对象及子表含 deleted_at（级联软删除），图中省略。</text>`);

svg.push(`<text x="60" y="${2185}" font-size="13" fill="#94a3b8">Victor&#8217;s CRM v1.6.0 &#183; docs/db-schema-v1.6.0.svg &#183; 由 tools/gen-schema-svg.js 生成（数据实测自生产库 information_schema）</text>`);
svg.push('</svg>');

const out = path.join(__dirname, '..', 'docs', 'db-schema-v1.6.0.svg');
fs.writeFileSync(out, svg.join('\n'), 'utf8');
console.log('SVG 已生成:', out, (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
