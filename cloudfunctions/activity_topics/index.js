/**
 * activity_topics — 活动主题资源池（v1.7.4 Activity Topic Pool）
 *
 * actions:
 *   list    {keyword?, status?}                        → { rows:[主题全字段] }  （名称/分类/描述/目标人群/关键词 模糊 + 状态筛选）
 *   get     {id}                                        → { topic }
 *   create  {data:{topic_name, ...}}                    → { id }
 *   update  {id, data:{...}}                            → { ok:true }
 *   remove  {id}                                        → { ok:true }  （软删除：置 deleted_at）
 *   search  {keyword}                                   → { rows:[{id,topic_name,category,target_audience,use_count,last_used_date}] }
 *                                                            （活动选择主题时的联想：仅 active）
 *
 * 约束：status 枚举校验；use_count/last_used_date 为统计字段，不由表单写入，
 *       仅由 activities.applyTopics 在用户确认主题用于活动时维护（+1 / 更新最近使用日期）。
 * keywords 为 jsonb 字符串数组：字符串按逗号拆分，数组过滤非空。
 */
'use strict';

const { rdb, normFields, assertOk, nowIso } = require('./db');

const TP_FIELDS = ['topic_name', 'category', 'description', 'target_audience',
  'keywords', 'status', 'ai_summary', 'notes'];
const STATUS_ENUM = ['active', 'inactive'];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':    return await list(event);
      case 'get':     return await get(event);
      case 'create':  return await create(event);
      case 'update':  return await update(event);
      case 'remove':  return await remove(event);
      case 'search':  return await search(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

// 枚举/字段校验 + keywords 归一化（create/update 共用）
function normTopic(data) {
  const d = Object.assign({}, data || {});
  if (d.status && STATUS_ENUM.indexOf(d.status) < 0) {
    return { error: '无效 status，允许: ' + STATUS_ENUM.join('/') };
  }
  // keywords：字符串 → 逗号拆分；数组 → 过滤；最终保证为字符串数组
  if (d.keywords != null) {
    let arr;
    if (Array.isArray(d.keywords)) {
      arr = d.keywords;
    } else if (typeof d.keywords === 'string') {
      arr = d.keywords.split(',');
    } else {
      arr = [];
    }
    d.keywords = arr.map(function (k) { return String(k).trim(); })
      .filter(Boolean).slice(0, 20);
  }
  // 统计字段不允许通过表单写入
  delete d.use_count;
  delete d.last_used_date;
  return { data: d };
}

// 全字段关键词匹配（名称/分类/描述/目标人群/备注/关键词数组）
// 注：postgrest 的 or() 逻辑树不支持 jsonb 列 ::text cast，主题池数据量小，直接在 JS 层过滤
function topicMatches(t, kwLower) {
  const hay = [t.topic_name, t.category, t.description, t.target_audience, t.notes,
    (Array.isArray(t.keywords) ? t.keywords.join(' ') : '')]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.indexOf(kwLower) >= 0;
}

async function list(event) {
  let q = rdb.from('activity_topics').select().is('deleted_at', null);
  if (event.status) q = q.eq('status', event.status);
  const r = assertOk(await q.order('updated_at', { ascending: false }).limit(200));
  let rows = r.data || [];
  const kw = String(event.keyword || '').trim().toLowerCase();
  if (kw) rows = rows.filter(function (t) { return topicMatches(t, kw); });
  return { rows: rows };
}

async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('activity_topics').select()
    .eq('id', id).is('deleted_at', null).maybeSingle());
  if (!r.data) return { error: 'topic not found' };
  return { topic: r.data };
}

async function create(event) {
  const n = normTopic(event.data);
  if (n.error) return n;
  const d = n.data;
  if (!d.topic_name || !String(d.topic_name).trim()) return { error: 'topic_name required' };
  d.created_at = nowIso();
  d.updated_at = nowIso();
  const payload = normFields(d, TP_FIELDS.concat(['created_at', 'updated_at']));
  const r = assertOk(await rdb.from('activity_topics').insert(payload).select('id'));
  return { id: r.data[0].id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const n = normTopic(event.data);
  if (n.error) return n;
  n.data.updated_at = nowIso();
  const payload = normFields(n.data, TP_FIELDS.concat(['updated_at']));
  const r = assertOk(await rdb.from('activity_topics').update(payload)
    .eq('id', id).is('deleted_at', null).select('id'));
  if (!r.data || !r.data.length) return { error: 'topic not found' };
  return { ok: true };
}

// 软删除（资源池数据可复用，不物理删除；历史活动 topic_ids 引用不受影响）
async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  assertOk(await rdb.from('activity_topics')
    .update({ deleted_at: nowIso(), updated_at: nowIso() })
    .eq('id', id));
  return { ok: true };
}

// 联想搜索（供活动选择主题弹窗）：全字段匹配；仅 active；返回精简字段
async function search(event) {
  const kw = String(event.keyword || '').trim().toLowerCase();
  if (kw.length < 1) return { rows: [] };
  const r = assertOk(await rdb.from('activity_topics')
    .select('id, topic_name, category, target_audience, use_count, last_used_date, keywords, description')
    .is('deleted_at', null)
    .eq('status', 'active')
    .limit(200));
  const rows = (r.data || [])
    .filter(function (t) { return topicMatches(t, kw); })
    .slice(0, 10)
    .map(function (t) {
      return {
        id: t.id, topic_name: t.topic_name, category: t.category,
        target_audience: t.target_audience, use_count: t.use_count, last_used_date: t.last_used_date,
      };
    });
  return { rows: rows };
}
