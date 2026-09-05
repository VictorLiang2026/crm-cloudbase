/**
 * policy_review_reports — 保单检视报告（每客户可生成多份，CRUD + AI 生成）
 * 入参 event: { action, ... }
 *   list:     { action:'list', customer_id } → { rows }（按 report_date DESC, id DESC，全字段）
 *   get:      { action:'get', id }           → { report }（单条完整）
 *   update:   { action:'update', id, data:{ edited_summary?, edited_gaps?, edited_recommendations?, edited_asset_allocation?, edited_next_action?, report_type?, report_date? } } → { ok }
 *   remove:   { action:'remove', id }        → { ok }（硬删除）
 *   generate: { action:'generate', customer_id, operator? }
 *             → 拉客户 + 保单 + 跟进 + 礼品 + 历史报告 + 照片
 *               → hy3 生成 5 段检视 JSON（summary/gaps_found/recommendations/asset_allocation/next_action）
 *               → 写入 policy_review_reports → { id, report, raw }
 */
'use strict';

const { rdb, generateText, extractJson, normFields, assertOk, nowIso } = require('./db');

// 允许 update 写入的字段（编辑字段双写区 + 少量元数据）
const EDIT_FIELDS = [
  'edited_summary', 'edited_gaps', 'edited_recommendations',
  'edited_asset_allocation', 'edited_next_action',
  'report_type', 'report_date',
];

// 新建时的生成字段白名单
const CREATE_FIELDS = [
  'customer_id', 'customer_name', 'report_date', 'report_type',
  'gaps_found', 'recommendations', 'asset_allocation', 'next_action',
  'summary', 'raw',
];

const OPERATOR_DEFAULT = { name: 'Victor', gender: '男', birthday: '1976-10' };

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':     return await list(event);
      case 'get':      return await get(event);
      case 'update':   return await update(event);
      case 'remove':   return await remove(event);
      case 'generate': return await generate(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

async function list(event) {
  const customerId = parseInt(event.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  const r = assertOk(await rdb.from('policy_review_reports').select()
    .eq('customer_id', customerId).is('deleted_at', null)
    .order('report_date', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false }));
  return { rows: r.data || [] };
}

async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('policy_review_reports').select().eq('id', id).maybeSingle());
  if (!r.data) return { error: 'not found' };
  return { report: r.data };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const payload = normFields(Object.assign({}, event.data || {}), EDIT_FIELDS);
  payload.updated_at = nowIso();
  if (!Object.keys(payload).length) return { error: 'no valid fields' };
  assertOk(await rdb.from('policy_review_reports').update(payload).eq('id', id).select('id'));
  return { ok: true };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('policy_review_reports').delete().eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

// ---------- AI 检视报告生成 ----------
function buildSystem(operator) {
  return [
    '你是资深人寿保险家庭保单检视专家 + 财富管理顾问。根据客户资料与已有保单配置，出具一份结构化的家庭保单检视报告。',
    '【操作员】' + operator.name + '，性别：' + operator.gender + '，出生年月：' + operator.birthday + '。',
    '【必须遵循的检视方法论】',
    '1. 保险需求金字塔优先级（先保障后理财）：定期寿险（家庭责任）→ 重疾险（收入损失补偿）→ 医疗险（大额医疗风险）→ 意外险（残疾/身故）→ 长期护理险（失能护理）→ 健康管理服务 → 终身寿险（财富传承/杠杆）→ 年金险（现金流/养老）→ 万能险（灵活储蓄）→ 个人养老金 PPA（第三支柱养老）。缺底层保障时不得先建议上层理财。',
    '2. 「双十原则」：合理总保额 ≈ 家庭年收入 × 10 倍；合理总年交保费 ≈ 家庭年收入 × 10%（波动范围 8%~15%，超 20% 必须提示保费压力）。',
    '3. 家庭责任期估算：到最小子女独立/房贷还清/父母赡养结束的年数，对应定期寿险/意外险的保额倍数建议。',
    '4. 标准普尔家庭资产象限图：现金账户（10%，3-6个月开销）、保障账户（20%，保费保额杠杆）、投资账户（30%，风险增值）、保本账户（40%，年金/终身寿/养老金，长期安全）。如能从客户信息推断大致分布则给出优化方向。',
    '5. 险种结构健康度：保障型保额占总保额(ALL)的比例（定期寿+重疾+医疗+意外+长护）应 ≥ 70%，否则提示「偏理财、轻保障」风险。',
    '6. 家庭成员保障覆盖：若客户信息显示有配偶/子女，必须检视「家庭各成员保障是否齐全、是否有经济支柱裸奔」的风险提示。',
    '【输出 JSON 字段（只输出 JSON，不要解释）】',
    'summary(综合摘要：120~200字，突出客户保障亮点+总体判断，称呼客户姓+先生/女士),',
    'gaps_found(保障缺口/问题清单：2-6条，每条编号，明确严重度「严重/一般/轻微」+具体缺口事实+量化依据，如「定期寿险保额仅为年收入3倍，距离10倍建议缺口XX万」),',
    'recommendations(检视建议：2-6条，逐条对应缺口，给出具体险种/保额/保费方向建议，可含客户可理解的配置优先级排序),',
    'asset_allocation(保费与资产配置优化建议：基于双十原则+普尔象限，指出当前保费是否合理、资产分布是否偏科，给出分步调整路径),',
    'next_action(下一步行动建议：1-3条可执行事项，含建议约访方式、要带的资料、要问的关键问题，便于操作员立刻落地，要符合操作员与客户称呼规则)',
  ].join('\n');
}

