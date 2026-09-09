/**
 * today_coach — AI 今日经营驾驶舱（事件云函数，超时 120s，rdb() 版）
 *
 * 设计原则（v1.0.4 增量，2026-09-06）：
 * - 第一版不依赖 AI 做筛选：先按现有数据规则打分生成候选池，AI 仅做综合排序 + 生成简短理由
 * - 不写数据库、不新增表/字段；纯读聚合（同 activity_reports 模式：全量裁列 select + JS 计算）
 * - action:
 *     candidates: { action:'candidates' }
 *       → 纯规则筛选（不调 AI，快），返回 { today, fingerprint, customerPool, recruitPool, activityPool }
 *     generate:   { action:'generate' }
 *       → 规则候选（客户 top12 + 增员 top9 + v1.7.6 活动行动 top12）→ hy3 结构化排序/NBA → { today, fingerprint, source, items }
 *         v1.7.6 Activity → Today：活动行动（活动任务逾期/到期、活动后重要人员未跟进、嘉宾到联系时间、
 *           待复盘、AI复盘行动到期）统一为 { type:'activity_action', source_type, source_id, action_type,
 *           activity_id, person_type, person_id, speaker_id, ... }；AI 参与排序，失败降级规则版；
 *           最终列表活动行动 ≤5 条，不抢占 Top 15；纯只读，不建表。
 *         items[]: { type:'customer'|'recruit', id, name, stage, priority,
 *                    assessment(当前经营判断), goal(经营目标), next_action(下一最佳行动),
 *                    topic(推荐沟通主题), avoid(不建议), success_criteria(成功标准),
 *                    next_followup_date(建议下一次跟进时间，取自现有数据), nba_from?('detail'=直接引用详情页NBA) }
 *         Next Best Action（v1.0.7 增量）：与详情页 ai_recommend/recruit_recommend 同构 7 字段；
 *           客户若在 NBA_FRESH_DAYS 天内已有 ai_recommendations.nba → 直接引用（nba_from='detail'）；
 *           其余由 AI 生成（增员候选用增员语言）；AI 失败自动降级为规则版（source:'rule'），
 *           规则版 assessment=真实规则信号，其余字段按类型给可执行默认值，不编造客户信息
 *         next_followup_date 统一取自现有数据（customers.next_followup_date / recruit_candidates.next_action_date），
 *         AI 不生成日期，杜绝编造；无数据为空串，前端显示"信息不足"
 *     v1.8 Sprint3（Today 5，2026-09-09）：generate 升级为 Today 5 —— 事实全部取统一行动视图
 *       v_action_center（status overdue/today/upcoming/unscheduled、days_until、last_followup_date 均 SQL 计算，
 *       AI 不参与基础事实）；AI 只负责综合 Urgency/Impact/Relationship/Opportunity/Timing/Actionability 六维
 *       选出今天最值得做的 5 件（Must Do×2/Recommended×2/Optional×1），返回
 *       today5[]{ tier, action, reason, priority, channel, goal, suggested_date, script, confidence, evidence,
 *                 action_id, action_type, person_type, person_id, person_name, title, source, status, stage, days_until }
 *       all_actions[]（「查看全部」事实清单，纯事实不调 AI）；items 为 today5 的旧结构映射（当前前端兼容）。
 *       防虚构：evidence 只能引用候选事实、suggested_date 只能回显视图日期/今天、缺信息强制降 confidence；
 *       AI 失败降级规则版（confidence 封顶 medium）；候选不足 5 件不凑数。
 * - fingerprint: 四表 max(updated_at) 拼串，前端用于"当天缓存 + 数据变化提示"
 *
 * 日期口径：与 activity_reports 一致，按北京日期（+08:00）归属；纯日期串直接用。
 */
'use strict';

const { rdb, generateText, extractJson, assertOk, nowIso } = require('./db');

const POOL_CUSTOMER = 12;  // 进入 AI 排序的客户候选数
const POOL_RECRUIT = 9;    // 进入 AI 排序的增员候选数
const FINAL_COUNT = 15;    // 最终展示人数
const NBA_FRESH_DAYS = 14; // 详情页 NBA 在此天数内视为新鲜，今日经营直接引用

