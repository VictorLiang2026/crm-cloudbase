/**
 * activity_reports — 活动量日报（事件云函数，rdb() 版，纯读聚合）
 *
 * 入参 event: { action, mode, startDate?, endDate? }
 *   action: 'customer'（客户经营） | 'recruit'（增员）
 *   mode:   'today'（当天实时，默认） | 'range'（区间，必填 startDate/endDate，YYYY-MM-DD）
 *
 * 返回 { mode, range:{start,end,days}, totals, daily, avg, overdueNow?, goalProgress?, feed, feedTotal, generatedAt }
 *
 * 口径约定：
 *  - 活动归属按业务发生日期（followup_date/given_date/report_date/happened_at 等），无业务日期的按 created_at
 *  - 时区按 Asia/Shanghai 切日；只统计 deleted_at IS NULL 的记录（软删除级联数据自动排除）
 *  - rdb 无 in()/聚合函数，采用全量裁列 select + JS 端按日分桶（与回收站 trashList 同模式，数据量级小）
 */
'use strict';

const { app, rdb, assertOk } = require('./db');

const TZ_OFFSET_MS = 8 * 3600 * 1000;

// ---------- 日期工具 ----------
function beijingToday() {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

// 取北京时间日期键 YYYY-MM-DD；纯日期字符串直接返回，完整 ISO 时间戳按 +08:00 换算
function toDayKey(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function dayList(start, end) {
  // 仅做整天算术：按 UTC 解析日期串、setUTCDate 递增、toISOString 取日期部分
  // （UTC 与北京的整天加减结果一致，避免 toISOString 回退到前一天的偏移问题）
  const out = [];
  const cur = new Date(start + 'T00:00:00Z');
  const endTs = new Date(end + 'T00:00:00Z').getTime();
  while (cur.getTime() <= endTs) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function resolveRange(event) {
  if (event.mode === 'range') {
    const start = event.startDate, end = event.endDate;
    if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { error: 'startDate/endDate 必填，格式 YYYY-MM-DD' };
    }
    if (start > end) return { error: '开始日期不能晚于结束日期' };
    const days = dayList(start, end).length;
    if (days > 366) return { error: '区间跨度不能超过 366 天' };
    return { start, end, days };
  }
  const today = beijingToday();
  return { start: today, end: today, days: 1 };
}

const active = (r) => !r.deleted_at;
const inRange = (day, start, end) => day && day >= start && day <= end;

// ---------- 客户经营活动量 ----------
async function customerReport(event) {
  const range = resolveRange(event);
  if (range.error) return range;
  const { start, end, days } = range;
  const today = beijingToday();

  const [customersR, followupsR, giftsR, photosR, ocrR, aiRecR, reviewsR, productsR] = await Promise.all([
    rdb.from('customers').select('Id, customer_name, created_at, first_contact_date, deleted_at'),
    rdb.from('followups').select('Id, customer_id, customer_name, followup_notes, followup_date, next_followup_date, created_at, deleted_at'),
    rdb.from('gifts').select('Id, customer_id, customer_name, gift_name, quantity, given_date, deleted_at'),
    rdb.from('photos').select('id, customer_id, customer_name, file_name, created_at, deleted_at'),
    rdb.from('ocr_records').select('id, customer_id, summary, created_at, deleted_at'),
    rdb.from('ai_recommendations').select('id, customer_id, customer_name, recommendation_date, suggested_followup_goal, created_at'),
    rdb.from('policy_review_reports').select('id, customer_id, customer_name, report_date, report_type, created_at, deleted_at'),
    rdb.from('products').select('*'),
  ]);

  const customers = (assertOk(customersR).data || []).filter(active);
  const followups = (assertOk(followupsR).data || []).filter(active);
  const gifts = (assertOk(giftsR).data || []).filter(active);
  const photos = (assertOk(photosR).data || []).filter(active);
  const ocrs = (assertOk(ocrR).data || []).filter(active);
  const aiRecs = assertOk(aiRecR).data || []; // ai_recommendations 无删除功能/无 deleted_at
  const reviews = (assertOk(reviewsR).data || []).filter(active);
  const products = (assertOk(productsR).data || []).filter(active);

  const custName = {};
  customers.forEach(c => { custName[c.Id] = c.customer_name; });

  const totals = blankCustomerTotals();
  const dailyMap = {};
  const feed = [];
  const planPairs = new Set(), donePairs = new Set();

  function pushFeed(t, day, type, name, detail) {
    if (!inRange(day, start, end)) return;
    feed.push({ t: t || (day + 'T00:00:00+08:00'), day, type, name: name || '', detail: detail || '' });
  }

  const touchedTotal = new Set();

  // 新增客户 / 首次接触
  customers.forEach(c => {
    const dNew = toDayKey(c.created_at);
    if (inRange(dNew, start, end)) {
      totals.newCustomers++;
      if (!dailyMap[dNew]) dailyMap[dNew] = blankCustomerDaily();
      dailyMap[dNew].newCustomers++;
      pushFeed(c.created_at, dNew, '新增客户', c.customer_name, '客户建档');
    }
    const dFirst = toDayKey(c.first_contact_date);
    if (inRange(dFirst, start, end)) {
      totals.firstContacts++;
      if (!dailyMap[dFirst]) dailyMap[dFirst] = blankCustomerDaily();
      dailyMap[dFirst].firstContacts++;
    }
  });

  // 跟进（接触）
  followups.forEach(f => {
    const day = toDayKey(f.followup_date);
    if (inRange(day, start, end)) {
      totals.followups++;
      touchedTotal.add(f.customer_id);
      if (!dailyMap[day]) dailyMap[day] = blankCustomerDaily();
      dailyMap[day].followups++;
      if (!dailyMap[day]._touched) dailyMap[day]._touched = new Set();
      dailyMap[day]._touched.add(f.customer_id);
      dailyMap[day].customersTouched = dailyMap[day]._touched.size;
      donePairs.add(f.customer_id + '|' + day);
      pushFeed(f.created_at, day, '跟进', f.customer_name || custName[f.customer_id], trunc(f.followup_notes, 60));
    }
    const nd = toDayKey(f.next_followup_date);
    if (nd) planPairs.add(f.customer_id + '|' + nd);
  });
  totals.customersTouched = touchedTotal.size;
  // 计划完成：计划跟进日在区间内、且当天有实际跟进
  let completed = 0;
  planPairs.forEach(p => { if (donePairs.has(p)) completed++; });
  const plannedInRange = [...planPairs].filter(p => { const d = p.split('|')[1]; return inRange(d, start, end); }).length;
  totals.plannedDue = plannedInRange;
  totals.completedPlan = completed;
  totals.completionRate = plannedInRange ? Math.round(completed / plannedInRange * 1000) / 10 : null;

  // 逾期快照（仅 today 模式有意义）：客户最新一条跟进的 next_followup_date 早于今天
  let overdueNow = null;
  if (event.mode !== 'range') {
    const latest = new Map();
    followups.forEach(f => {
      const day = toDayKey(f.followup_date) || '';
      const cur = latest.get(f.customer_id);
      if (!cur || day > cur.day || (day === cur.day && f.Id > cur.id)) latest.set(f.customer_id, { day, id: f.Id, next: toDayKey(f.next_followup_date) });
    });
    overdueNow = 0;
    latest.forEach(v => { if (v.next && v.next < today) overdueNow++; });
  }

  // 伴手礼
  gifts.forEach(g => {
    const day = toDayKey(g.given_date);
    if (inRange(day, start, end)) {
      totals.gifts++;
      totals.giftItems += parseInt(g.quantity, 10) || 1;
      if (!dailyMap[day]) dailyMap[day] = blankCustomerDaily();
      dailyMap[day].gifts++;
      pushFeed(g.created_at || g.given_date, day, '伴手礼', g.customer_name || custName[g.customer_id],
        (g.gift_name || '礼品') + ' ×' + (g.quantity || 1));
    }
  });

  // 照片/资料上传
  photos.forEach(p => {
    const day = toDayKey(p.created_at);
    if (inRange(day, start, end)) {
      totals.photos++;
      if (!dailyMap[day]) dailyMap[day] = blankCustomerDaily();
      dailyMap[day].photos++;
      pushFeed(p.created_at, day, '资料上传', p.customer_name || custName[p.customer_id], p.file_name || '');
    }
  });

  // AI 解析
  ocrs.forEach(o => {
    const day = toDayKey(o.created_at);
    if (inRange(day, start, end)) {
      totals.ocrParses++;
      if (!dailyMap[day]) dailyMap[day] = blankCustomerDaily();
      dailyMap[day].ocrParses++;
      pushFeed(o.created_at, day, 'AI解析', custName[o.customer_id], trunc(o.summary, 60));
    }
  });

  // AI 建议
  aiRecs.forEach(a => {
    const day = toDayKey(a.recommendation_date || a.created_at);
    if (inRange(day, start, end)) {
      totals.aiSuggestions++;
      if (!dailyMap[day]) dailyMap[day] = blankCustomerDaily();
      dailyMap[day].aiSuggestions++;
      pushFeed(a.created_at || a.recommendation_date, day, 'AI建议', a.customer_name || custName[a.customer_id], trunc(a.suggested_followup_goal, 60));
    }
  });

  // 保单检视报告
  reviews.forEach(r => {
    const day = toDayKey(r.report_date || r.created_at);
    if (inRange(day, start, end)) {
      totals.policyReviews++;
      if (!dailyMap[day]) dailyMap[day] = blankCustomerDaily();
      dailyMap[day].policyReviews++;
      pushFeed(r.created_at || r.report_date, day, '保单检视', r.customer_name || custName[r.customer_id], r.report_type || '检视报告');
    }
  });

  // 产品额度更新（updated_at 列可能不存在，容错）
  products.forEach(p => {
    if (!p.updated_at) return;
    const day = toDayKey(p.updated_at);
    if (inRange(day, start, end)) {
      totals.productUpdates++;
      if (!dailyMap[day]) dailyMap[day] = blankCustomerDaily();
      dailyMap[day].productUpdates++;
      pushFeed(p.updated_at, day, '额度更新', p.customer_name || custName[p.customer_id], '产品额度维护');
    }
  });

  const daily = dayList(start, end).map(d => Object.assign({ date: d }, blankCustomerDaily(), dailyMap[d] || {}));
  daily.forEach(d => { delete d._touched; });

  feed.sort((a, b) => b.t.localeCompare(a.t));
  const feedTotal = feed.length;

  return {
    mode: event.mode === 'range' ? 'range' : 'today',
    range: { start, end, days },
    totals,
    daily,
    avg: avgOf(totals, days, CUSTOMER_AVG_KEYS),
    overdueNow,
    feed: feed.slice(0, 300),
    feedTotal,
    generatedAt: new Date().toISOString(),
  };
}

function blankCustomerTotals() {
  return {
    newCustomers: 0, firstContacts: 0,
    followups: 0, customersTouched: 0,
    plannedDue: 0, completedPlan: 0, completionRate: null,
    gifts: 0, giftItems: 0,
    photos: 0, ocrParses: 0, aiSuggestions: 0, policyReviews: 0, productUpdates: 0,
  };
}
function blankCustomerDaily() {
  return {
    newCustomers: 0, firstContacts: 0,
    followups: 0, customersTouched: 0,
    gifts: 0, photos: 0, ocrParses: 0, aiSuggestions: 0, policyReviews: 0, productUpdates: 0,
  };
}
const CUSTOMER_AVG_KEYS = ['newCustomers', 'firstContacts', 'followups', 'customersTouched', 'gifts', 'giftItems', 'photos', 'ocrParses', 'aiSuggestions', 'policyReviews', 'productUpdates'];

// ---------- 增员活动量 ----------
const STAGE_KEYS = {
  '互动暖客': 'warm',
  '初次面谈': 'firstInterview',
  '增员活动': 'event',
  '精准面谈': 'deepInterview',
  '入职申请': 'apply',
  '签约入司': 'hired',
};

async function recruitReport(event) {
  const range = resolveRange(event);
  if (range.error) return range;
  const { start, end, days } = range;

  const [candsR, fuR, msR, custR] = await Promise.all([
    rdb.from('recruit_candidates').select('id, customer_id, stage, created_at, deleted_at'),
    rdb.from('recruit_followups').select('id, candidate_id, contact_method, interest_level, followup_notes, followup_date, next_followup_date, created_at, deleted_at'),
    rdb.from('recruit_milestones').select('id, candidate_id, from_stage, to_stage, happened_at, note'),
    rdb.from('customers').select('Id, customer_name, deleted_at'),
  ]);

  const candsAll = assertOk(candsR).data || [];
  const activeCands = candsAll.filter(active);
  const activeCandIds = new Set(activeCands.map(c => c.id));
  const fus = (assertOk(fuR).data || []).filter(r => active(r) && activeCandIds.has(r.candidate_id));
  const milestones = assertOk(msR).data || [];
  const customers = (assertOk(custR).data || []).filter(active);

  const custName = {};
  customers.forEach(c => { custName[c.Id] = c.customer_name; });
  const candName = {};
  candsAll.forEach(c => { candName[c.id] = custName[c.customer_id] || ('候选人#' + c.id); });

  const totals = blankRecruitTotals();
  const dailyMap = {};
  const feed = [];
  const planPairs = new Set(), donePairs = new Set();
  const touchedTotal = new Set();

  function bump(day, key) {
    if (!inRange(day, start, end)) return false;
    totals[key]++;
    if (!dailyMap[day]) dailyMap[day] = blankRecruitDaily();
    dailyMap[day][key]++;
    return true;
  }
  function pushFeed(t, day, type, name, detail) {
    if (!inRange(day, start, end)) return;
    feed.push({ t: t || (day + 'T00:00:00+08:00'), day, type, name: name || '', detail: detail || '' });
  }

  // 新增候选人
  activeCands.forEach(c => {
    const day = toDayKey(c.created_at);
    if (inRange(day, start, end)) {
      totals.newCandidates++;
      if (!dailyMap[day]) dailyMap[day] = blankRecruitDaily();
      dailyMap[day].newCandidates++;
      pushFeed(c.created_at, day, '新增候选人', candName[c.id], '进入「新增人才」阶段');
    }
  });

  // 增员跟进
  fus.forEach(f => {
    const day = toDayKey(f.followup_date);
    if (inRange(day, start, end)) {
      totals.rcFollowups++;
      touchedTotal.add(f.candidate_id);
      if (!dailyMap[day]) dailyMap[day] = blankRecruitDaily();
      dailyMap[day].rcFollowups++;
      if (!dailyMap[day]._touched) dailyMap[day]._touched = new Set();
      dailyMap[day]._touched.add(f.candidate_id);
      dailyMap[day].candidatesTouched = dailyMap[day]._touched.size;
      donePairs.add(f.candidate_id + '|' + day);
      const detail = [f.contact_method, f.interest_level ? ('意向:' + f.interest_level) : '', trunc(f.followup_notes, 40)]
        .filter(Boolean).join(' / ');
      pushFeed(f.created_at, day, '增员跟进', candName[f.candidate_id], detail);
    }
    const nd = toDayKey(f.next_followup_date);
    if (nd) planPairs.add(f.candidate_id + '|' + nd);
  });
  totals.candidatesTouched = touchedTotal.size;
  let completed = 0;
  planPairs.forEach(p => { if (donePairs.has(p)) completed++; });
  const plannedInRange = [...planPairs].filter(p => { const d = p.split('|')[1]; return inRange(d, start, end); }).length;
  totals.plannedDue = plannedInRange;
  totals.completedPlan = completed;
  totals.completionRate = plannedInRange ? Math.round(completed / plannedInRange * 1000) / 10 : null;

  // 阶段漏斗（里程碑）
  milestones.forEach(m => {
    if (!activeCandIds.has(m.candidate_id)) return; // 排除已删除候选人
    const day = toDayKey(m.happened_at);
    if (!inRange(day, start, end)) return;
    const key = STAGE_KEYS[m.to_stage];
    if (key) {
      totals[key]++;
      if (!dailyMap[day]) dailyMap[day] = blankRecruitDaily();
      dailyMap[day][key]++;
      // 「新增人才」里程碑与候选人创建事件重复，不重复进入流水
      pushFeed(m.happened_at, day, '阶段推进', candName[m.candidate_id],
        (m.from_stage ? m.from_stage + ' → ' : '') + m.to_stage);
    }
  });

  const daily = dayList(start, end).map(d => {
    const row = Object.assign({ date: d }, blankRecruitDaily(), dailyMap[d] || {});
    delete row._touched;
    return row;
  });

  feed.sort((a, b) => b.t.localeCompare(a.t));
  const feedTotal = feed.length;

  // 目标对照：复用 recruit_goals getProgress（月份取区间首月~末月；today 模式为当月）
  let goalProgress = null;
  try {
    const startMonth = start.slice(0, 7);
    const endMonth = end.slice(0, 7);
    const res = await app.callFunction({
      name: 'recruit_goals',
      data: { action: 'getProgress', startMonth, endMonth },
    });
    goalProgress = (res && res.result) || null;
  } catch (e) {
    goalProgress = { error: '目标数据暂不可用：' + e.message };
  }

  return {
    mode: event.mode === 'range' ? 'range' : 'today',
    range: { start, end, days },
    totals,
    daily,
    avg: avgOf(totals, days, RECRUIT_AVG_KEYS),
    goalProgress,
    feed: feed.slice(0, 300),
    feedTotal,
    generatedAt: new Date().toISOString(),
  };
}

function blankRecruitTotals() {
  return {
    newCandidates: 0, rcFollowups: 0, candidatesTouched: 0,
    plannedDue: 0, completedPlan: 0, completionRate: null,
    warm: 0, firstInterview: 0, event: 0, deepInterview: 0, apply: 0, hired: 0,
  };
}
function blankRecruitDaily() {
  return {
    newCandidates: 0, rcFollowups: 0, candidatesTouched: 0,
    warm: 0, firstInterview: 0, event: 0, deepInterview: 0, apply: 0, hired: 0,
  };
}
const RECRUIT_AVG_KEYS = ['newCandidates', 'rcFollowups', 'candidatesTouched', 'warm', 'firstInterview', 'event', 'deepInterview', 'apply', 'hired'];

// ---------- 通用 ----------
function avgOf(totals, days, keys) {
  const out = {};
  keys.forEach(k => { out[k] = Math.round(totals[k] / days * 10) / 10; });
  return out;
}

function trunc(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'customer': return await customerReport(event);
      case 'recruit': return await recruitReport(event);
      default: return { error: 'unknown action: ' + action + '（支持 customer / recruit）' };
    }
  } catch (e) {
    return { error: e.message };
  }
};
