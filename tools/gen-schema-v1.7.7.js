/**
 * 生成 Victor's CRM v1.7.7 数据库 Schema 关系图 (SVG)
 * 数据来源: 迁移文件 + 生产库实测 (截至 v1.7.7)
 * 输出: docs/db-schema-v1.7.7.svg
 */
const fs = require('fs');
const path = require('path');

const TYPE_ABBR = {
  'integer': 'int', 'bigint': 'bigint', 'smallint': 'small', 'text': 'text',
  'date': 'date', 'jsonb': 'jsonb', 'numeric': 'numeric',
  'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp',
  'USER-DEFINED': 'enum',
};
const abbr = t => TYPE_ABBR[t] || t;

const T = (name, domain, color) => ({ name, domain, color });

// 列定义: [名称, 类型, 标记] 标记: PK|FK|LFK(逻辑外键)|J(jsonb)|E(enum)|空
const tables = [
  // ===== 客户域 =====
  { id: 'customers', x: 460, y: 200, w: 390, domain: '客户域', color: '#2563eb', cols: [
    ['Id', 'integer', 'PK'], ['customer_name', 'text', ''], ['phone', 'text', ''], ['gender', 'text', ''],
    ['birthday', 'date', ''], ['occupation', 'text', ''], ['annual_income', 'integer', ''],
    ['household_income', 'integer', ''], ['source', 'text', ''], ['tags', 'text', ''],
    ['marital_status', 'text', ''], ['properties_info', 'text', ''],
    ['customer_stage', '客户经营阶段', 'E'], ['sales_priority', '优先级', 'E'],
    ['recruitment_priority', '优先级', 'E'], ['referral_priority', '优先级', 'E'],
    ['hobbies', 'text', ''], ['education', 'text', ''], ['mbti', 'text', ''],
    ['wx_account', 'text', ''], ['first_contact_date', 'date', ''],
    ['additional_info', 'text', ''], ['profile', 'jsonb', 'J'],
  ]},
  { id: 'ai_recommendations', x: 50, y: 200, w: 350, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'integer', 'FK'], ['customer_name', 'text', ''],
    ['recommendation_date', 'date', ''], ['suggested_message', 'text', ''],
    ['suggested_strategy', 'text', ''], ['suggested_followup_date', 'date', ''],
    ['suggested_customer_stage', '客户经营阶段', 'E'], ['suggested_followup_goal', '跟进目标', 'E'],
    ['nba', 'jsonb', 'J'], ['updated_at', 'timestamptz', ''],
  ]},
  { id: 'followups', x: 50, y: 580, w: 350, domain: '客户域', color: '#2563eb', cols: [
    ['Id', 'integer', 'PK'], ['customer_id', 'integer', 'FK'], ['customer_name', 'text', ''],
    ['followup_notes', 'text', ''], ['followup_date', 'date', ''],
    ['next_followup_date', 'date', ''], ['next_followup_goal', '跟进目标', 'E'],
    ['recommendation_id', 'integer', 'LFK'], ['activity_id', 'integer', 'LFK'],
  ]},
  { id: 'gifts', x: 50, y: 920, w: 350, domain: '客户域', color: '#2563eb', cols: [
    ['Id', 'bigint', 'PK'], ['customer_id', 'integer', 'FK'], ['customer_name', 'text', ''],
    ['gift_name', 'text', ''], ['quantity', 'smallint', ''], ['given_date', 'date', ''], ['notes', 'text', ''],
  ]},
  { id: 'photos', x: 50, y: 1200, w: 350, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'integer', 'PK'], ['customer_id', 'integer', 'FK'], ['customer_name', 'text', ''],
    ['photo_url', 'text', ''], ['thumbnail_url', 'text', ''], ['file_name', 'text', ''],
    ['content_type', 'text', ''], ['category', 'text', ''], ['sort_order', 'integer', ''],
  ]},
  { id: 'products', x: 460, y: 780, w: 390, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'bigint', 'FK'], ['customer_name', 'text', ''],
    ['ap_ipa', 'bigint', ''], ['ap_ltc', 'bigint', ''], ['ap_ann', 'bigint', ''],
    ['ap_life', 'bigint', ''], ['ap_term', 'bigint', ''], ['ap_wl', 'bigint', ''],
    ['ap_pa', 'bigint', ''], ['ap_ci', 'bigint', ''], ['ap_hi', 'bigint', ''],
    ['ap_all', 'bigint', ''], ['ap_ppa', 'bigint', ''], ['items', 'text', ''],
  ]},
  { id: 'ocr_records', x: 460, y: 1230, w: 390, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'bigint', 'FK'], ['summary', 'text', ''],
    ['raw_text', 'text', ''], ['file_ids', 'text', ''], ['file_names', 'text', ''],
    ['customer_snapshot', 'text', ''],
  ]},
  { id: 'policy_review_reports', x: 900, y: 780, w: 430, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'bigint', 'FK'], ['customer_name', 'text', ''],
    ['report_date', 'date', ''], ['report_type', 'text', ''], ['summary', 'text', ''],
    ['gaps_found', 'text', ''], ['recommendations', 'text', ''], ['asset_allocation', 'text', ''],
    ['next_action', 'text', ''], ['raw', 'text', ''],
    ['edited_summary…edited_next_action', 'text', ''],
  ]},
  { id: 'opportunities', x: 900, y: 1170, w: 430, domain: '客户域', color: '#2563eb', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'integer', 'FK'], ['opportunity_type', 'text', ''],
    ['status', 'text', ''], ['referred_name', 'text', ''], ['referred_relation', 'text', ''],
    ['discovered_at', 'date', ''], ['last_progress', 'text', ''], ['next_action', 'text', ''],
    ['ai_summary', 'text', ''],
  ]},
  // ===== 活动经营域 =====
  { id: 'activities', x: 1520, y: 200, w: 430, domain: '活动经营域', color: '#db2777', cols: [
    ['id', 'bigint', 'PK'], ['name', 'text', ''], ['activity_date', 'date', ''],
    ['activity_type', 'text', ''], ['location', 'text', ''], ['description', 'text', ''],
    ['status', 'text', 'E'], ['goal_types', 'jsonb', 'J'], ['topic_ids', 'jsonb', 'J'],
    ['target_participants', 'integer', ''], ['actual_participants', 'integer', ''],
    ['review_summary', 'text', ''], ['review_score', 'numeric', ''],
  ]},
  { id: 'activity_participants', x: 1520, y: 540, w: 430, domain: '活动经营域', color: '#db2777', cols: [
    ['id', 'bigint', 'PK'], ['activity_id', 'integer', 'FK'], ['person_type', 'text', ''],
    ['person_id', 'bigint', 'LFK'], ['person_name', 'text', ''], ['status', 'text', ''],
    ['participant_role', 'text', ''], ['followup_status', 'text', ''],
    ['relationship_note', 'text', ''], ['ai_followup_suggestion', 'text', ''],
  ]},
  { id: 'activity_tasks', x: 1520, y: 860, w: 430, domain: '活动经营域', color: '#db2777', cols: [
    ['id', 'bigint', 'PK'], ['activity_id', 'bigint', 'FK'], ['task_title', 'text', ''],
    ['task_type', 'text', 'E'], ['status', 'text', 'E'], ['priority', 'text', 'E'],
    ['due_date', 'date', ''], ['completed_at', 'timestamptz', ''],
    ['related_type', 'text', 'E'], ['related_id', 'bigint', 'LFK'],
    ['note', 'text', ''], ['source', 'text', 'E'],
  ]},
  { id: 'activity_speakers', x: 2050, y: 200, w: 430, domain: '活动经营域', color: '#db2777', cols: [
    ['id', 'bigint', 'PK'], ['name', 'text', ''], ['phone', 'text', ''], ['wechat', 'text', ''],
    ['organization', 'text', ''], ['position', 'text', ''],
    ['relationship_stage', 'text', 'E'], ['expertise', 'text', ''], ['topic_summary', 'text', ''],
    ['source', 'text', ''], ['cooperation_count', 'integer', ''],
    ['preferred_format', 'text', ''], ['status', 'text', 'E'],
    ['customer_id', 'bigint', 'LFK'], ['recruit_candidate_id', 'bigint', 'LFK'],
  ]},
  { id: 'activity_topics', x: 2050, y: 700, w: 430, domain: '活动经营域', color: '#db2777', cols: [
    ['id', 'bigint', 'PK'], ['topic_name', 'text', ''], ['category', 'text', ''],
    ['description', 'text', ''], ['target_audience', 'text', ''],
    ['keywords', 'jsonb', 'J'], ['status', 'text', 'E'],
    ['use_count', 'integer', ''], ['last_used_date', 'date', ''],
    ['ai_summary', 'text', ''], ['notes', 'text', ''],
  ]},
  // ===== 增员域 =====
  { id: 'recruit_candidates', x: 1520, y: 1180, w: 430, domain: '增员域', color: '#7c3aed', cols: [
    ['id', 'bigint', 'PK'], ['customer_id', 'bigint', 'FK'], ['recommender_id', 'bigint', 'LFK'],
    ['stage', 'text', ''], ['stage_changed_at', 'timestamptz', ''],
    ['potential_score', 'integer', ''], ['potential_reason', 'text', ''],
    ['motivation', 'text', ''], ['concerns', 'text', ''],
    ['work_experience', 'text', ''], ['family_situation', 'text', ''],
    ['personality_tags', 'text', ''], ['career_plan', 'text', ''],
    ['next_action_date', 'date', ''], ['next_action', 'text', ''],
    ['activity_history', 'jsonb', 'J'], ['profile', 'jsonb', 'J'],
    ['radar_image_file_id', 'text', ''], ['radar_image_name', 'text', ''],
    ['winner_report_file_id', 'text', ''], ['winner_report_name', 'text', ''],
  ]},
  { id: 'recruit_followups', x: 1520, y: 1730, w: 430, domain: '增员域', color: '#7c3aed', cols: [
    ['id', 'bigint', 'PK'], ['candidate_id', 'bigint', 'LFK'], ['contact_method', 'text', ''],
    ['followup_notes', 'text', ''], ['followup_date', 'date', ''], ['interest_level', 'text', ''],
    ['concern_feedback', 'text', ''], ['next_followup_date', 'date', ''],
    ['next_followup_goal', 'text', ''], ['operator', 'text', ''],
  ]},
  { id: 'recruit_milestones', x: 2050, y: 1200, w: 430, domain: '增员域', color: '#7c3aed', cols: [
    ['id', 'bigint', 'PK'], ['candidate_id', 'bigint', 'FK'], ['from_stage', 'text', ''],
    ['to_stage', 'text', ''], ['happened_at', 'timestamptz', ''], ['note', 'text', ''],
  ]},
  // ===== 目标基准域 =====
  { id: 'recruit_goals', x: 2050, y: 1470, w: 430, domain: '增员域', color: '#7c3aed', cols: [
    ['id', 'bigint', 'PK'], ['goal_month', 'date', ''], ['stage', 'text', ''],
    ['target_count', 'integer', ''], ['note', 'text', ''],
  ]},
  { id: 'recruit_goal_benchmarks', x: 2050, y: 1690, w: 430, domain: '增员域', color: '#0891b2', cols: [
    ['id', 'bigint', 'PK'], ['stage_from', 'text', ''], ['stage_to', 'text', ''],
    ['conversion_min', 'numeric', ''], ['conversion_avg', 'numeric', ''],
    ['conversion_good', 'numeric', ''], ['source', 'text', ''], ['note', 'text', ''],
  ]},
];