// ---------- 北京日期工具（同 activity_reports 口径） ----------
function bjNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function todayStr() { return bjNow().toISOString().slice(0, 10); }
function dayKeyOf(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !/T|\d{2}:\d{2}/.test(s.slice(10))) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function diffDays(dateStr, baseStr) {
  if (!dateStr || !baseStr) return null;
  return Math.round((Date.parse(dateStr) - Date.parse(baseStr)) / 86400000);
}
function cut(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------- 数据读取（全量裁列 + deleted_at 过滤） ----------
async function loadAll() {
  const [cust, fol, rc, rf, rm, ai, opp, act, atask, apart, aspk, vac] = await Promise.all([
    rdb.from('customers').select(
      'Id, customer_name, gender, customer_stage, sales_priority, first_contact_date, created_at, updated_at'
    ).is('deleted_at', null),
    // followups：v1.7.6 增加 Id/activity_id/recommendation_id（活动跟进/AI复盘采纳行动到期判定）
    rdb.from('followups').select(
      'Id, customer_id, followup_date, next_followup_date, followup_notes, activity_id, recommendation_id, updated_at'
    ).is('deleted_at', null),
    rdb.from('recruit_candidates').select(
      'id, customer_id, stage, stage_changed_at, next_action_date, next_action, potential_score, created_at, updated_at'
    ).is('deleted_at', null),
    rdb.from('recruit_followups').select(
      'candidate_id, followup_date, followup_notes, interest_level, next_followup_date, updated_at'
    ).is('deleted_at', null),
    rdb.from('recruit_milestones').select('candidate_id, to_stage, happened_at'),
    // 详情页 Next Best Action（仅裁 NBA 相关列，按 created_at 倒序，取每人最新一条）
    rdb.from('ai_recommendations').select('customer_id, nba, recommendation_date, created_at')
      .order('created_at', { ascending: false }),
    // 经营机会（v1.4：转介绍线索进入今日经营）
    rdb.from('opportunities').select(
      'id, customer_id, opportunity_type, status, referred_name, next_action, discovered_at, created_at, updated_at'
    ).is('deleted_at', null),
    // 活动（v1.6 复盘用；v1.7.6 增加 status/reviewed_at 用于活动行动判定）
    rdb.from('activities').select(
      'id, name, activity_date, activity_type, location, description, status, reviewed_at, created_at, updated_at'
    ).is('deleted_at', null),
    // 活动待办任务（v1.7.6：硬删除表，无 deleted_at）
    rdb.from('activity_tasks').select(
      'id, activity_id, task_title, task_type, status, priority, due_date, related_type, related_id, created_at, updated_at'
    ),
    // 活动参与者（v1.7.6：活动后未跟进判定）
    rdb.from('activity_participants').select(
      'id, activity_id, person_type, person_id, person_name, status, participant_role, followup_status, updated_at'
    ).is('deleted_at', null),
    // 嘉宾资源池（v1.7.6：到联系时间判定）
    rdb.from('activity_speakers').select(
      'id, name, organization, position, expertise, relationship_stage, status, next_contact_date, last_contact_date, cooperation_count, updated_at'
    ).is('deleted_at', null),
    // v1.8 Sprint3：Action Center 统一行动视图（Today 5 数据源；逾期/到期/阶段/最近跟进等事实 SQL 已计算）
    rdb.from('v_action_center').select(
      'action_id, action_type, person_type, person_id, person_name, title, next_action, action_date, priority, source, status, stage, days_until, last_followup_date'
    ),
  ]);
  if (vac && vac.error) throw new Error('v_action_center 读取失败：' + vac.error);
  return {
    customers: (cust.data || []),
    followups: (fol.data || []),
    candidates: (rc.data || []),
    recruitFollowups: (rf.data || []),
    milestones: (rm.data || []),
    aiRecs: (ai.data || []),
    opportunities: (opp.data || []),
    activities: (act.data || []),
    activityTasks: (atask.data || []),
    participants: (apart.data || []),
    speakers: (aspk.data || []),
    actions: (vac.data || []),
  };
}

// 每个来源客户最新一条进行中的转介绍线索（v1.4）
function indexActiveReferrals(opps) {
  const byCust = {};
  for (const o of (opps || [])) {
    if (o.opportunity_type !== '转介绍') continue;
    if (o.status === '关闭' || o.status === '成交') continue;
    const cid = o.customer_id;
    if (!cid) continue;
    const prev = byCust[cid];
    if (!prev || String(o.updated_at || '') > String(prev.updated_at || '')) byCust[cid] = o;
  }
  return byCust;
}

// 每个客户最近一条"新鲜" NBA（recommendation_date 距今 ≤ NBA_FRESH_DAYS 天）→ 直接引用
function indexFreshNba(d, today) {
  const out = {};
  for (const r of (d.aiRecs || [])) {
    const cid = r.customer_id;
    if (!cid || out[cid] || !r.nba || typeof r.nba !== 'object') continue; // 倒序，首条即最新
    const d0 = dayKeyOf(r.recommendation_date) || dayKeyOf(r.created_at) || '';
    if (!d0) continue;
    const age = -diffDays(d0, today);
    if (age <= NBA_FRESH_DAYS) out[cid] = r.nba;
  }
  return out;
}

// fingerprint：主数据表 max(updated_at) 拼串（阶段变化会 update recruit_candidates，故里程碑不必单算）
// v1.7.6：纳入 activities/activity_tasks/participants/speakers，活动行动变化也触发缓存提示
function buildFingerprint(d) {
  function maxUpd(rows) {
    let m = '';
    for (const r of rows) {
      const v = r.updated_at || r.created_at || '';
      if (v > m) m = v;
    }
    return m;
  }
  return [
    maxUpd(d.customers), maxUpd(d.followups),
    maxUpd(d.candidates), maxUpd(d.recruitFollowups),
    maxUpd(d.opportunities || []),
    maxUpd(d.activities || []),
    maxUpd(d.activityTasks || []),
    maxUpd(d.participants || []),
    maxUpd(d.speakers || []),
  ].join('|');
}

// 每个客户的最新一条跟进 + 该客户全部跟进数
function indexFollowups(followups) {
  const byCust = {};
  for (const f of followups) {
    const cid = f.customer_id;
    if (!byCust[cid]) byCust[cid] = { latest: f, count: 0 };
    byCust[cid].count++;
    // followups 未强制有序，按 followup_date 取最新
    const a = dayKeyOf(f.followup_date) || '', b = dayKeyOf(byCust[cid].latest.followup_date) || '';
    if (a > b) byCust[cid].latest = f;
  }
  return byCust;
}

const NEED_KEYWORDS = ['意向', '兴趣', '需求', '考虑', '犹豫', '方案', '报价', '成交', '签约', '询问'];

// ---------- 客户池规则引擎 ----------
function scoreCustomers(d, today) {
  const folIdx = indexFollowups(d.followups);
  const refIdx = indexActiveReferrals(d.opportunities);
  const out = [];
  for (const c of d.customers) {
    let score = 0; const hits = [];
    const fol = folIdx[c.Id];
    const lastFolDate = fol ? (dayKeyOf(fol.latest.followup_date) || dayKeyOf(c.first_contact_date) || dayKeyOf(c.created_at)) : (dayKeyOf(c.first_contact_date) || dayKeyOf(c.created_at));
    const nextDate = dayKeyOf(c.next_followup_date);

    const nd = diffDays(nextDate, today);
    if (nd !== null && nd < 0) { score += 40; hits.push('跟进已逾期 ' + (-nd) + ' 天'); }
    else if (nd === 0) { score += 35; hits.push('今日待跟进'); }
    else if (nd !== null && nd >= 1 && nd <= 7) { score += 20; hits.push(nd + ' 天内到期跟进'); }

    const idle = lastFolDate ? -diffDays(lastFolDate, today) : null;
    if (idle !== null && idle >= 30) { score += 30; hits.push('已 ' + idle + ' 天未联系'); }

    if (fol) {
      const fd = diffDays(dayKeyOf(fol.latest.followup_date), today);
      if (fd !== null && fd >= -3 && fd <= 0) { score += 10; hits.push('近期活跃跟进'); }
      const notes = fol.latest.followup_notes || '';
      if (fd !== null && fd >= -14 && fd <= 0 && NEED_KEYWORDS.some(k => notes.indexOf(k) >= 0)) {
        score += 15; hits.push('近期提及需求/意向');
      }
    } else {
      const cd = diffDays(dayKeyOf(c.created_at), today);
      if (cd !== null && cd >= -7 && cd <= 0) { score += 20; hits.push('新客户待首访'); }
    }

    if (c.sales_priority === 'A' || c.sales_priority === 'B') { score += 5; hits.push(c.sales_priority + ' 类重点客户'); }

    // v1.4 转介绍经营信号：进行中的转介绍线索必须推进（高权重，保证进池）；转介绍经营阶段客户可尝试自然转介绍
    const ref = refIdx[c.Id];
    if (ref) {
      score += 45;
      hits.push('转介绍线索推进中：' + (ref.referred_name ? '被介绍人「' + ref.referred_name + '」' : '被介绍人待记录') + '（' + ref.status + '）');
    } else if (c.customer_stage === '转介绍经营') {
      score += 10;
      hits.push('处于转介绍经营阶段，可尝试自然转介绍');
    }

    if (score > 0) {
      out.push({
        type: 'customer', id: c.Id, name: c.customer_name || '未知',
        stage: c.customer_stage || '未分层', score, hits,
        gender: c.gender || '',
        last_note: fol ? cut(fol.latest.followup_notes, 60) : '',
        last_date: lastFolDate || '',
        ref: ref ? { name: ref.referred_name || '', status: ref.status, next_action: cut(ref.next_action, 60) } : null,
      });
    }
  }
  out.sort((a, b) => b.score - a.score || a.id - b.id);
  const top = out.slice(0, POOL_CUSTOMER);
  // 进行中的转介绍线索强制入池（硬经营信号，不能漏）
  const inTop = new Set(top.map(x => x.id));
  for (const x of out) {
    if (top.length >= POOL_CUSTOMER) break;
    if (x.ref && !inTop.has(x.id)) { top.push(x); inTop.add(x.id); }
  }
  return top;
}

const FINAL_STAGE = '签约入司';

// ---------- 增员池规则引擎 ----------
function scoreRecruits(d, today) {
  const folIdx = {};
  for (const f of d.recruitFollowups) {
    const cid = f.candidate_id;
    if (!folIdx[cid]) folIdx[cid] = { latest: f, count: 0 };
    folIdx[cid].count++;
    const a = dayKeyOf(f.followup_date) || '', b = dayKeyOf(folIdx[cid].latest.followup_date) || '';
    if (a > b) folIdx[cid].latest = f;
  }
  const msIdx = {};
  for (const m of d.milestones) {
    const cid = m.candidate_id;
    if (!msIdx[cid] || (dayKeyOf(m.happened_at) || '') > (dayKeyOf(msIdx[cid].happened_at) || '')) msIdx[cid] = m;
  }

  const out = [];
  for (const r of d.candidates) {
    let score = 0; const hits = [];
    const fol = folIdx[r.id];
    const lastFolDate = fol ? (dayKeyOf(fol.latest.followup_date) || dayKeyOf(r.created_at)) : dayKeyOf(r.created_at);
    const nextDate = dayKeyOf(r.next_action_date);

    const sd = diffDays(dayKeyOf(r.stage_changed_at), today);
    if (sd !== null && sd >= -7 && sd <= 0) { score += 30; hits.push('进入新阶段「' + (r.stage || '') + '」'); }

    const nd = diffDays(nextDate, today);
    if (nd !== null && nd < 0) { score += 35; hits.push('下一步动作已逾期 ' + (-nd) + ' 天'); }
    else if (nd === 0) { score += 30; hits.push('今日待推进动作'); }

    if (fol) {
      const fd = diffDays(dayKeyOf(fol.latest.followup_date), today);
      if (fd !== null && fd >= -7 && fd <= 0) {
        score += 10; hits.push('近期有接触');
        const il = String(fol.latest.interest_level || '');
        if (il.indexOf('高') >= 0 || il.indexOf('明确') >= 0) { score += 5; hits.push('意向度明确'); }
      }
      const idle = lastFolDate ? -diffDays(lastFolDate, today) : null;
      if (idle !== null && idle >= 14 && r.stage !== FINAL_STAGE) { score += 25; hits.push('已 ' + idle + ' 天未推进'); }
    } else {
      const cd = diffDays(dayKeyOf(r.created_at), today);
      if (cd !== null && cd >= -7 && cd <= 0) { score += 15; hits.push('新晋候选人'); }
      else if (r.stage !== FINAL_STAGE) { score += 25; hits.push('从未跟进待破冰'); }
    }

    if (r.potential_score != null && r.potential_score >= 75) { score += 10; hits.push('AI 高潜评分 ' + r.potential_score); }

    if (score > 0) {
      out.push({
        type: 'recruit', id: r.id, name: '', stage: r.stage || '新增人才',
        score, hits, gender: '',
        last_note: fol ? cut(fol.latest.followup_notes, 60) : cut(r.next_action, 40),
        last_date: lastFolDate || '',
        next_date: nextDate || '',
        customer_id: r.customer_id,
      });
    }
  }
  // 候选人姓名来自客户表（rdb 无 join，按 customer_id 映射）
  const nameMap = {};
  for (const c of d.customers) nameMap[c.Id] = c;
  for (const r of out) {
    const cust = nameMap[r.customer_id];
    r.name = cust ? (cust.customer_name || '未知') : '未知';
    r.gender = cust ? (cust.gender || '') : '';
  }
  out.sort((a, b) => b.score - a.score || a.id - b.id);
  return out.slice(0, POOL_RECRUIT);
}

// ---------- 活动行动规则引擎（v1.7.6：Activity → Today） ----------
// 统一内部对象：{ type:'activity_action', source_type, source_id, action_type, title, priority, due_date, reason, score, hits, ...nav }
// source_type: activity_task（活动任务）| activity_followup（活动后跟进/AI复盘行动）| speaker_followup（嘉宾维护）| activity_review（活动复盘）
// action_type: complete_task | followup_customer | followup_recruit | contact_speaker | review_activity
// 规则排序（用户约定）：高优+已逾期 > 今天到期 > 活动后重要人员未跟进 > 嘉宾维护
// 纯只读；与客户/增员池共用 score/hits 协议，合并排序；最终列表活动行动上限 5 条，不抢占 Top 15
const AA_OPEN_TASK = ['pending', 'in_progress'];
const AA_POST_STATUS = ['ended', 'reviewed'];      // 活动结束后
// 筹备/进行中（idea 为筹备起点：任务已设定到期日即为承诺，纳入逾期/到期/高风险提醒）
const AA_PREP_STATUS = ['idea', 'preparing', 'confirmed', 'in_progress'];
const AA_MAX_FINAL = 5;                            // 最终列表中活动行动上限
const AA_POOL_MAX = 12;                            // 候选池活动行动上限

function scoreActivityActions(d, today, custPool, rcPool) {
  const out = [];
  const actMap = {};
  for (const a of (d.activities || [])) actMap[a.id] = a;
  const custMap = {};
  for (const c of (d.customers || [])) custMap[c.Id] = c;
  const candMap = {};
  for (const r of (d.candidates || [])) candMap[r.id] = r;

  // 已在客户/增员池中的人不重复生成活动跟进行动（同一人不重复上榜）
  const busyCustomer = new Set(custPool.map(x => x.id));
  const busyRecruit = new Set(rcPool.map(x => x.id));

  // 活动→参与者索引
  const partsByAct = {};
  for (const p of (d.participants || [])) {
    if (!p.activity_id) continue;
    (partsByAct[p.activity_id] = partsByAct[p.activity_id] || []).push(p);
  }
  // 活动+客户已有跟进记录索引（候选4/5：尚未跟进判定）
  const folActSet = new Set();
  for (const f of (d.followups || [])) {
    if (f.activity_id && f.customer_id) folActSet.add(f.activity_id + ':' + f.customer_id);
  }

  function push(a) { out.push(a); }

  // ---- 候选 1/2/3：活动任务（逾期 / 今天到期 / 筹备高风险） ----
  for (const t of (d.activityTasks || [])) {
    if (AA_OPEN_TASK.indexOf(t.status) < 0) continue;
    const act = actMap[t.activity_id];
    if (!act) continue;
    const isPost = AA_POST_STATUS.indexOf(act.status) >= 0;
    const isPrep = AA_PREP_STATUS.indexOf(act.status) >= 0;
    if (!isPost && !isPrep) continue; // 理论不可达（状态非已知枚举时跳过）
    // 已结束活动：筹备类任务已失效，仅跟进/复盘类保留
    if (isPost && ['preparation', 'invitation', 'speaker', 'onsite'].indexOf(t.task_type) >= 0) continue;

    const due = dayKeyOf(t.due_date);
    const dd = due ? diffDays(due, today) : null;
    const high = t.priority === 'high';
    const base = {
      type: 'activity_action', source_type: 'activity_task', source_id: t.id,
      action_type: 'complete_task', activity_id: act.id, activity_name: act.name || '活动',
      title: cut(t.task_title, 40) || '活动任务',
      hits: [],
    };
    if (dd !== null && dd < 0) {
      // 已逾期
      push(Object.assign(base, {
        score: high ? 60 : (t.priority === 'low' ? 44 : 50),
        priority: high ? 'high' : (t.priority === 'low' ? 'low' : 'medium'),
        due_date: due,
        reason: '《' + (act.name || '活动') + '》任务已逾期 ' + (-dd) + ' 天',
      }));
    } else if (dd === 0) {
      // 今天到期
      push(Object.assign(base, {
        score: high ? 52 : (t.priority === 'low' ? 40 : 46),
        priority: high ? 'high' : (t.priority === 'low' ? 'low' : 'medium'),
        due_date: due,
        reason: '《' + (act.name || '活动') + '》任务今天到期',
      }));
    } else if (isPrep && high && dd !== null && dd >= 1 && dd <= 2) {
      // 候选3：筹备高风险——高优任务 2 天内到期
      push(Object.assign(base, {
        score: 40, priority: 'high', due_date: due,
        reason: '《' + (act.name || '活动') + '》筹备关键任务 ' + dd + ' 天后到期',
      }));
    } else if (isPrep && high && dd === null) {
      // 候选3：高优任务无日期，且活动 5 天内举办
      const ad = dayKeyOf(act.activity_date);
      const adDiff = ad ? diffDays(ad, today) : null;
      if (adDiff !== null && adDiff >= 0 && adDiff <= 5) {
        push(Object.assign(base, {
          score: 38, priority: 'high', due_date: '',
          reason: '《' + (act.name || '活动') + '》' + adDiff + ' 天后举办，关键任务「' + cut(t.task_title, 20) + '」未定日期',
        }));
      }
    }
  }

  // ---- 候选 4/5：活动结束后重要客户/增员尚未跟进 ----
  for (const a of (d.activities || [])) {
    if (AA_POST_STATUS.indexOf(a.status) < 0) continue;
    const ad = dayKeyOf(a.activity_date);
    const age = ad ? -diffDays(ad, today) : null;
    if (age === null || age < 0 || age > 30) continue; // 活动结束后 30 天内才提醒
    const parts = partsByAct[a.id] || [];
    for (const p of parts) {
      if (p.status !== 'attended' || !p.person_id) continue;
      const explicitPending = p.followup_status === 'pending';
      if (p.followup_status === 'done' || p.followup_status === 'not_needed') continue;

      if (p.person_type === 'customer') {
        if (folActSet.has(a.id + ':' + p.person_id)) continue; // 已有活动跟进记录
        if (busyCustomer.has(p.person_id)) continue;           // 已在客户池
        const c = custMap[p.person_id];
        if (!c) continue;
        const isA = c.sales_priority === 'A';
        const isB = c.sales_priority === 'B';
        if (!explicitPending && !isA && !isB) continue;        // 重要客户才提醒
        const name = c.customer_name || p.person_name || ('客户#' + p.person_id);
        push({
          type: 'activity_action', source_type: 'activity_followup', source_id: p.id,
          action_type: 'followup_customer', activity_id: a.id, activity_name: a.name || '活动',
          person_type: 'customer', person_id: p.person_id, person_name: name,
          title: '跟进客户「' + name + '」',
          score: explicitPending ? 46 : (isA ? 42 : 36),
          priority: explicitPending || isA ? 'high' : 'medium',
          due_date: today,
          reason: '参加了《' + (a.name || '活动') + '」（' + (age === 0 ? '今天' : age + ' 天前') + '）' +
            (explicitPending ? '，标记为待跟进' : (isA ? '，A 类重点客户' : '，B 类客户')) + '，活动后尚未跟进',
          hits: ['活动后未跟进'],
        });
      } else if (p.person_type === 'recruit') {
        if (busyRecruit.has(p.person_id)) continue;
        const r = candMap[p.person_id];
        if (!r || r.stage === FINAL_STAGE) continue;
        const highPot = r.potential_score != null && r.potential_score >= 75;
        if (!explicitPending && !highPot) continue;
        const c = r.customer_id ? custMap[r.customer_id] : null;
        const name = r.name || (c ? c.customer_name : '') || p.person_name || ('候选人#' + p.person_id);
        push({
          type: 'activity_action', source_type: 'activity_followup', source_id: p.id,
          action_type: 'followup_recruit', activity_id: a.id, activity_name: a.name || '活动',
          person_type: 'recruit', person_id: p.person_id, person_name: name,
          title: '跟进增员对象「' + name + '」',
          score: explicitPending ? 44 : 38,
          priority: explicitPending ? 'high' : 'medium',
          due_date: today,
          reason: '参加了《' + (a.name || '活动') + '」（' + (age === 0 ? '今天' : age + ' 天前') + '）' +
            (explicitPending ? '，标记为待跟进' : '，高潜候选人') + '，活动后尚未跟进',
          hits: ['活动后未跟进'],
        });
      }
    }

    // 活动已结束但未复盘 → 提醒完成 AI 复盘（候选7 配套，驱动 v1.7.5 复盘闭环）
    if (a.status === 'ended' && age <= 14) {
      push({
        type: 'activity_action', source_type: 'activity_review', source_id: a.id,
        action_type: 'review_activity', activity_id: a.id, activity_name: a.name || '活动',
        title: '完成活动《' + (a.name || '活动') + '》AI 复盘',
        score: 34, priority: 'medium', due_date: today,
        reason: '活动已结束 ' + (age === 0 ? '今天' : age + ' 天') + '，尚未做 AI 复盘（发现客户/增员/嘉宾/主题/机会）',
        hits: ['活动待复盘'],
      });
    }
  }

  // ---- 候选7：AI复盘/活动约定的跟进已到期（followups.activity_id 链路） ----
  for (const f of (d.followups || [])) {
    if (!f.activity_id || !f.customer_id) continue;
    const nd = dayKeyOf(f.next_followup_date);
    if (!nd) continue;
    const dd = diffDays(nd, today);
    if (dd === null || dd > 0) continue; // 已逾期或今天到期
    if (busyCustomer.has(f.customer_id)) continue;
    const c = custMap[f.customer_id];
    if (!c) continue;
    const act = actMap[f.activity_id];
    const name = c.customer_name || ('客户#' + f.customer_id);
    push({
      type: 'activity_action', source_type: 'activity_followup', source_id: f.Id,
      action_type: 'followup_customer', activity_id: f.activity_id,
      activity_name: act ? (act.name || '活动') : '活动',
      person_type: 'customer', person_id: f.customer_id, person_name: name,
      title: '执行活动跟进「' + name + '」',
      score: dd < 0 ? 40 : 36,
      priority: dd < 0 ? 'high' : 'medium',
      due_date: nd,
      reason: (f.recommendation_id ? 'AI 复盘建议的跟进' : '活动约定的跟进') +
        (dd < 0 ? '已逾期 ' + (-dd) + ' 天' : '今天到期') +
        (f.followup_notes ? '：' + cut(f.followup_notes.replace(/^\[AI复盘\]\s*/, ''), 40) : ''),
      hits: [f.recommendation_id ? 'AI复盘行动到期' : '活动跟进到期'],
    });
  }

  // ---- 候选6：嘉宾到了下一次联系时间 ----
  for (const s of (d.speakers || [])) {
    if (s.status && s.status !== 'active') continue;
    const nd = dayKeyOf(s.next_contact_date);
    if (!nd) continue;
    const dd = diffDays(nd, today);
    if (dd === null || dd > 0) continue;
    push({
      type: 'activity_action', source_type: 'speaker_followup', source_id: s.id,
      action_type: 'contact_speaker', speaker_id: s.id,
      title: '联系嘉宾「' + (s.name || '嘉宾#' + s.id) + '」',
      score: dd < 0 ? 30 : 26,
      priority: 'medium',
      due_date: nd,
      reason: '嘉宾「' + (s.name || '') + '」' + (dd < 0 ? '约定联系时间已过 ' + (-dd) + ' 天' : '今天到约定联系时间') +
        (s.organization ? '（' + s.organization + '）' : ''),
      hits: ['嘉宾维护到期'],
    });
  }

  out.sort((a, b) => b.score - a.score || (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1);
  // 同一客户/增员跨活动只保留分数最高的一条跟进行动（已按分数降序，首见即最高）
  const seenPerson = new Set();
  const dedup = [];
  for (const a of out) {
    if (a.action_type === 'followup_customer' || a.action_type === 'followup_recruit') {
      const k = a.action_type + ':' + a.person_id;
      if (seenPerson.has(k)) continue;
      seenPerson.add(k);
    }
    dedup.push(a);
  }
  return dedup.slice(0, AA_POOL_MAX);
}

// 活动行动 → 今日列表项（规则版字段；priority high/medium/low → 高/中/低）
function actionToItem(a) {
  const prioMap = { high: '高', medium: '中', low: '低' };
  const verb = {
    complete_task: '打开活动详情完成该任务',
    followup_customer: '今天联系该客户，跟进后记录跟进并更新下次跟进日期',
    followup_recruit: '今天联系该增员对象，推进到下一阶段',
    contact_speaker: '按约定时间联系嘉宾，维护合作关系',
    review_activity: '打开活动详情，点击「AI 活动复盘」生成复盘建议',
  };
  return {
    type: 'activity_action',
    source_type: a.source_type, source_id: a.source_id, action_type: a.action_type,
    id: a.source_id,
    activity_id: a.activity_id || null,
    person_type: a.person_type || '', person_id: a.person_id || null,
    speaker_id: a.speaker_id || null,
    name: a.title, stage: '', priority: prioMap[a.priority] || '中',
    assessment: a.reason,
    goal: '', next_action: verb[a.action_type] || '查看详情',
    topic: '', avoid: '', success_criteria: '',
    next_followup_date: a.due_date || '',
  };
}

// ---------- 规则版最终列表（AI 降级兜底；字段同 NBA 结构，不编造客户信息） ----------
function ruleItems(custPool, rcPool, nbaIdx, actionPool) {
  function prio(score) { return score >= 45 ? '高' : (score >= 25 ? '中' : '低'); }
  function actC(x) {
    const nd = x.hits.join();
    if (nd.indexOf('逾期') >= 0) return '今天先电话或微信补一次跟进，重新约定下次跟进日期';
    if (nd.indexOf('今日待跟进') >= 0) return '按原计划完成今日跟进，跟进后更新客户阶段';
    if (nd.indexOf('未联系') >= 0) return '用问候+价值信息破冰，避免长期沉默流失';
    if (nd.indexOf('新客户') >= 0) return '完成首访，建档并约定下次联系时间';
    return '跟进一次并更新下次跟进计划';
  }
  function actR(x) {
    const h = x.hits.join();
    if (h.indexOf('逾期') >= 0 || h.indexOf('今日待推进') >= 0) return '按既定动作推进（约面谈/邀活动），同步更新阶段';
    if (h.indexOf('新阶段') >= 0) return '趁阶段刚变化趁热打铁，落实该阶段的下一步';
    if (h.indexOf('未推进') >= 0 || h.indexOf('破冰') >= 0) return '重新激活：分享一条与对方相关的机会信息';
    return '保持接触节奏，推进到下一增员阶段';
  }
  // 判断 = 真实规则信号；目标/不建议/成功标准 = 按阶段给的可执行默认值（规则，非编造）
  function goalC(x) {
    const st = x.stage || '';
    if (st.indexOf('需求') >= 0) return '进一步确认需求';
    if (st.indexOf('方案') >= 0) return '推进方案确认';
    if (st.indexOf('成交') >= 0) return '推进签单';
    if (st.indexOf('转介绍') >= 0) return '获取转介绍';
    if (st.indexOf('新认识') >= 0) return '建立信任并获取基本信息';
    return '保持联系温度，推进当前阶段经营';
  }
  function goalR(x) {
    const m = {
      '新增人才': '完成破冰并评估意向',
      '互动暖客': '保持互动并观察动机',
      '初次面谈': '完成初次面谈并明确顾虑',
      '增员活动': '邀约参加增员活动',
      '精准面谈': '推进精准面谈并给出发展路径',
      '入职申请': '协助完成入职申请',
      '签约入司': '完成签约并规划起步',
    };
    return m[x.stage] || '推进当前增员阶段';
  }
  const avoidC = '需求未确认前，不要直接发送产品方案';
  const avoidR = '不要急于推进签约，先建立信任与机会共识';
  const critC = '完成一次有效跟进：客户有回应并更新下次跟进日期';
  const critR = '候选人同意下一步具体安排（时间/活动/面谈）';
  const personItems = custPool.concat(rcPool).sort((a, b) => b.score - a.score).map(x => {
    const fresh = x.type === 'customer' ? nbaIdx[x.id] : null;
    // v1.4 转介绍线索：规则版直接给出推进动作，覆盖通用客户话术
    const ref = x.ref || null;
    const refGoal = '推进转介绍线索';
    const refAction = ref
      ? '跟进转介绍线索「' + (ref.name || '被介绍人') + '」（当前' + ref.status + '）：' +
        (ref.next_action ? ref.next_action : '联系来源客户了解近况并推进到下一步')
      : '';
    if (fresh) {
      return Object.assign({
        type: x.type, id: x.id, name: x.name, stage: x.stage, priority: prio(x.score),
        assessment: cut(fresh.assessment, 80), goal: cut(fresh.goal, 40),
        next_action: cut(fresh.next_action, 60), topic: cut(fresh.topic, 16),
        avoid: cut(fresh.avoid, 60), success_criteria: cut(fresh.success_criteria, 40),
        next_followup_date: x.next_date || '', nba_from: 'detail', ref: ref,
      }, { _score: x.score });
    }
    return Object.assign({
      type: x.type, id: x.id, name: x.name, stage: x.stage, priority: prio(x.score),
      assessment: x.hits.join('；') || '有跟进价值',
      goal: ref ? refGoal : (x.type === 'customer' ? goalC(x) : goalR(x)),
      next_action: ref ? cut(refAction, 60) : (x.type === 'customer' ? actC(x) : actR(x)),
      topic: ref ? '转介绍' : (x.last_note ? cut(x.last_note, 16) : (x.type === 'customer' ? x.stage : '近况交流')),
      avoid: x.type === 'customer' ? avoidC : avoidR,
      success_criteria: ref ? '线索状态向前推进一步（已介绍/已联系/已建立关系）' : (x.type === 'customer' ? critC : critR),
      next_followup_date: x.next_date || '',
      ref: ref,
    }, { _score: x.score });
  });
  // v1.7.6：活动行动并入规则版候选（分数交错排序，活动行动最终上限 AA_MAX_FINAL 条，不抢占 Top 15）
  const actionItems = (actionPool || []).map(a => Object.assign(actionToItem(a), { _score: a.score }));
  const merged = personItems.concat(actionItems).sort((a, b) => b._score - a._score);
  const out = [];
  let actionCount = 0;
  for (const it of merged) {
    if (out.length >= FINAL_COUNT) break;
    if (it.type === 'activity_action') {
      if (actionCount >= AA_MAX_FINAL) continue;
      actionCount++;
    }
    delete it._score;
    out.push(it);
  }
  return out;
}

// ---------- AI 排序 + NBA 生成 ----------
// v1.7.6：候选池含人员（customer/recruit）与活动行动（activity_action）；活动行动用 动作#序号 标识
function buildMessages(pools, nbaIdx, actionPool) {
  const lines = [];
  pools.forEach((x, i) => {
    const fresh = x.type === 'customer' ? nbaIdx[x.id] : null;
    lines.push((i + 1) + '. type=' + x.type + ' id=' + x.id + ' 姓名=' + x.name +
      ' 阶段=' + x.stage + ' 信号=' + (x.hits.join('、') || '无') +
      ' 最近跟进摘要=' + (x.last_note || '无') +
      (x.ref ? ' 转介绍线索=被介绍人「' + (x.ref.name || '待记录') + '」状态' + x.ref.status +
        '（goal/next_action 应围绕推进该转介绍线索，话术体现自然请介绍人牵线）' : '') +
      (fresh ? ' 已有下一步行动方案(内容必须原样采用)=' + JSON.stringify(fresh) : ''));
  });
  const actLines = [];
  (actionPool || []).forEach((a, i) => {
    actLines.push('动作' + (i + 1) + '. 行动=' + a.title +
      ' 类型=' + ({ activity_task: '活动任务', activity_followup: '活动跟进', speaker_followup: '嘉宾维护', activity_review: '活动复盘' }[a.source_type] || a.source_type) +
      ' 优先级=' + ({ high: '高', medium: '中', low: '低' }[a.priority] || '中') +
      ' 到期=' + (a.due_date || '无') +
      ' 原因=' + a.reason);
  });
  const system = [
    '你是保险从业者 Victor 的每日经营助手。输入是按规则筛出的今天值得做的事：',
    '（A）值得联系的人：客户 type=customer 与增员候选人 type=recruit；',
    '（B）活动行动 type=activity_action：活动任务到期/逾期、活动后重要人员未跟进、嘉宾到联系时间、活动待复盘。',
    '任务：综合紧迫度、经营价值、阶段节奏，选出今天最值得做的最多 ' + FINAL_COUNT + ' 项，按建议先后排序；为人员条目给出 Next Best Action（下一最佳行动）。',
    '注意：增员候选人也是客户（先有关系后有增员），人员与活动行动可交错排序；逾期/今天到期的硬时间信号排前面。',
    '活动行动条目：type 填 "activity_action"，id 填"动作"后的序号数字；assessment 直接用行动原因，priority 按紧迫度判断；goal/next_action/topic/avoid/success_criteria 可填空字符串。',
    '活动行动不要超过 ' + AA_MAX_FINAL + ' 条，避免挤占客户/增员经营时间。',
    '客户条目若带"已有下一步行动方案"：其 assessment/goal/next_action/topic/avoid/success_criteria 六个字段必须原样采用该方案内容，不要改写（排序优先级仍由你判断）。',
    '其余人员条目由你生成：客户用客户经营语言（结合其阶段与信号），增员候选人用增员经营语言（阶段推进/机会吸引，结合增员五步法）。',
    '【信息不足规则】资料不足以判断的字段必须填"信息不足"，严禁编造客户的家庭/收入/需求/意向等信息；严禁编造候选之外的人员或行动。',
    '只输出 JSON，不要解释。输出格式：',
    '{"items":[{"type":"customer|recruit|activity_action","id":数字,"priority":"高|中|低","assessment":"当前经营判断/行动原因，不超过60字","goal":"经营目标，不超过30字","next_action":"下一最佳行动，1句具体可执行，不超过40字","topic":"推荐沟通主题，不超过12字","avoid":"不建议做什么，不超过40字","success_criteria":"成功标准，不超过30字"}]}',
    '所有字段必须简洁、具体、可执行，不要空话；不要输出日期（日期由系统按现有数据填写）。',
  ].join('\n');
  const user = '今日候选（已按规则分数初排）：\n【人员】\n' + lines.join('\n') +
    (actLines.length ? '\n【活动行动】\n' + actLines.join('\n') : '');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function mergeAiResult(parsed, pools, nbaIdx, actionPool) {
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
  if (!items || !items.length) return null;
  const key = {}; pools.forEach(x => { key[x.type + '#' + x.id] = x; });
  const out = [];
  for (const it of items) {
    if (out.length >= FINAL_COUNT) break;
    if (it.type === 'activity_action') {
      // 活动行动：id 是动作序号（1 起），只允许引用候选内行动，防幻觉
      const seq = parseInt(it.id, 10);
      const base = (actionPool || [])[seq - 1];
      if (!base) continue;
      const item = actionToItem(base);
      item.priority = ['高', '中', '低'].indexOf(it.priority) >= 0 ? it.priority : item.priority;
      out.push(item);
      continue;
    }
    const base = key[it.type + '#' + it.id];
    if (!base) continue; // 只允许引用候选池内的人，防幻觉
    const fresh = base.type === 'customer' ? nbaIdx[base.id] : null;
    if (fresh) {
      // 有新鲜 NBA 的客户：直接引用详情页方案（仅优先级/排序由 AI 决定）
      out.push({
        type: base.type, id: base.id, name: base.name, stage: base.stage,
        priority: ['高', '中', '低'].indexOf(it.priority) >= 0 ? it.priority : '中',
        assessment: cut(fresh.assessment, 80), goal: cut(fresh.goal, 40),
        next_action: cut(fresh.next_action, 60), topic: cut(fresh.topic, 16),
        avoid: cut(fresh.avoid, 60), success_criteria: cut(fresh.success_criteria, 40),
        next_followup_date: base.next_date || '', nba_from: 'detail', ref: base.ref || null,
      });
      continue;
    }
    out.push({
      type: base.type, id: base.id, name: base.name, stage: base.stage,
      priority: ['高', '中', '低'].indexOf(it.priority) >= 0 ? it.priority : '中',
      assessment: cut(it.assessment, 80),
      goal: cut(it.goal, 40),
      next_action: cut(it.next_action, 60),
      topic: cut(it.topic, 16),
      avoid: cut(it.avoid, 60),
      success_criteria: cut(it.success_criteria, 40),
      next_followup_date: base.next_date || '',
      ref: base.ref || null,
    });
  }
  return out.length ? out : null;
}

// v1.7.6 兜底：硬时间信号的活动行动（高优逾期/今天到期，score>=52）AI 漏排时补上；活动行动总数封顶 AA_MAX_FINAL
function ensureActionItems(items, actionPool) {
  const have = new Set(items.filter(x => x.type === 'activity_action')
    .map(x => x.source_type + '#' + x.source_id));
  let actionCount = items.filter(x => x.type === 'activity_action').length;
  for (const a of (actionPool || [])) {
    if (a.score < 52) break; // actionPool 已按 score 降序
    if (actionCount >= AA_MAX_FINAL) break;
    if (items.length >= FINAL_COUNT + 2) break;
    if (have.has(a.source_type + '#' + a.source_id)) continue;
    items.push(actionToItem(a));
    have.add(a.source_type + '#' + a.source_id);
    actionCount++;
  }
  return items;
}

// 最终裁剪：活动行动严格不超过 AA_MAX_FINAL（不抢占 Top 15）；总数沿用 v1.4 语义
// （转介绍兜底条目可溢出至 FINAL_COUNT+3），ensureRefItems 先于 ensureActionItems 追加，尾切时优先砍活动行动
function capItems(items) {
  const out = [];
  let actionCount = 0;
  for (const it of items) {
    if (it.type === 'activity_action') {
      if (actionCount >= AA_MAX_FINAL) continue;
      actionCount++;
    }
    out.push(it);
    if (out.length >= FINAL_COUNT + 3) break;
  }
  return out;
}

// v1.4 兜底：进行中的转介绍线索必须出现在今日经营列表（AI 只负责排序，ref 是硬经营信号）
function ensureRefItems(items, custPool, nbaIdx) {
  const have = new Set(items.filter(x => x.type === 'customer').map(x => x.id));
  for (const base of custPool) {
    if (!base.ref || have.has(base.id)) continue;
    if (items.length >= FINAL_COUNT + 3) break;
    const ref = base.ref;
    const fresh = nbaIdx[base.id];
    if (fresh) {
      items.push({
        type: 'customer', id: base.id, name: base.name, stage: base.stage, priority: '高',
        assessment: cut(fresh.assessment, 80), goal: cut(fresh.goal, 40),
        next_action: cut(fresh.next_action, 60), topic: cut(fresh.topic, 16),
        avoid: cut(fresh.avoid, 60), success_criteria: cut(fresh.success_criteria, 40),
        next_followup_date: base.next_date || '', nba_from: 'detail', ref: ref,
      });
    } else {
      items.push({
        type: 'customer', id: base.id, name: base.name, stage: base.stage, priority: '高',
        assessment: base.hits.join('；') || '有进行中的转介绍线索',
        goal: '推进转介绍线索',
        next_action: cut('跟进转介绍线索「' + (ref.name || '被介绍人') + '」（当前' + ref.status + '）：' +
          (ref.next_action || '联系来源客户了解近况并推进到下一步'), 60),
        topic: '转介绍',
        avoid: '不要绕过来源客户直接接触被介绍人',
        success_criteria: '线索状态向前推进一步（已介绍/已联系/已建立关系）',
        next_followup_date: base.next_date || '',
        ref: ref,
      });
    }
    have.add(base.id);
  }
  return items;
}

// ==================== v1.8 Sprint 3：Today 5（基于 v_action_center） ====================
// 事实（overdue/today/upcoming/unscheduled、days_until、stage、last_followup_date）全部由
// v_action_center 视图 SQL 计算，AI 不参与基础事实；AI 只负责从候选中选出今天最值得做的
// 5 件（Must Do×2 / Recommended×2 / Optional×1）并生成行动/原因/渠道/目标/话术/confidence/evidence。
// 严禁虚构事实；资料不足必须降低 confidence（防 AI 虚高在 normTodayFive 中再强制兜底）。
const T5_MUST = 2, T5_REC = 2, T5_OPT = 1, T5_TOTAL = 5, T5_SHORTLIST = 18;

// 视图行 → 候选列表（含 Urgency/Impact/Relationship/Opportunity/Timing/Actionability 6 维规则分，
// 分数仅用于 AI 短名单初排与规则兜底，不作为事实输出）
function buildActionCandidates(d, nbaIdx, today) {
  const folIdx = indexFollowups(d.followups || []);
  const custMap = {};
  (d.customers || []).forEach(c => { custMap[c.Id] = c; });
  const rfLatest = {};
  for (const f of (d.recruitFollowups || [])) {
    const a = dayKeyOf(f.followup_date) || '';
    const cur = rfLatest[f.candidate_id];
    if (!cur || a > (dayKeyOf(cur.followup_date) || '')) rfLatest[f.candidate_id] = f;
  }
  const list = [];
  for (const r of (d.actions || [])) {
    const personType = r.person_type || '';              // customer / recruit / activity
    const actionDate = dayKeyOf(r.action_date);
    const status = r.status || 'unscheduled';            // SQL 已计算
    const days = (typeof r.days_until === 'number')
      ? r.days_until : (actionDate ? diffDays(actionDate, today) : null);
    const stage = r.stage || '';
    const nextAction = (r.next_action || '').trim();
    const lastFol = dayKeyOf(r.last_followup_date) || '';

    // 优先级归一：客户 A-E / 任务 high-medium-low（视图 followups 分支 priority 为 NULL，用 customers 补）
    let prioRank = 8, prioLabel = '中';
    const p = String(r.priority || '').trim();
    if (p === 'A' || p === 'high') { prioRank = 22; prioLabel = '高'; }
    else if (p === 'B' || p === 'medium') { prioRank = 16; prioLabel = '中'; }
    else if (p === 'C') { prioRank = 10; prioLabel = '中'; }
    else if (p === 'D' || p === 'E' || p === 'low') { prioRank = 5; prioLabel = '低'; }

    let note = '', nba = null;
    if (personType === 'customer') {
      const c = custMap[r.person_id];
      if (c && !p) {
        if (c.sales_priority === 'A') { prioRank = 22; prioLabel = '高'; }
        else if (c.sales_priority === 'B') { prioRank = 16; prioLabel = '中'; }
        else if (c.sales_priority === 'C') { prioRank = 10; }
        else if (c.sales_priority === 'D' || c.sales_priority === 'E') { prioRank = 5; prioLabel = '低'; }
      }
      const fol = folIdx[r.person_id];
      if (fol) note = cut(fol.latest.followup_notes || '', 60);
      nba = nbaIdx[r.person_id] || null;
    } else if (personType === 'recruit') {
      const rf = rfLatest[r.person_id];
      if (rf) note = cut(rf.followup_notes || '', 60);
    }

    // ---- 6 维规则分 ----
    let urgency, impact, relation, opp, timing;
    const overdueDays = (status === 'overdue' && days !== null) ? -days : 0;
    if (status === 'overdue') { urgency = 42 + (overdueDays <= 7 ? 6 : overdueDays <= 30 ? 3 : 0); timing = 10; }
    else if (status === 'today') { urgency = 40; timing = 10; }
    else if (status === 'upcoming') {
      urgency = days !== null && days <= 2 ? 26 : days !== null && days <= 7 ? 18 : 8;
      timing = days !== null && days <= 3 ? 10 : days !== null && days <= 7 ? 6 : 2;
    } else { urgency = 4; timing = 0; }
    impact = prioRank;
    if (/(成交|签约|方案)/.test(stage)) impact += 12;
    else if (/转介绍/.test(stage)) impact += 9;
    else if (/需求/.test(stage)) impact += 7;
    else if (/精准面谈|入职申请/.test(stage)) impact += 12;
    else if (/初次面谈|增员活动/.test(stage)) impact += 8;
    if (lastFol) { const age = -diffDays(lastFol, today); relation = age <= 14 ? 8 : age <= 45 ? 5 : 2; }
    else relation = personType === 'activity' ? 6 : 2;
    if (r.action_type === 'opportunity') opp = 14;
    else if (r.action_type === 'recruit') opp = 10;
    else if (r.action_type === 'recruit_followup') opp = 8;
    else if (r.action_type === 'followup' && /转介绍/.test(stage)) opp = 8;
    else opp = 0;
    const actionability = (nextAction ? 8 : 0) + (actionDate ? 4 : 0);
    const score = urgency + impact + relation + opp + timing + actionability;

    list.push({
      action_id: r.action_id, action_type: r.action_type, person_type: personType,
      person_id: r.person_id, person_name: r.person_name || '', title: r.title || '',
      source: r.source || '', status, stage, prio_label: prioLabel,
      action_date: actionDate || '', days_until: days, last_followup: lastFol,
      next_action: nextAction, note, nba, score,
    });
  }
  list.sort((a, b) => b.score - a.score ||
    String(a.action_date || '').localeCompare(String(b.action_date || '')));
  return list;
}

function t5FactLine(x, i) {
  const stLabel = x.status === 'overdue' ? ('逾期' + (-x.days_until) + '天')
    : x.status === 'today' ? '今天到期'
    : x.status === 'upcoming' ? (x.days_until + '天后到期') : '未排期';
  const typeLabel = ({ customer: '客户', recruit: '增员', activity: '活动' })[x.person_type] || x.person_type;
  const actLabel = ({
    customer: '客户行动', followup: '跟进', opportunity: '经营机会',
    recruit: '增员推进', recruit_followup: '增员跟进', activity_task: '活动任务',
  })[x.action_type] || x.action_type;
  return (i + 1) + '. [' + typeLabel + '] ' + x.person_name +
    '｜事项=' + (x.title || x.next_action || actLabel) +
    '｜行动类型=' + actLabel +
    '｜状态=' + stLabel +
    (x.action_date ? '｜行动日期=' + x.action_date : '') +
    '｜优先级=' + x.prio_label +
    (x.stage ? '｜阶段=' + x.stage : '') +
    (x.last_followup ? '｜最近跟进=' + x.last_followup : '｜最近跟进=无记录') +
    (x.next_action ? '｜已记录下一步=' + cut(x.next_action, 50) : '｜已记录下一步=无') +
    (x.note ? '｜最近跟进摘要=' + x.note : '') +
    (x.nba ? '｜已有行动方案=' + JSON.stringify({
      assessment: cut(x.nba.assessment || '', 60),
      goal: cut(x.nba.goal || '', 30),
      next_action: cut(x.nba.next_action || '', 40),
    }) : '');
}

function buildTodayFiveMessages(shortlist, today) {
  const system = [
    '你是保险从业者 Victor 的今日经营教练。输入是系统从统一行动视图 v_action_center 按规则初筛的候选行动。',
    '视图中的事实（状态 overdue/today/upcoming/unscheduled、逾期天数、行动日期、阶段、优先级、最近跟进日期）全部由 SQL 计算，是确定事实，你不要质疑或重新计算。',
    '任务：综合六个维度，从候选中选出 Victor 今天最值得做的 5 件事：',
    '- Must Do（必做）2 件：硬时间（逾期/今天到期）且经营价值高的；',
    '- Recommended（推荐）2 件：近期到期且关系/机会价值明确的；',
    '- Optional（可选）1 件：值得做但时间弹性大的（如未排期但已有明确下一步）。',
    '六个维度：Urgency 紧迫度（逾期/到期硬信号）、Impact 经营价值（客户优先级/阶段价值）、Relationship 关系温度（最近联系）、Opportunity 机会（转介绍/增员/经营机会）、Timing 时间窗口、Actionability 可执行性（是否已有明确下一步和日期）。',
    '排序不能只看日期：需综合判断（例：刚互动过、阶段关键的今天到期客户，可优先于逾期很久但关系已冷的线索），但必须在 evidence 中写清依据。',
    '【严禁虚构】只能使用输入中给出的事实：不得编造客户需求、家庭情况、购买意愿、联系记录、成功率、ROI；没有记录的信息在话术里用通用、不预设事实的表达（如"之前聊的事""约个时间同步"），不得杜撰细节。',
    '【confidence 规则】证据充分（有明确下一步+近期跟进摘要+阶段清晰）给 high；有行动日期和阶段但缺跟进摘要给 medium；关键信息缺失（无下一步、无跟进记录、未排期）给 low。证据不足时严禁给 high。',
    'suggested_date：逾期/今天到期填 ' + today + '；未来到期填候选给出的行动日期；未排期填空字符串。严禁编造日期。',
    'channel：从 微信/电话/面谈/活动 中选（逾期较久或重要客户宜电话；日常跟进宜微信；增员面谈阶段宜面谈；活动任务填"活动"）。',
    'action：今天要做的具体动作（如"电话联系王总，确认十月面谈时间"），不超过30字。',
    'reason：为什么今天值得做，不超过70字。goal：本次行动目标，不超过30字。',
    'script：一句自然、符合关系阶段的开场白/话术，口语化，不超过80字，不得包含未经证实的客户信息。',
    'evidence：2-4条判断依据，每条必须引用候选中的真实事实（事项名/日期/状态/阶段/跟进记录），不得写候选之外的信息。',
    '候选不足5件时按实际数量返回，不要凑数。只输出 JSON，不要解释：',
    '{"picks":[{"ref":候选序号数字,"tier":"must_do|recommended|optional","action":"...","reason":"...","channel":"微信|电话|面谈|活动","goal":"...","suggested_date":"YYYY-MM-DD或空字符串","script":"...","confidence":"high|medium|low","evidence":["..."]}]}',
  ].join('\n');
  const user = '今天是 ' + today + '。候选行动（按规则综合分初排）：\n' +
    shortlist.map(t5FactLine).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---- 规则兜底字段（AI 失败/字段缺失时使用；全部来自视图事实，不编造客户信息） ----
function t5FallbackAction(x) {
  if (x.action_type === 'activity_task') return cut(x.title || '完成活动任务', 30);
  return cut('联系' + x.person_name + (x.next_action ? '：' + x.next_action : '，跟进当前进展'), 30);
}
function t5FallbackReason(x) {
  const parts = [];
  if (x.status === 'overdue') parts.push('行动已逾期' + (-x.days_until) + '天');
  else if (x.status === 'today') parts.push('今天到期');
  else if (x.status === 'upcoming') parts.push(x.days_until + '天后到期');
  if (x.stage) parts.push('当前阶段：' + x.stage);
  if (x.prio_label === '高') parts.push('高优先级');
  return cut(parts.join('；') || '有跟进价值', 70);
}
function t5FallbackChannel(x) {
  if (x.action_type === 'activity_task') return '活动';
  if (x.status === 'overdue') return '电话';
  if (/面谈/.test(x.stage || '')) return '面谈';
  return '微信';
}
function t5FallbackEvidence(x) {
  const ev = [];
  const stTxt = x.status === 'overdue' ? '逾期' + (-x.days_until) + '天（行动日期 ' + x.action_date + '）'
    : x.status === 'today' ? '今天到期（' + x.action_date + '）'
    : x.status === 'upcoming' ? x.days_until + '天后到期（' + x.action_date + '）' : '未排期';
  ev.push('状态：' + stTxt);
  if (x.stage) ev.push('阶段：' + x.stage);
  ev.push('最近跟进：' + (x.last_followup || '无记录'));
  if (x.next_action) ev.push('已记录下一步：' + cut(x.next_action, 50));
  return ev.slice(0, 4);
}
function t5FallbackScript(x) {
  const name = x.person_name || '';
  if (x.action_type === 'activity_task') {
    return cut('提醒：活动「' + x.person_name + '」有任务待完成——' + (x.title || '查看任务清单') + '，今天先处理。', 80);
  }
  if (x.person_type === 'recruit') {
    return cut(name + '你好，我是 Victor。最近有不错的发展机会，想约你聊聊近况，看看有没有适合你的方向，你看哪天方便？', 80);
  }
  if (x.status === 'overdue') {
    return cut(name + '您好，我是 Victor。之前跟您聊的事一直惦记着，您看这两天什么时候方便，我跟您同步一下进展？', 80);
  }
  return cut(name + '您好，我是 Victor。最近好吗？想约个时间跟您聊聊，您看这周哪天方便？', 80);
}
function t5RulePick(x, tier, today) {
  return {
    tier,
    action_id: x.action_id, action_type: x.action_type, person_type: x.person_type,
    person_id: x.person_id, person_name: x.person_name, title: x.title, source: x.source,
    status: x.status, stage: x.stage, days_until: x.days_until, action_date: x.action_date,
    action: t5FallbackAction(x), reason: t5FallbackReason(x), priority: x.prio_label,
    channel: t5FallbackChannel(x),
    goal: x.next_action ? cut(x.next_action, 30) : '推进当前阶段',
    suggested_date: (x.status === 'overdue' || x.status === 'today') ? today : (x.action_date || ''),
    script: t5FallbackScript(x),
    // 规则兜底无 AI 判断：信息全给 medium，关键信息缺失给 low，不给 high
    // （活动任务无 next_action 字段，title 即行动内容，视为可执行）
    confidence: ((x.next_action || x.action_type === 'activity_task') && x.status !== 'unscheduled') ? 'medium' : 'low',
    evidence: t5FallbackEvidence(x),
  };
}

// AI 输出 → 校验 + 配额修正（must2/rec2/opt1；防幻觉：只允许引用候选；confidence 强制兜底）
function normTodayFive(parsed, shortlist, today) {
  const picks = parsed && Array.isArray(parsed.picks) ? parsed.picks : null;
  if (!picks || !picks.length) return null;
  const used = new Set();
  const tiers = { must_do: [], recommended: [], optional: [] };
  for (const p of picks) {
    const ref = parseInt(p.ref, 10);
    const x = shortlist[ref - 1];
    if (!x || used.has(x.action_id) || !tiers[p.tier]) continue;  // 只允许引用候选内行动
    used.add(x.action_id);
    let conf = ['high', 'medium', 'low'].indexOf(p.confidence) >= 0 ? p.confidence : 'low';
    // 资料不足强制降级（防 AI 虚高）；活动任务 title 即行动内容，视为可执行
    const actionable = x.next_action || (x.action_type === 'activity_task' && x.title);
    if (!actionable && !x.note) conf = 'low';
    else if (!actionable && conf === 'high') conf = 'medium';
    let sd = '';
    if (x.status === 'overdue' || x.status === 'today') sd = today;
    else if (x.status === 'upcoming') sd = x.action_date;
    const aiDate = String(p.suggested_date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(aiDate) && (aiDate === today || aiDate === x.action_date)) sd = aiDate;
    const ev = Array.isArray(p.evidence)
      ? p.evidence.map(e => cut(e, 80)).filter(Boolean).slice(0, 4) : [];
    tiers[p.tier].push({
      tier: p.tier,
      action_id: x.action_id, action_type: x.action_type, person_type: x.person_type,
      person_id: x.person_id, person_name: x.person_name, title: x.title, source: x.source,
      status: x.status, stage: x.stage, days_until: x.days_until, action_date: x.action_date,
      action: cut(p.action, 30) || t5FallbackAction(x),
      reason: cut(p.reason, 70) || t5FallbackReason(x),
      priority: x.prio_label,
      channel: ['微信', '电话', '面谈', '活动'].indexOf(p.channel) >= 0 ? p.channel : t5FallbackChannel(x),
      goal: cut(p.goal, 30) || '推进当前阶段',
      suggested_date: sd,
      script: cut(p.script, 80) || t5FallbackScript(x),
      confidence: conf,
      evidence: ev.length ? ev : t5FallbackEvidence(x),
    });
  }
  // 配额裁剪 + 规则兜底补齐（不凑数：候选用完即止）
  const out = [];
  const quota = [['must_do', T5_MUST], ['recommended', T5_REC], ['optional', T5_OPT]];
  for (const [tier, n] of quota) {
    for (const it of tiers[tier].slice(0, n)) out.push(it);
  }
  for (const x of shortlist) {
    if (out.length >= T5_TOTAL) break;
    if (used.has(x.action_id)) continue;
    used.add(x.action_id);
    const tier = out.filter(t => t.tier === 'must_do').length < T5_MUST ? 'must_do'
      : out.filter(t => t.tier === 'recommended').length < T5_REC ? 'recommended' : 'optional';
    out.push(t5RulePick(x, tier, today));
  }
  const order = { must_do: 0, recommended: 1, optional: 2 };
  out.sort((a, b) => order[a.tier] - order[b.tier]);
  return out;
}

// Today 5 → 旧版 items 结构（当前前端 renderCoachItems 兼容；本 Sprint 不改前端）
function todayFiveToLegacy(t5) {
  return t5.map(x => {
    if (x.person_type === 'activity') {
      const m = String(x.action_id || '').match(/^activity_task-(\d+)$/);
      return {
        type: 'activity_action', source_type: 'activity_task',
        source_id: m ? parseInt(m[1], 10) : null,
        id: m ? parseInt(m[1], 10) : null,
        action_type: 'complete_task', activity_id: x.person_id, person_type: '', person_id: null,
        name: x.title || x.person_name, stage: '', priority: x.priority,
        assessment: x.reason, goal: x.goal, next_action: x.action, topic: '',
        avoid: '', success_criteria: '',
        next_followup_date: x.suggested_date || x.action_date || '',
      };
    }
    return {
      type: x.person_type === 'recruit' ? 'recruit' : 'customer',
      id: x.person_id, name: x.person_name, stage: x.stage || '', priority: x.priority,
      assessment: x.reason, goal: x.goal, next_action: x.action,
      topic: x.stage ? cut(x.stage, 12) : '', avoid: '', success_criteria: '',
      next_followup_date: x.suggested_date || x.action_date || '',
    };
  });
}

// “查看全部”事实清单（全部行动按规则综合分排序；不调 AI，纯事实）
function allActionsFact(list) {
  return list.map(x => ({
    action_id: x.action_id, action_type: x.action_type, person_type: x.person_type,
    person_id: x.person_id, person_name: x.person_name, title: x.title, source: x.source,
    next_action: x.next_action, action_date: x.action_date, priority: x.prio_label,
    status: x.status, stage: x.stage, days_until: x.days_until,
    last_followup_date: x.last_followup, score: x.score,
  }));
}

// ---------- AI 每日经营复盘（v1.6） ----------
// period: 'today'（当天）| '7d'（最近7天，含今天）
// 聚合 10 类经营数据 → AI 生成 7 段结构化复盘（300~500 字，具体不空泛）
function reviewRange(period, today) {
  if (period === '7d') {
    const d = new Date(Date.parse(today) - 6 * 86400000);
    return { start: d.toISOString().slice(0, 10), end: today };
  }
  return { start: today, end: today };
}
function inRange(dateStr, start, end) {
  const d = dayKeyOf(dateStr);
  if (!d) return false;
  return d >= start && d <= end;
}
function custName(d, id) {
  for (const c of d.customers) if (c.Id === id) return c.customer_name || ('客户#' + id);
  return '客户#' + id;
}
function recruitName(d, cid) {
  for (const c of d.customers) if (c.Id === cid) return c.customer_name || ('候选人#' + cid);
  return '候选人#' + cid;
}

function buildReviewContext(d, start, end) {
  const L = [];
  L.push('统计区间：' + start + ' ~ ' + end);
  L.push('');
  const push = (title, rows) => { L.push('【' + title + ' ' + rows.length + '】'); rows.forEach(r => L.push('- ' + r)); L.push(''); };

  // 1. 客户新增
  push('客户新增', d.customers
    .filter(c => inRange(c.created_at, start, end))
    .slice(0, 10)
    .map(c => c.customer_name + '（' + (c.customer_stage || '新认识') + '）'));

  // 2. 客户沟通（跟进记录）
  push('客户沟通', d.followups
    .filter(f => inRange(f.followup_date, start, end))
    .slice(0, 15)
    .map(f => custName(d, f.customer_id) + '：' + cut(f.followup_notes, 50)));

  // 3. NBA 推荐
  push('NBA推荐', d.aiRecs
    .filter(r => inRange(r.recommendation_date || r.created_at, start, end))
    .slice(0, 10)
    .map(r => {
      const nba = (r.nba && typeof r.nba === 'object') ? r.nba : {};
      return custName(d, r.customer_id) + '：' + cut(nba.next_action || nba.assessment || '', 50);
    }));

  // 4. 机会变化
  const oppChg = d.opportunities.filter(o => inRange(o.updated_at, start, end) || inRange(o.created_at, start, end));
  push('机会变化', oppChg.slice(0, 10).map(o =>
    custName(d, o.customer_id) + '：' + (o.opportunity_type || '机会') + '（' + o.status + '）' +
    (o.referred_name ? ' 被介绍人「' + o.referred_name + '」' : '') +
    (o.next_action ? ' 下一步：' + cut(o.next_action, 30) : '')
  ));

  // 5. 活动
  push('活动', (d.activities || [])
    .filter(a => inRange(a.activity_date || a.created_at, start, end))
    .slice(0, 8)
    .map(a => (a.activity_date ? a.activity_date + ' ' : '') + (a.name || '活动') +
      (a.activity_type ? '（' + a.activity_type + '）' : '')));

  // 6. 增员新增
  push('增员新增', d.candidates
    .filter(r => inRange(r.created_at, start, end))
    .slice(0, 10)
    .map(r => recruitName(d, r.customer_id) + '（' + (r.stage || '新增人才') + '）'));

  // 7. 增员沟通
  push('增员沟通', d.recruitFollowups
    .filter(f => inRange(f.followup_date, start, end))
    .slice(0, 12)
    .map(f => {
      const cand = d.candidates.find(c => c.id === f.candidate_id);
      return recruitName(d, cand ? cand.customer_id : null) + '：' + cut(f.followup_notes, 50) +
        (f.interest_level ? '（意向' + f.interest_level + '）' : '');
    }));

  // 8. 增员阶段变化
  push('增员阶段变化', d.candidates
    .filter(r => inRange(r.stage_changed_at, start, end))
    .slice(0, 8)
    .map(r => recruitName(d, r.customer_id) + ' → ' + (r.stage || '')));

  return L.join('\n');
}

function buildReviewMessages(context) {
  const system = [
    '你是保险从业者 Victor 的 AI 经营教练。下面是一段经营区间内的真实经营数据。',
    '请基于这些数据生成一份简洁的经营复盘，必须满足：',
    '1. 全部内容控制在 300~500 字以内。',
    '2. 必须具体：引用真实姓名、事件、数字；严禁泛泛而谈（如"加强客户关系维护"）。',
    '3. 只使用提供的数据，禁止编造未出现的客户/事件/需求。',
    '4. 只输出 JSON，不要解释。',
    '输出格式：',
    '{"overview":"今日经营概况（1-2句，含关键数字）","best_done":"今天完成得最好的一件事（具体到人+事）","biggest_gap":"今天最大的经营缺口（具体未做什么）","key_customers":"重要客户变化（1-3人，含姓名+变化）","key_recruits":"重要增员变化（1-3人，含姓名+变化）","tomorrow_top3":["明天第1重要的事","明天第2重要的事","明天第3重要的事"],"advice":"一条经营建议（具体可执行，不点泛泛的话）"}',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: '经营数据：\n' + context },
  ];
}

function normReview(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const t3 = Array.isArray(parsed.tomorrow_top3) ? parsed.tomorrow_top3.slice(0, 3).map(x => cut(x, 60)) : [];
  while (t3.length < 3) t3.push('');
  return {
    overview: cut(parsed.overview, 120),
    best_done: cut(parsed.best_done, 80),
    biggest_gap: cut(parsed.biggest_gap, 80),
    key_customers: cut(parsed.key_customers, 120),
    key_recruits: cut(parsed.key_recruits, 120),
    tomorrow_top3: t3,
    advice: cut(parsed.advice, 80),
  };
}

async function dailyReview(d, period) {
  const today = todayStr();
  const { start, end } = reviewRange(period, today);
  const context = buildReviewContext(d, start, end);
  const { text } = await generateText(buildReviewMessages(context), { timeout: 100000 });
  const parsed = extractJson(text);
  const review = normReview(parsed);
  if (!review) throw new Error('AI 输出解析失败：' + cut(text, 120));
  return { today, period, start, end, review, generated_at: nowIso() };
}

// ---------- 入口 ----------
exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    if (action !== 'candidates' && action !== 'generate' && action !== 'daily_review') {
      return { error: 'action must be candidates|generate|daily_review' };
    }

    const d = await loadAll();
    const today = todayStr();
    const fingerprint = buildFingerprint(d);
    const custPool = scoreCustomers(d, today);
    const rcPool = scoreRecruits(d, today);
    const nbaIdx = indexFreshNba(d, today);
    // v1.7.6：活动行动候选（与客户/增员池共用 score 协议，纯只读）
    const actionPool = scoreActivityActions(d, today, custPool, rcPool);

    if (action === 'candidates') {
      return { today, fingerprint, customerPool: custPool, recruitPool: rcPool, activityPool: actionPool };
    }

    if (action === 'daily_review') {
      const period = (event && event.period) || 'today';
      if (period !== 'today' && period !== '7d') return { error: 'period must be today|7d' };
      return await dailyReview(d, period);
    }

    // generate（v1.8 Sprint3 升级为 Today 5）：
    // 事实全部取 v_action_center（status/days_until/last_followup_date 由 SQL 计算），
    // AI 只负责选 5 件今天最值得做的事（Must Do×2 / Recommended×2 / Optional×1）并生成
    // action/reason/priority/channel/goal/suggested_date/script/confidence/evidence 9 字段；
    // AI 失败降级规则版（不编造信息、confidence 封顶 medium）；items 为 Today5 的旧结构
    // 映射，保持当前前端兼容；all_actions 为「查看全部」事实清单（纯事实，不调 AI）。
    const allCands = buildActionCandidates(d, nbaIdx, today);
    const shortlist = allCands.slice(0, T5_SHORTLIST);
    let today5 = null, source = 'rule', ai_error = '';
    if (shortlist.length) {
      try {
        const { text } = await generateText(buildTodayFiveMessages(shortlist, today), { timeout: 100000 });
        today5 = normTodayFive(extractJson(text), shortlist, today);
        if (today5 && today5.length) source = 'ai';
        else ai_error = 'AI 输出解析失败：' + cut(text, 120);
      } catch (e) { ai_error = 'AI 调用失败：' + e.message; }
    }
    if (!today5 || !today5.length) {
      today5 = shortlist.slice(0, T5_TOTAL).map((x, i) => t5RulePick(x,
        i < T5_MUST ? 'must_do' : i < T5_MUST + T5_REC ? 'recommended' : 'optional', today));
    }
    const items = todayFiveToLegacy(today5);
    const all_actions = allActionsFact(allCands);
    const out = {
      today, fingerprint, source, generated_at: nowIso(),
      today5, items,
      all_actions, all_actions_total: all_actions.length,
      quota: { must_do: T5_MUST, recommended: T5_REC, optional: T5_OPT },
    };
    if (ai_error) out.ai_error = ai_error;
    return out;
  } catch (e) {
    return { error: e.message };
  }
};
