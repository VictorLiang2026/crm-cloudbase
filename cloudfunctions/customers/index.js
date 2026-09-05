/**
 * customers — 客户 CRUD（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:   { action:'list', page?, pageSize?, keyword? } → { rows, total, page, pageSize }
 *   get:    { action:'get', id } → { customer, followups, products, gifts, photos, recommendations, reports }
 *           reports = 保单检视报告最近 10 条（按 report_date DESC, id DESC）
 *   create: { action:'create', data:{...} } → { id }
 *   update: { action:'update', id, data:{...} } → { ok }
 *   remove: { action:'remove', id } → { ok, cascaded }（软删除 deleted_at，级联标记子记录）
 *   trashList: { action:'trashList', page?, pageSize?, keyword?, sortDir? } → { rows, total, page, pageSize }
 *              （回收站：已删除客户 + 级联删除的子记录计数，默认按删除时间倒序）
 *   restore: { action:'restore', ids:[...] } → { ok, restored, cascaded }（恢复客户及全部级联子记录）
 * photos 仅返回元数据（不含 base64），需单独调 photos.get 取图。
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

const FIELDS = [
  'customer_name', 'sales_priority', 'recruitment_priority', 'referral_priority',
  'hobbies', 'additional_info', 'gender', 'source', 'tags', 'marital_status',
  'properties_info', 'occupation', 'annual_income', 'household_income',
  'first_contact_date', 'birthday', 'customer_stage', 'phone',
];

// 列表接口也返回所有客户字段（source/annual_income/additional_info 等），
// 因为 AI 解析同名匹配时前端用 list 返回的对象作为 oldC，缺字段会导致合并时清空原值
const LIST_COLS = 'Id, customer_name, phone, occupation, customer_stage, sales_priority, recruitment_priority, referral_priority, birthday, first_contact_date, gender, marital_status, hobbies, source, tags, annual_income, household_income, properties_info, additional_info, created_at, updated_at';

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':   return await list(event);
      case 'get':    return await get(event);
      case 'create': return await create(event);
      case 'update': return await update(event);
      case 'remove': return await remove(event);
      case 'trashList': return await trashList(event);
      case 'restore': return await restore(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

async function list(event) {
  const page = Math.max(1, parseInt(event.page || 1, 10));
  const pageSize = Math.min(1000, Math.max(1, parseInt(event.pageSize || 20, 10)));
  const keyword = (event.keyword || '').trim();
  const sortField = event.sortField || 'Id';
  const sortDir = event.sortDir || 'desc';

  // 查全部未删除客户
  const custRes = assertOk(await rdb.from('customers')
    .select(LIST_COLS)
    .is('deleted_at', null));
  let rows = custRes.data || [];

  // 查全部跟进记录，取每个客户最新一条
  let followups = [];
  try {
    const folRes = assertOk(await rdb.from('followups')
      .select('customer_id, followup_date, next_followup_date')
      .is('deleted_at', null)
      .order('followup_date', { ascending: false, nullsFirst: false })
      .order('Id', { ascending: false }));
    followups = folRes.data || [];
  } catch(e) { /* followups 查询失败不阻塞客户列表 */ }

  const latestFol = {};
  for (const f of followups) {
    if (!latestFol[f.customer_id]) latestFol[f.customer_id] = f;
  }

  // 合并最新跟进日期到客户行
  for (const r of rows) {
    const fol = latestFol[r.Id];
    r.latest_followup_date = fol ? fol.followup_date : null;
    r.next_followup_date = fol ? fol.next_followup_date : null;
  }

  // 关键词过滤（部分匹配，不区分大小写）
  if (keyword) {
    const kw = keyword.toLowerCase();
    rows = rows.filter(r =>
      (r.customer_name && r.customer_name.toLowerCase().includes(kw)) ||
      (r.phone && r.phone.includes(kw)) ||
      (r.occupation && r.occupation.toLowerCase().includes(kw))
    );
  }

  // 排序
  const ascending = sortDir !== 'desc';
  rows.sort((a, b) => {
    let va = a[sortField], vb = b[sortField];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return ascending ? -1 : 1;
    if (va > vb) return ascending ? 1 : -1;
    return 0;
  });

  // 分页
  const total = rows.length;
  const offset = (page - 1) * pageSize;
  const pageRows = rows.slice(offset, offset + pageSize);

  return { rows: pageRows, total, page, pageSize };
}