// ---------- 关系线 ----------
const rels = [
  { type: 'fk', pts: [[400, 300], [460, 300]], label: '1:N', lx: 415, ly: 292 },
  { type: 'fk', pts: [[400, 660], [460, 360]], label: '1:N', lx: 415, ly: 490 },
  { type: 'fk', pts: [[400, 980], [460, 420]], label: '1:N', lx: 415, ly: 700 },
  { type: 'fk', pts: [[400, 1260], [460, 480]], label: '1:N', lx: 415, ly: 900 },
  { type: 'fk', pts: [[660, 780], [660, 672]], label: 'N:1', lx: 670, ly: 730 },
  { type: 'fk', pts: [[460, 1320], [430, 1320], [430, 560], [460, 560]], label: 'N:1', lx: 400, ly: 940 },
  { type: 'fk', pts: [[900, 820], [870, 820], [870, 570], [840, 570]], label: 'N:1', lx: 875, ly: 690 },
  { type: 'fk', pts: [[900, 1260], [880, 1260], [880, 630], [840, 630]], label: 'N:1', lx: 885, ly: 940 },
  { type: 'fk', pts: [[1520, 1280], [1510, 1280], [1510, 742], [880, 742], [880, 320], [840, 320]], label: 'N:1', lx: 1180, ly: 734 },
  { type: 'fk', pts: [[1730, 1200], [1730, 1154]], label: 'N:1', lx: 1740, ly: 1180 },
  { type: 'fk', pts: [[1520, 900], [1500, 900], [1500, 760], [880, 760], [880, 340], [840, 340]], label: 'N:1', lx: 1180, ly: 752 },
  { type: 'logic', pts: [[230, 580], [230, 474]], label: '1:N', lx: 240, ly: 530 },
  { type: 'logic', pts: [[400, 720], [1470, 720], [1470, 250], [1520, 250]], label: 'N:1', lx: 990, ly: 712 },
  { type: 'logic', pts: [[1730, 540], [1730, 466]], label: 'N:1', lx: 1740, ly: 510 },
  { type: 'logic', pts: [[1730, 1730], [1730, 1654]], label: 'N:1', lx: 1740, ly: 1700 },
  { type: 'logic', pts: [[1520, 1380], [1508, 1380], [1508, 726], [885, 726], [885, 360], [840, 360]], label: 'N:1', lx: 1180, ly: 718 },
  { type: 'poly', pts: [[1520, 620], [1450, 620], [1450, 615], [840, 615]], label: '多态', lx: 1150, ly: 607 },
  { type: 'poly', pts: [[1950, 940], [1980, 940], [1980, 280], [2050, 280]], label: '活动→主题', lx: 1990, ly: 620 },
];