const HISTORY_HINT = '以下是该客户的历史保单检视报告（按时间倒序）。请避免重复，体现递进：指出上一次缺口是否有填补、建议是否落实，未落实要说明原因并给出更务实的替代路径，同时新增本次发现的变化点：';

async function generate(event) {
  const customerId = parseInt(event && event.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };

  const c = assertOk(await rdb.from('customers').select().eq('Id', customerId).is('deleted_at', null).maybeSingle());
  if (!c.data) return { error: 'customer not found' };
  const customer = c.data;

  // 拉上下文：保单、跟进、礼品、历史检视报告、照片
  const [prod, fol, gif, hist, photos] = await Promise.all([
    rdb.from('products').select().eq('customer_id', customerId),
    rdb.from('followups').select().eq('customer_id', customerId)
      .order('followup_date', { ascending: false, nullsFirst: false })
      .order('Id', { ascending: false })
      .limit(5),
    rdb.from('gifts').select().eq('customer_id', customerId)
      .order('given_date', { ascending: false, nullsFirst: false })
      .order('Id', { ascending: false })
      .limit(3),
    rdb.from('policy_review_reports').select(
      'id,report_date,report_type,summary,gaps_found,recommendations,asset_allocation,next_action'
    ).eq('customer_id', customerId)
      .order('report_date', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(3),
    rdb.from('photos').select('file_name,photo_notes,created_at').eq('customer_id', customerId)
      .order('created_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(3),
  ]);
  const prodRows = assertOk(prod).data || [];
  const folRows = assertOk(fol).data || [];
  const gifRows = assertOk(gif).data || [];
  const histRows = assertOk(hist).data || [];
  const photoRows = assertOk(photos).data || [];

  // 解析保单 items 明细
  const products = prodRows.map(function (p) {
    let items = null;
    if (p.items) { try { items = JSON.parse(p.items); } catch (e) { items = null; } }
    return {
      ap_ipa: p.ap_ipa, ap_ppa: p.ap_ppa, ap_ltc: p.ap_ltc, ap_ann: p.ap_ann,
      ap_life: p.ap_life, ap_term: p.ap_term, ap_wl: p.ap_wl, ap_pa: p.ap_pa,
      ap_ci: p.ap_ci, ap_hi: p.ap_hi, ap_all: p.ap_all,
      items_detail: items,
    };
  });

  // 操作员信息
  const opIn = (event && event.operator) || {};
  const operator = {
    name: opIn.name || OPERATOR_DEFAULT.name,
    gender: opIn.gender || OPERATOR_DEFAULT.gender,
    birthday: opIn.birthday || OPERATOR_DEFAULT.birthday,
  };

  const ctx = {
    today: new Date().toISOString().slice(0, 10),
    operator: operator,
    customer: {
      name: customer.customer_name, gender: customer.gender, birthday: customer.birthday,
      stage: customer.customer_stage, priority: customer.sales_priority,
      occupation: customer.occupation, income: customer.annual_income,
      marital: customer.marital_status, children: customer.children_info,
      house: customer.properties_info, phone: customer.phone,
      info: customer.additional_info,
      first_contact: customer.first_contact_date,
    },
    policies: products,
    recent_followups: folRows.map(function (f) {
      return { date: f.followup_date, notes: f.followup_notes, next_date: f.next_followup_date, next_goal: f.next_followup_goal };
    }),
    recent_gifts: gifRows.map(function (g) { return { name: g.gift_name, date: g.given_date }; }),
    recent_photos: photoRows.map(function (p) { return { file: p.file_name, notes: p.photo_notes, date: p.created_at }; }),
    history_reports: histRows.map(function (h) {
      return {
        date: h.report_date, type: h.report_type,
        summary: h.summary, gaps: h.gaps_found, recs: h.recommendations,
        asset: h.asset_allocation, next: h.next_action,
      };
    }),
  };

  let userContent = '客户与保单资料：\n' + JSON.stringify(ctx, null, 2);
  if (histRows.length) {
    userContent += '\n\n' + HISTORY_HINT + '\n' + JSON.stringify(ctx.history_reports, null, 2);
  }

  const messages = [
    { role: 'system', content: buildSystem(operator) },
    { role: 'user', content: userContent },
  ];
  const { text: raw } = await generateText(messages, { timeout: 120000 });
  const parsed = extractJson(raw) || {};

  const today = new Date().toISOString().slice(0, 10);
  const payload = normFields({
    customer_id: customerId,
    customer_name: customer.customer_name,
    report_date: today,
    report_type: '保单年度检视',
    summary: parsed.summary || null,
    gaps_found: parsed.gaps_found || null,
    recommendations: parsed.recommendations || null,
    asset_allocation: parsed.asset_allocation || null,
    next_action: parsed.next_action || null,
    raw: raw || null,
  }, CREATE_FIELDS);

  if (!payload.summary && !payload.gaps_found && !payload.recommendations) {
    // 即使解析失败，也保存原始输出，便于排查
    payload.summary = '（模型输出非标准JSON，请人工查看 raw 后补录）';
  }
  const r = assertOk(await rdb.from('policy_review_reports').insert(payload).select('id'));
  const id = r.data[0].id;
  const full = assertOk(await rdb.from('policy_review_reports').select().eq('id', id).maybeSingle());
  return { id: id, report: full.data, raw: raw };
}
