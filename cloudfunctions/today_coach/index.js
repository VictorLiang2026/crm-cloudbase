/**
 * today_coach — AI 今日经营驾驶舱（事件云函数，超时 120s，rdb() 版）
 *
 * 设计原则（v1.0.4 增量，2026-09-06）：
 * - 第一版不依赖 AI 做筛选：先按现有数据规则打分生成候选池，AI 仅做综合排序 + 生成简短理由
 * - 不写数据库、不新增表/字段；纯读聚合（同 activity_reports 模式：全量裁列 select + JS 计算）
 * - action:
 *     candidates: { action:'candidates' }
 *       → 纯规则筛选（不调 AI，快），返回 { today, fingerprint, customerPool, recruitPool }
 *     generate:   { action:'generate' }
 *       → 规则候选（客户 top12 + 增员 top9）→ hy3 结构化排序/NBA → { today, fingerprint, source, items }
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
  const [cust, fol, rc, rf, rm, ai] = await Promise.all([
    rdb.from('customers').select(
      'Id, customer_name, gender, customer_stage, sales_priority, first_contact_date, created_at, updated_at'
    ).is('deleted_at', null),
    rdb.from('followups').select(
      'customer_id, followup_date, next_followup_date, followup_notes, updated_at'
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
  ]);
  return {
    customers: (cust.data || []),
    followups: (fol.data || []),
    candidates: (rc.data || []),
    recruitFollowups: (rf.data || []),
    milestones: (rm.data || []),
    aiRecs: (ai.data || []),
  };
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

// fingerprint：四张主数据表 max(updated_at) 拼串（阶段变化会 update recruit_candidates，故里程碑不必单算）
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

    if (score > 0) {
      out.push({
        type: 'customer', id: c.Id, name: c.customer_name || '未知',
        stage: c.customer_stage || '未分层', score, hits,
        gender: c.gender || '',
        last_note: fol ? cut(fol.latest.followup_notes, 60) : '',
        last_date: lastFolDate || '',
      });
    }
  }
  out.sort((a, b) => b.score - a.score || a.id - b.id);
  return out.slice(0, POOL_CUSTOMER);
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

// ---------- 规则版最终列表（AI 降级兜底；字段同 NBA 结构，不编造客户信息） ----------
function ruleItems(custPool, rcPool, nbaIdx) {
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
  const merged = custPool.concat(rcPool).sort((a, b) => b.score - a.score).slice(0, FINAL_COUNT);
  return merged.map(x => {
    const fresh = x.type === 'customer' ? nbaIdx[x.id] : null;
    if (fresh) {
      return {
        type: x.type, id: x.id, name: x.name, stage: x.stage, priority: prio(x.score),
        assessment: cut(fresh.assessment, 80), goal: cut(fresh.goal, 40),
        next_action: cut(fresh.next_action, 60), topic: cut(fresh.topic, 16),
        avoid: cut(fresh.avoid, 60), success_criteria: cut(fresh.success_criteria, 40),
        next_followup_date: x.next_date || '', nba_from: 'detail',
      };
    }
    return {
      type: x.type, id: x.id, name: x.name, stage: x.stage, priority: prio(x.score),
      assessment: x.hits.join('；') || '有跟进价值',
      goal: x.type === 'customer' ? goalC(x) : goalR(x),
      next_action: x.type === 'customer' ? actC(x) : actR(x),
      topic: x.last_note ? cut(x.last_note, 16) : (x.type === 'customer' ? x.stage : '近况交流'),
      avoid: x.type === 'customer' ? avoidC : avoidR,
      success_criteria: x.type === 'customer' ? critC : critR,
      next_followup_date: x.next_date || '',
    };
  });
}

// ---------- AI 排序 + NBA 生成 ----------
function buildMessages(pools, nbaIdx) {
  const lines = [];
  pools.forEach((x, i) => {
    const fresh = x.type === 'customer' ? nbaIdx[x.id] : null;
    lines.push((i + 1) + '. type=' + x.type + ' id=' + x.id + ' 姓名=' + x.name +
      ' 阶段=' + x.stage + ' 信号=' + (x.hits.join('、') || '无') +
      ' 最近跟进摘要=' + (x.last_note || '无') +
      (fresh ? ' 已有下一步行动方案(内容必须原样采用)=' + JSON.stringify(fresh) : ''));
  });
  const system = [
    '你是保险从业者 Victor 的每日经营助手。输入是按规则筛出的今天值得联系的人（客户 type=customer 与增员候选人 type=recruit）。',
    '任务：综合紧迫度、经营价值、阶段节奏，选出今天最值得经营的最多 ' + FINAL_COUNT + ' 人，按建议联系先后排序，并为每人给出 Next Best Action（下一最佳行动）。',
    '注意：增员候选人也是客户（先有关系后有增员），两类可交错排序；信号强的排前面。',
    '客户条目若带"已有下一步行动方案"：其 assessment/goal/next_action/topic/avoid/success_criteria 六个字段必须原样采用该方案内容，不要改写（排序优先级仍由你判断）。',
    '其余条目由你生成：客户用客户经营语言（结合其阶段与信号），增员候选人用增员经营语言（阶段推进/机会吸引，结合增员五步法）。',
    '【信息不足规则】资料不足以判断的字段必须填"信息不足"，严禁编造客户的家庭/收入/需求/意向等信息。',
    '只输出 JSON，不要解释。输出格式：',
    '{"items":[{"type":"customer|recruit","id":数字,"priority":"高|中|低","assessment":"当前经营判断，不超过2句60字","goal":"当前最重要经营目标，不超过30字","next_action":"下一最佳行动，1句具体可执行，不超过40字","topic":"推荐沟通主题，不超过12字","avoid":"不建议做什么，不超过40字","success_criteria":"成功标准，不超过30字"}]}',
    '所有字段必须简洁、具体、可执行，不要空话；不要输出日期（建议下一次跟进时间由系统按现有数据填写）。',
  ].join('\n');
  const user = '今日候选（已按规则分数初排）：\n' + lines.join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function mergeAiResult(parsed, pools, nbaIdx) {
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
  if (!items || !items.length) return null;
  const key = {}; pools.forEach(x => { key[x.type + '#' + x.id] = x; });
  const out = [];
  for (const it of items) {
    if (out.length >= FINAL_COUNT) break;
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
        next_followup_date: base.next_date || '', nba_from: 'detail',
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
    });
  }
  return out.length ? out : null;
}

// ---------- 入口 ----------
exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    if (action !== 'candidates' && action !== 'generate') return { error: 'action must be candidates|generate' };

    const d = await loadAll();
    const today = todayStr();
    const fingerprint = buildFingerprint(d);
    const custPool = scoreCustomers(d, today);
    const rcPool = scoreRecruits(d, today);
    const nbaIdx = indexFreshNba(d, today);

    if (action === 'candidates') {
      return { today, fingerprint, customerPool: custPool, recruitPool: rcPool };
    }

    // generate：AI 排序 + NBA + 失败降级
    const pools = custPool.concat(rcPool);
    let items = null, source = 'rule', ai_error = '';
    if (pools.length) {
      try {
        const { text } = await generateText(buildMessages(pools, nbaIdx), { timeout: 100000 });
        const parsed = extractJson(text);
        items = mergeAiResult(parsed, pools, nbaIdx);
        if (items) source = 'ai';
        else ai_error = 'AI 输出解析失败：' + cut(text, 120);
      } catch (e) { ai_error = 'AI 调用失败：' + e.message; }
    }
    if (!items) items = ruleItems(custPool, rcPool, nbaIdx);
    const out = { today, fingerprint, source, generated_at: nowIso(), items };
    if (ai_error) out.ai_error = ai_error;
    return out;
  } catch (e) {
    return { error: e.message };
  }
};