const HEAD_H = 34, ROW_H = 22;
const eh = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tableH = t => HEAD_H + t.cols.length * ROW_H + 6;

let svg = [];
const W = 2580, H = 2300;
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Microsoft YaHei, PingFang SC, Segoe UI, sans-serif">`);
svg.push('<defs><marker id="arr" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#475569"/></marker></defs>');
svg.push(`<rect width="${W}" height="${H}" fill="#f8fafc"/>`);

svg.push('<text x="60" y="56" font-size="30" font-weight="bold" fill="#0f172a">Victor&#8217;s CRM 数据库 Schema 关系图 (v1.7.7)</text>');
svg.push('<text x="60" y="92" font-size="16" fill="#475569">PostgreSQL 共享集群 (CloudBase: crm-d1gkae8ddc930d151) &#183; 20 张业务表 &#183; 9 个视图 &#183; 截至 v1.7.7</text>');

const domains = [
  { name: '客户域 (Customer)', x: 30, y: 130, w: 1430, h: 1430, color: '#2563eb' },
  { name: '活动经营域 (Activity)', x: 1490, y: 130, w: 530, h: 1030, color: '#db2777' },
  { name: '增员域 (Recruit)', x: 1490, y: 1160, w: 530, h: 1050, color: '#7c3aed' },
  { name: '活动资源池 (Speakers/Topics)', x: 2020, y: 130, w: 530, h: 1000, color: '#db2777' },
  { name: '增员目标/基准', x: 2020, y: 1370, w: 530, h: 560, color: '#0891b2' },
];
domains.forEach(d => {
  svg.push(`<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" rx="14" fill="${d.color}" opacity="0.04" stroke="${d.color}" stroke-opacity="0.3" stroke-dasharray="6 4"/>`);
  svg.push(`<text x="${d.x + 18}" y="${d.y + 30}" font-size="17" font-weight="bold" fill="${d.color}">${eh(d.name)}</text>`);
});