async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const c = assertOk(await rdb.from('customers').select().eq('Id', id).is('deleted_at', null).maybeSingle());
  if (!c.data) return { error: 'not found' };
  const [fol, prod, gif, pho, ai, rpt] = await Promise.all([
    rdb.from('followups').select().eq('customer_id', id).is('deleted_at', null)
      .order('followup_date', { ascending: false, nullsFirst: false })
      .order('Id', { ascending: false }),
    rdb.from('products').select().eq('customer_id', id).is('deleted_at', null),
    rdb.from('gifts').select().eq('customer_id', id).is('deleted_at', null)
      .order('given_date', { ascending: false, nullsFirst: false })
      .order('Id', { ascending: false }),
    rdb.from('photos').select('id, customer_id, customer_name, file_name, content_type, sort_order, created_at, photo_notes, category')
      .eq('customer_id', id).is('deleted_at', null)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    rdb.from('ai_recommendations').select().eq('customer_id', id)
      .order('created_at', { ascending: false })
      .limit(10),
    // 保单检视报告：最近 10 条，按报告日期倒序
    rdb.from('policy_review_reports')
      .select('id, customer_id, customer_name, report_date, report_type, summary, gaps_found, recommendations, asset_allocation, next_action, edited_summary, edited_gaps, edited_recommendations, edited_asset_allocation, edited_next_action, created_at, updated_at')
      .eq('customer_id', id).is('deleted_at', null)
      .order('report_date', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(10),
  ]);
  return {
    customer: c.data,
    followups: assertOk(fol).data || [],
    products: assertOk(prod).data || [],
    gifts: assertOk(gif).data || [],
    photos: assertOk(pho).data || [],
    recommendations: assertOk(ai).data || [],
    reports: assertOk(rpt).data || [],
  };
}

async function create(event) {
  const data = event.data || {};
  if (!data.customer_name) return { error: 'customer_name required' };
  const payload = normFields(data, FIELDS);
  if (!Object.keys(payload).length) return { error: 'no valid fields' };
  const r = assertOk(await rdb.from('customers').insert(payload).select('Id'));
  return { id: r.data[0].Id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const payload = normFields(
    Object.assign({}, event.data, { updated_at: nowIso() }),
    FIELDS.concat(['updated_at'])
  );
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('customers').update(payload).eq('Id', id).select('Id'));
  const n = (r.data || []).length;
  return { ok: n === 1, updated: n };
}

// 级联软删除的子表清单（主键列名用于计数 select）
const CASC_TABLES = [
  { table: 'followups',              pk: 'Id', fk: 'customer_id' },
  { table: 'gifts',                  pk: 'Id', fk: 'customer_id' },
  { table: 'photos',                 pk: 'id', fk: 'customer_id' },
  { table: 'policy_review_reports',  pk: 'id', fk: 'customer_id' },
  { table: 'ocr_records',            pk: 'id', fk: 'customer_id' },
  { table: 'products',               pk: 'id', fk: 'customer_id' },
];

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const ts = nowIso();
  // 1. 标记客户
  const r = assertOk(await rdb.from('customers')
    .update({ deleted_at: ts })
    .eq('Id', id)
    .is('deleted_at', null)
    .select('Id'));
  if (!(r.data || []).length) return { ok: false, error: 'not found or already deleted' };
  // 2. 级联标记子记录（同一时间戳，回收站计数/恢复用）
  const cascaded = {};
  for (const t of CASC_TABLES) {
    const cr = assertOk(await rdb.from(t.table)
      .update({ deleted_at: ts })
      .eq(t.fk, id)
      .is('deleted_at', null)
      .select(t.pk));
    cascaded[t.table] = (cr.data || []).length;
  }
  // 3. 级联软删除名下未删除的增员候选人（其跟进一并标记）
  const cands = assertOk(await rdb.from('recruit_candidates')
    .select('id').eq('customer_id', id).is('deleted_at', null));
  const candIds = (cands.data || []).map(x => x.id);
  let candFollowups = 0;
  for (const cid of candIds) {
    await rdb.from('recruit_candidates').update({ deleted_at: ts }).eq('id', cid).is('deleted_at', null).select('id');
    const cf = assertOk(await rdb.from('recruit_followups')
      .update({ deleted_at: ts }).eq('candidate_id', cid).is('deleted_at', null).select('id'));
    candFollowups += (cf.data || []).length;
  }
  if (candIds.length) cascaded.recruit_candidates = candIds.length;
  if (candFollowups) cascaded.recruit_followups = candFollowups;
  return { ok: true, deleted_at: ts, cascaded };
}

