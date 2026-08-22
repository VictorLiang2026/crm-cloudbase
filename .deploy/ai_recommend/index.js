/**
 * ai_recommend — AI 跟进建议生成（事件云函数，超时 120s，rdb() 版）
 * 入参 event: { customer_id }
 * 流程：拉取客户 + 最近跟进 + 产品额度 + 礼品 → 构建 prompt → hy3 生成 → 解析 JSON → 写 ai_recommendations
 * 出参: { id, recommendation, raw }
 *   - id: ai_recommendations.id
 *   - recommendation: { suggested_message, suggested_strategy, suggested_followup_date,
 *                       suggested_customer_stage, suggested_followup_goal }
 *   - raw: 模型原始输出文本
 *
 * AI 仅用 hy3（app.ai().createModel('cloudbase')）。
 */
'use strict';

const { rdb, generateText, extractJson, assertOk } = require('./db');

const SYSTEM = [
  '你是资深保险/财富管理顾问。根据客户资料生成下一次跟进建议。',
  '输出 JSON，字段：',
  'suggested_message(建议发送的问候/沟通信息，50-150字),',
  'suggested_strategy(跟进策略要点，文本),',
  'suggested_followup_date(建议跟进日期 YYYY-MM-DD),',
  'suggested_customer_stage(建议客户经营阶段:新认识/关系维护/需求挖掘/方案沟通/成交推进/转介绍经营),',
  'suggested_followup_goal(建议跟进目标:建立联系/约见面/邀请活动/获取家庭信息/推进签单/推进招募/推进转介绍)。',
  '只输出 JSON，不要解释。',
].join('\n');

exports.main = async (event, context) => {
  try {
    const customerId = parseInt(event && event.customer_id, 10);
    if (!customerId) return { error: 'customer_id required' };

    // 拉取客户上下文
    const c = assertOk(await rdb.from('customers').select().eq('Id', customerId).is('deleted_at', null).maybeSingle());
    if (!c.data) return { error: 'customer not found' };
    const customer = c.data;

    const [fol, prod, gif] = await Promise.all([
      rdb.from('followups').select().eq('customer_id', customerId)
        .order('followup_date', { ascending: false, nullsFirst: false })
        .order('Id', { ascending: false })
        .limit(5),
      rdb.from('products').select().eq('customer_id', customerId),
      rdb.from('gifts').select().eq('customer_id', customerId)
        .order('given_date', { ascending: false, nullsFirst: false })
        .order('Id', { ascending: false })
        .limit(5),
    ]);
    const folRows = assertOk(fol).data || [];
    const prodRows = assertOk(prod).data || [];
    const gifRows = assertOk(gif).data || [];

    const ctx = {
      customer: {
        name: customer.customer_name, gender: customer.gender, birthday: customer.birthday,
        stage: customer.customer_stage, priority: customer.sales_priority,
        occupation: customer.occupation, hobbies: customer.hobbies,
        marital: customer.marital_status, phone: customer.phone,
        info: customer.additional_info,
      },
      recent_followups: folRows.map(function (f) {
        return { date: f.followup_date, notes: f.followup_notes, next_date: f.next_followup_date, next_goal: f.next_followup_goal };
      }),
      products: prodRows.map(function (p) {
        return { ap_ipa: p.ap_ipa, ap_life: p.ap_life, ap_ann: p.ap_ann, ap_all: p.ap_all };
      }),
      recent_gifts: gifRows.map(function (g) {
        return { name: g.gift_name, date: g.given_date };
      }),
    };

    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: '客户资料：\n' + JSON.stringify(ctx, null, 2) },
    ];
    const { text: raw } = await generateText(messages, { timeout: 120000 });
    const parsed = extractJson(raw) || {};

    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      customer_id: customerId,
      customer_name: customer.customer_name,
      recommendation_date: today,
      suggested_followup_date: parsed.suggested_followup_date || null,
      suggested_message: parsed.suggested_message || null,
      suggested_strategy: parsed.suggested_strategy || null,
      suggested_customer_stage: parsed.suggested_customer_stage || null,
      suggested_followup_goal: parsed.suggested_followup_goal || null,
    };
    const r = assertOk(await rdb.from('ai_recommendations').insert(payload).select('id'));

    return { id: r.data[0].id, recommendation: parsed, raw: raw };
  } catch (e) {
    return { error: e.message };
  }
};