const relStyle = {
  fk:    { stroke: '#2563eb', dash: '', width: 2 },
  logic: { stroke: '#d97706', dash: '7 5', width: 2 },
  poly:  { stroke: '#dc2626', dash: '3 4', width: 2 },
};
rels.forEach(r => {
  const st = relStyle[r.type];
  const d = r.pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ');
  svg.push(`<path d="${d}" fill="none" stroke="${st.stroke}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} marker-end="url(#arr)" opacity="0.75"/>`);
  svg.push(`<text x="${r.lx}" y="${r.ly}" font-size="11" font-weight="bold" fill="${st.stroke}" opacity="0.9">${eh(r.label)}</text>`);
});

tables.forEach(t => {
  const h = tableH(t);
  svg.push(`<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${h}" rx="8" fill="#ffffff" stroke="${t.color}" stroke-width="2" filter="drop-shadow(0 2px 3px rgba(0,0,0,0.12))"/>`);
  svg.push(`<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${HEAD_H}" rx="8" fill="${t.color}"/>`);
  svg.push(`<rect x="${t.x}" y="${t.y + HEAD_H - 8}" width="${t.w}" height="8" fill="${t.color}"/>`);
  svg.push(`<text x="${t.x + 12}" y="${t.y + 23}" font-size="15" font-weight="bold" fill="#ffffff">${eh(t.id)}</text>`);
  t.cols.forEach((c, i) => {
    const ry = t.y + HEAD_H + i * ROW_H;
    if (i % 2 === 1) svg.push(`<rect x="${t.x + 1}" y="${ry}" width="${t.w - 2}" height="${ROW_H}" fill="#f1f5f9"/>`);
    const [n, ty, tag] = c;
    let tagTxt = '', tagColor = '#94a3b8', nameColor = '#1e293b';
    if (tag === 'PK') { tagTxt = 'PK'; tagColor = '#b45309'; nameColor = '#b45309'; }
    else if (tag === 'FK') { tagTxt = 'FK'; tagColor = '#7c3aed'; nameColor = '#5b21b6'; }
    else if (tag === 'LFK') { tagTxt = '\u2192'; tagColor = '#d97706'; nameColor = '#92400e'; }
    else if (tag === 'J') { tagTxt = 'J'; tagColor = '#059669'; }
    else if (tag === 'E') { tagTxt = 'E'; tagColor = '#0891b2'; }
    svg.push(`<text x="${t.x + 10}" y="${ry + 15}" font-size="11" font-family="Consolas, monospace" fill="${nameColor}" font-weight="${tag === 'PK' ? 'bold' : 'normal'}">${tagTxt ? `<tspan fill="${tagColor}" font-weight="bold">[${tagTxt}]</tspan> ` : ''}${eh(n)}</text>`);
    svg.push(`<text x="${t.x + t.w - 10}" y="${ry + 15}" font-size="10" font-family="Consolas, monospace" fill="#94a3b8" text-anchor="end">${eh(abbr(ty))}</text>`);
  });
});