// 回收站列表：已删除客户（默认按删除时间倒序），附级联删除的子记录计数
async function trashList(event) {
  const page = Math.max(1, parseInt(event.page || 1, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize || 50, 10)));
  const keyword = (event.keyword || '').trim();
  const sortDir = event.sortDir === 'asc' ? 'asc' : 'desc';

  const res = assertOk(await rdb.from('customers').select('*'));
  let rows = (res.data || []).filter(c => c.deleted_at);

  if (keyword) {
    const kw = keyword.toLowerCase();
    rows = rows.filter(c =>
      (c.customer_name && c.customer_name.toLowerCase().indexOf(kw) !== -1) ||
      (c.phone && String(c.phone).indexOf(kw) !== -1) ||
      (c.occupation && c.occupation.toLowerCase().indexOf(kw) !== -1)
    );
  }

  rows.sort((a, b) => {
    const va = a.deleted_at || '', vb = b.deleted_at || '';
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return (b.Id || 0) - (a.Id || 0);
  });

  const total = rows.length;
  const offset = (page - 1) * pageSize;
  const pageRows = rows.slice(offset, offset + pageSize);

  // 页内客户的级联删除计数（rdb 无 in()，逐表取 fk+deleted_at 后 js 过滤汇总；列裁剪不含大字段，子表量级小）
  const ids = pageRows.map(c => c.Id);
  const counts = {};
  if (ids.length) {
    const set = new Set(ids);
    for (const t of CASC_TABLES) {
      const cr = assertOk(await rdb.from(t.table)
        .select(t.fk + ', deleted_at'));
      counts[t.table] = (cr.data || []).filter(r => r.deleted_at && set.has(r[t.fk])).length;
    }
    // 增员候选人计数（含随客户删除的）
    const cc = assertOk(await rdb.from('recruit_candidates')
      .select('customer_id, deleted_at'));
    counts.recruit_candidates = (cc.data || []).filter(r => r.deleted_at && set.has(r.customer_id)).length;
  }

  return { rows: pageRows, total, page, pageSize, counts };
}

// 恢复：清除客户及全部级联子记录的删除标记
async function restore(event) {
  const ids = Array.isArray(event.ids)
    ? event.ids.map(x => parseInt(x, 10)).filter(Boolean)
    : (event.id ? [parseInt(event.id, 10)] : []);
  if (!ids.length) return { error: 'ids required' };

  let restored = 0;
  const cascaded = {};
  for (const id of ids) {
    const r = assertOk(await rdb.from('customers')
      .update({ deleted_at: null }).eq('Id', id).select('Id'));
    if (!(r.data || []).length) continue;
    restored++;
    for (const t of CASC_TABLES) {
      const cr = assertOk(await rdb.from(t.table)
        .update({ deleted_at: null }).eq(t.fk, id).select(t.pk));
      cascaded[t.table] = (cascaded[t.table] || 0) + (cr.data || []).length;
    }
    // 恢复名下软删除的增员候选人（其跟进按 candidate_id 一并恢复）
    const cands = assertOk(await rdb.from('recruit_candidates')
      .select('id').eq('customer_id', id));
    const candIds = (cands.data || []).map(x => x.id);
    if (candIds.length) {
      let nCand = 0, nFol = 0;
      for (const cid of candIds) {
        const u = assertOk(await rdb.from('recruit_candidates')
          .update({ deleted_at: null }).eq('id', cid).select('id'));
        nCand += (u.data || []).length;
        const uf = assertOk(await rdb.from('recruit_followups')
          .update({ deleted_at: null }).eq('candidate_id', cid).select('id'));
        nFol += (uf.data || []).length;
      }
      if (nCand) cascaded.recruit_candidates = (cascaded.recruit_candidates || 0) + nCand;
      if (nFol) cascaded.recruit_followups = (cascaded.recruit_followups || 0) + nFol;
    }
  }
  return { ok: true, restored, cascaded };
}
