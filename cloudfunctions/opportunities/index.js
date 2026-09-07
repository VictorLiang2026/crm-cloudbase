/**
 * opportunities — 客户经营机会 CRUD（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:   { action:'list', customer_id } → { rows }
 *           （进行中按 updated_at 倒序在前，关闭在后）
 *   create: { action:'create', data:{ customer_id, opportunity_type, status?, discovered_at?, last_progress?, next_action?, ai_summary?,
 *                                     referred_name?, referred_relation?（转介绍线索：被介绍人/关系） } } → { id }
 *   update: { action:'update', id, data:{ ...同上增量 } } → { ok }
 *   close:  { action:'close', id } → { ok }（status 置为'关闭'）
 *   remove: { action:'remove', id } → { ok }（软删除，置 deleted_at）
 * 转介绍线索（v1.4）：opportunity_type='转介绍' 复用本表，customer_id=来源客户；
 *   状态机为转介绍专属：潜在线索/已介绍/已联系/已建立关系/成交/关闭（其余类型用 发现/沟通/方案/成交/关闭）；
 *   referred_name=被介绍人姓名，referred_relation=与来源客户关系，next_action=下一步。
 * 枚举校验：类型/状态超出词表直接报错，不静默改写。
 * 注意：opportunities.created_at / updated_at 有 now() 默认值，仍手动写入保持与 followups 一致。
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

var TYPE_ENUM = ['医疗保障', '重疾保障', '养老规划', '教育规划', '财富规划', '家庭保障', '转介绍'];
var STATUS_ENUM = ['发现', '沟通', '方案', '成交', '关闭'];
var REF_STATUS_ENUM = ['潜在线索', '已介绍', '已联系', '已建立关系', '成交', '关闭'];

function isReferral(type) { return type === '转介绍'; }
// 按机会类型校验状态；返回错误串或 null
function statusError(type, status) {
  if (!status) return null;
  var allowed = isReferral(type) ? REF_STATUS_ENUM : STATUS_ENUM;
  return allowed.indexOf(status) < 0 ? ('无效的机会状态：' + status) : null;
}

const FIELDS = [
  'customer_id', 'opportunity_type', 'status', 'discovered_at',
  'last_progress', 'next_action', 'ai_summary',
  'referred_name', 'referred_relation',
];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':   return await list(event);
      case 'create': return await create(event);
      case 'update': return await update(event);
      case 'close':  return await close(event);
      case 'remove': return await remove(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

// 日期格式校验（轻量：仅格式，交给 PG 判真实日期）
function normDate(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    throw new Error('日期格式应为 YYYY-MM-DD：' + v);
  }
  return v.trim();
}

async function list(event) {
  const customerId = parseInt(event.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  const r = assertOk(await rdb.from('opportunities').select()
    .eq('customer_id', customerId).is('deleted_at', null));
  var rows = r.data || [];
  // 进行中在前，关闭在后；组内按 updated_at 倒序
  var closed = [];
  var active = [];
  rows.forEach(function (o) { (o.status === '关闭' ? closed : active).push(o); });
  function byUpdatedDesc(a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); }
  active.sort(byUpdatedDesc);
  closed.sort(byUpdatedDesc);
  return { rows: active.concat(closed) };
}

async function create(event) {
  const data = Object.assign({}, event.data || {});
  const customerId = parseInt(data.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  if (TYPE_ENUM.indexOf(data.opportunity_type) < 0) {
    return { error: '无效的机会类型：' + data.opportunity_type };
  }
  var se = statusError(data.opportunity_type, data.status);
  if (se) return { error: se };
  const c = assertOk(await rdb.from('customers').select('Id').eq('Id', customerId)
    .is('deleted_at', null).maybeSingle());
  if (!c.data) return { error: 'customer not found' };
  data.discovered_at = normDate(data.discovered_at);
  if (!data.status) data.status = isReferral(data.opportunity_type) ? '潜在线索' : '发现';
  data.created_at = nowIso();
  data.updated_at = nowIso();
  const payload = normFields(data, FIELDS.concat(['created_at', 'updated_at']));
  const r = assertOk(await rdb.from('opportunities').insert(payload).select('id'));
  return { id: r.data[0].id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const data = Object.assign({}, event.data || {});
  if (data.opportunity_type && TYPE_ENUM.indexOf(data.opportunity_type) < 0) {
    return { error: '无效的机会类型：' + data.opportunity_type };
  }
  // 状态校验按"更新后的类型"：data 带了类型用新类型，否则取记录现有类型
  var effType = data.opportunity_type;
  if (!effType && data.status) {
    const ex = assertOk(await rdb.from('opportunities').select('opportunity_type').eq('id', id).maybeSingle());
    effType = ex.data ? ex.data.opportunity_type : null;
  }
  if (data.status) {
    var se = statusError(effType, data.status);
    if (se) return { error: se };
  }
  if (Object.prototype.hasOwnProperty.call(data, 'discovered_at')) {
    data.discovered_at = normDate(data.discovered_at);
  }
  const payload = normFields(
    Object.assign({}, data, { updated_at: nowIso() }),
    FIELDS.concat(['updated_at'])
  );
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('opportunities').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

async function close(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('opportunities')
    .update({ status: '关闭', updated_at: nowIso() }).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('opportunities')
    .update({ deleted_at: nowIso(), updated_at: nowIso() }).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}