// 视图层
const views = [
  ['customers_view', 'customers \u00b7 REVOKE anon'],
  ['followups_view', 'followups \u00b7 REVOKE anon'],
  ['gifts_view', 'gifts \u00b7 REVOKE anon'],
  ['photos_view', 'photos \u00b7 REVOKE anon'],
  ['products_view', 'products \u00b7 REVOKE anon'],
  ['ai_recommendations_view', 'ai_recommendations \u00b7 REVOKE anon'],
  ['v_recruit_candidates', 'recruit JOIN customers \u00b7 GRANT anon'],
  ['v_recruit_candidates_trash', 'recruit (soft-deleted) \u00b7 GRANT anon'],
  ['activity_participants_view', 'activity_participants \u00b7 REVOKE anon'],
];
views.forEach((v, i) => {
  const vx = 2045, vy = 1190 + i * 52;
  svg.push(`<rect x="${vx}" y="${vy}" width="470" height="42" rx="6" fill="#ffffff" stroke="#64748b" stroke-width="1.5"/>`);
  svg.push(`<text x="${vx + 12}" y="${vy + 18}" font-size="12" font-weight="bold" font-family="Consolas, monospace" fill="#334155">${eh(v[0])}</text>`);
  svg.push(`<text x="${vx + 12}" y="${vy + 35}" font-size="10" fill="#64748b">${eh(v[1])}</text>`);
});

// 底部图例
const ly0 = 2030;
svg.push(`<rect x="30" y="${ly0}" width="${W - 60}" height="240" rx="12" fill="#ffffff" stroke="#cbd5e1"/>`);
svg.push(`<text x="55" y="${ly0 + 34}" font-size="17" font-weight="bold" fill="#0f172a">图例</text>`);
const legends = [
  { c: '#2563eb', dash: '', t: '实线箭头 = 真实外键约束（数据库强制）' },
  { c: '#d97706', dash: '7 5', t: '橙色虚线 = 应用层逻辑关联（无 FK 约束：followups.recommendation_id/activity_id、recruit_followups.candidate_id、recruit_candidates.recommender_id）' },
  { c: '#dc2626', dash: '3 4', t: '红色虚线 = 多态关联（activity_participants.person_id：person_type=customer\u2192customers.Id；person_type=recruit\u2192recruit_candidates.id；person_type=speaker\u2192activity_speakers.id）' },
];
legends.forEach((l, i) => {
  const yy = ly0 + 66 + i * 30;
  svg.push(`<line x1="55" y1="${yy - 4}" x2="105" y2="${yy - 4}" stroke="${l.c}" stroke-width="2.5"${l.dash ? ` stroke-dasharray="${l.dash}"` : ''}/>`);
  svg.push(`<text x="115" y="${yy}" font-size="13" fill="#334155">${l.t}</text>`);
});
const tags = [
  ['PK', '#b45309', '主键'], ['FK', '#7c3aed', '真实外键列'], ['\u2192', '#d97706', '逻辑外键列'],
  ['J', '#059669', 'JSONB 列'], ['E', '#0891b2', '枚举列'],
];
tags.forEach((tg, i) => {
  const xx = 55 + i * 300;
  svg.push(`<text x="${xx}" y="${ly0 + 190}" font-size="13" font-family="Consolas, monospace"><tspan fill="${tg[1]}" font-weight="bold">[${tg[0]}]</tspan><tspan fill="#334155" font-family="Microsoft YaHei"> ${tg[2]}</tspan></text>`);
});
svg.push(`<text x="1560" y="${ly0 + 190}" font-size="13" fill="#475569">注：所有表均含 created_at/updated_at；主对象及子表含 deleted_at（软删除），图中省略。</text>`);
svg.push(`<text x="60" y="${H - 30}" font-size="13" fill="#94a3b8">Victor&#8217;s CRM v1.7.7 &#183; docs/db-schema-v1.7.7.svg &#183; 由 tools/gen-schema-v1.7.7.js 生成</text>`);
svg.push('</svg>');

const out = path.join(__dirname, '..', 'docs', 'db-schema-v1.7.7.svg');
fs.writeFileSync(out, svg.join('\n'), 'utf8');
console.log('SVG 已生成:', out, (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
