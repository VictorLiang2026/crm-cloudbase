/**
 * ai_recommend — AI 跟进建议生成（事件云函数，超时 120s，rdb() 版）
 * 入参 event: { customer_id, operator? }
 *   - operator: { name, gender, birthday } 操作员信息（前端传入，用于称呼规则与长幼判断）
 * 流程：拉取客户 + 最近跟进 + 保单(products) + 礼品 + 历史AI建议 + 照片 + 最近保单检视报告
 *        → 构建 prompt（含保险金字塔/双十原则/普尔象限等资产配置方法论）
 *        → hy3 生成 → 解析 JSON → 写 ai_recommendations
 *        → 若该客户有历史保单检视报告，必须纳入 gaps/recommendations/asset_allocation 分析，体现递进诊断
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

// 操作员默认信息（前端未传时兜底）
const OPERATOR_DEFAULT = { name: 'Victor', gender: '男', birthday: '1976-10' };

function buildSystem(op) {
  return [
    '你是资深人寿保险/财富管理顾问。根据客户资料为操作员生成下一次跟进建议。',
    '【操作员】' + op.name + '，性别：' + op.gender + '，出生年月：' + op.birthday + '。与客户沟通时的称呼必须符合双方长幼与关系（见称呼规则）。',
    '【称呼规则（suggested_message 中对客户的称呼必须严格遵守）】',
    '1. 知道客户出生/年龄，且与操作员有学校校友、同门等关系：客户比操作员年长，男称"姓+师兄"、女称"姓+师姐"；客户更年轻或同龄，男称"姓+师弟"、女称"姓+师妹"。',
    '2. 知道客户出生/年龄但无学校校友关系：男称"姓+先生"、女称"姓+女士"。',
    '3. 不知道客户年龄，但客户资料中有学校/校友信息：男称"姓+师弟"、女称"姓+师妹"。',
    '4. 不知道年龄也无学校信息：男称"姓+先生"、女称"姓+女士"。',
    '5. 不确定客户性别：禁止使用性别化称呼，用"您"或客户姓名。',
    '6. 严禁性别错称（如女性客户称"师兄/先生"，男性客户称"师姐/女士"）。',
    '【家庭保单检视与资产配置方法论（必须体现在 suggested_strategy 中）】',
    '① 保险需求金字塔优先级（先保障后理财）：定期寿险→重疾险→医疗险→意外险→长期护理险→健康管理→终身寿险→年金险→万能险→个人养老金PPA。缺少底层保障不得优先推荐上层理财。',
    '② 双十原则：合理总保额≈家庭年收入×10倍；合理总年交保费≈家庭年收入×10%（允许波动8%~15%，超20%提示保费压力）。',
    '③ 家庭责任期：到最小子女独立/房贷还清/父母赡养结束的年数，对应定期寿险与意外险的保额倍数建议。',
    '④ 标准普尔家庭资产象限图：现金账户(10%, 3-6个月支出)、保障账户(20%, 保费杠杆)、投资账户(30%, 风险增值)、保本账户(40%, 年金/终身寿/养老金长期安全)。',
    '⑤ 险种结构健康度：保障型保额(定期寿+重疾+医疗+意外+长护)占总保额比例应≥70%，低于则提示「偏理财、轻保障」风险。',
    '⑥ 家庭成员覆盖：若客户信息显示有配偶/子女，必须提示「家庭支柱是否裸奔、配偶子女保障是否齐全」的检查项。',
    '【保单检视报告处理规则】',
    '• 当客户信息中提供了历史保单检视报告(policy_reviews 数组)时：必须逐份引用其中的 gaps_found(缺口)、recommendations(建议)、asset_allocation(资产配置建议)，在 suggested_strategy 中体现递进诊断——已填补的缺口给予正向肯定并进入下一层配置，未填补的要说明原因并给出更务实的替代方案；客户若从未做过保单检视，suggested_strategy 中必须首先建议「安排一次家庭保单检视会面」，话术与约访方式纳入 suggested_message。',
    '【保险综合方案与转介绍/招募】',
    '- 结合跟进记录、附加信息中的家庭成员/职业/收入/咨询问题/购买意向/对职业满意度，给出针对性综合保障方案思路（缺口分析、产品组合、家庭保单检视步骤、预算与缴费建议）。',
    '- 同时评估转介绍与招募机会，给出可执行的话术与步骤。',
    '输出 JSON，字段：',
    'suggested_message(建议发送的问候/沟通信息，50-150字，称呼正确),',
    'suggested_strategy(跟进策略要点，含综合保障方案思路，必须引用保单检视方法论与历史报告),',
    'suggested_followup_date(建议跟进日期 YYYY-MM-DD),',
    'suggested_customer_stage(建议客户经营阶段:新认识/关系维护/需求挖掘/方案沟通/成交推进/转介绍经营),',
    'suggested_followup_goal(建议跟进目标:建立联系/约见面/邀请活动/获取家庭信息/推进签单/推进招募/推进转介绍/安排家庭保单检视)。',
    '只输出 JSON，不要解释。',
  ].join('\n');
}

// 给模型的历史建议参考说明（与 SYSTEM 分开，便于在 user 消息里拼接）
const HISTORY_HINT =
  '以下是该客户的历史 AI 跟进建议（按时间倒序，仅作参考）。请结合这些历史建议避免重复、体现递进，生成一条新的、更深入的跟进建议：';

exports.main = async (event, context) => {
  try {
    const customerId = parseInt(event && event.customer_id, 10);
    if (!customerId) return { error: 'customer_id required' };

    // 拉取客户上下文
    const c = assertOk(await rdb.from('customers').select().eq('Id', customerId).is('deleted_at', null).maybeSingle());
    if (!c.data) return { error: 'customer not found' };
    const customer = c.data;

    const [fol, prod, gif, hist, photos, prr] = await Promise.all([
      rdb.from('followups').select().eq('customer_id', customerId)
        .order('followup_date', { ascending: false, nullsFirst: false })
        .order('Id', { ascending: false })
        .limit(5),
      rdb.from('products').select().eq('customer_id', customerId),
      rdb.from('gifts').select().eq('customer_id', customerId)
        .order('given_date', { ascending: false, nullsFirst: false })
        .order('Id', { ascending: false })
        .limit(5),
      // 拉取历史 AI 建议（最近 5 条，按时间倒序）作为生成新建议的参考
      rdb.from('ai_recommendations').select(
        'recommendation_date,suggested_message,suggested_strategy,suggested_followup_date,suggested_customer_stage,suggested_followup_goal'
      ).eq('customer_id', customerId)
        .order('recommendation_date', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .limit(5),
      // 拉取照片元数据（最近 5 条）
      rdb.from('photos').select('file_name,photo_notes,created_at').eq('customer_id', customerId)
        .order('created_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .limit(5),
      // 保单检视报告（最近 3 条，按报告日期倒序）：必须纳入诊断
      rdb.from('policy_review_reports').select(
        'id,report_date,report_type,summary,gaps_found,recommendations,asset_allocation,next_action,' +
        'edited_summary,edited_gaps,edited_recommendations,edited_asset_allocation,edited_next_action'
      ).eq('customer_id', customerId)
        .order('report_date', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .limit(3),
    ]);
    const folRows = assertOk(fol).data || [];
    const prodRows = assertOk(prod).data || [];
    const gifRows = assertOk(gif).data || [];
    const histRows = assertOk(hist).data || [];
    const photoRows = assertOk(photos).data || [];
    const prrRows  = assertOk(prr).data  || [];

    // 操作员信息（前端传入，用于称呼规则）
    const opIn = (event && event.operator) || {};
    const operator = {
      name: opIn.name || OPERATOR_DEFAULT.name,
      gender: opIn.gender || OPERATOR_DEFAULT.gender,
      birthday: opIn.birthday || OPERATOR_DEFAULT.birthday,
    };

    // 优先展示 edited_*，否则原始生成字段（与前端渲染保持一致）
    function disp(report, field) {
      const e = report['edited_' + field];
      return (e != null && e !== '') ? e : report[field];
    }

    const ctx = {
      today: new Date().toISOString().slice(0, 10),
      operator: operator,
      customer: {
        name: customer.customer_name, gender: customer.gender, birthday: customer.birthday,
        stage: customer.customer_stage, priority: customer.sales_priority,
        recruitment_priority: customer.recruitment_priority, referral_priority: customer.referral_priority,
        occupation: customer.occupation, annual_income: customer.annual_income,
        household_income: customer.household_income, hobbies: customer.hobbies,
        marital: customer.marital_status, children: customer.children_info,
        properties: customer.properties_info, phone: customer.phone,
        info: customer.additional_info,
      },
      recent_followups: folRows.map(function (f) {
        return { date: f.followup_date, notes: f.followup_notes, next_date: f.next_followup_date, next_goal: f.next_followup_goal };
      }),
      products: prodRows.map(function (p) {
        // items 为 11 个险种类别的二维明细 JSON（保额/年缴保费/交费年限/已交几年/更新日期）
        var items = null;
        if (p.items) { try { items = JSON.parse(p.items); } catch (e) { items = null; } }
        return {
          ap_term: p.ap_term, ap_wl: p.ap_wl, ap_ann: p.ap_ann, ap_all: p.ap_all,
          ap_ipa: p.ap_ipa, ap_ppa: p.ap_ppa, ap_ltc: p.ap_ltc, ap_life: p.ap_life,
          ap_pa: p.ap_pa, ap_ci: p.ap_ci, ap_hi: p.ap_hi,
          items_detail: items,
        };
      }),
      recent_gifts: gifRows.map(function (g) {
        return { name: g.gift_name, date: g.given_date };
      }),
      recent_photos: photoRows.map(function (p) {
        return { file: p.file_name, notes: p.photo_notes, date: p.created_at };
      }),
      // 历史 AI 建议作为参考（倒序，最新在前）
      recent_recommendations: histRows.map(function (r) {
        return {
          date: r.recommendation_date,
          message: r.suggested_message,
          strategy: r.suggested_strategy,
          followup_date: r.suggested_followup_date,
          stage: r.suggested_customer_stage,
          goal: r.suggested_followup_goal,
        };
      }),
      // 保单检视报告（关键输入）：优先编辑后版本
      policy_reviews: prrRows.length ? prrRows.map(function (r) {
        return {
          date: r.report_date,
          type: r.report_type || '保单年度检视',
          summary: disp(r, 'summary'),
          gaps_found: disp(r, 'gaps'),
          recommendations: disp(r, 'recommendations'),
          asset_allocation: disp(r, 'asset_allocation'),
          next_action: disp(r, 'next_action'),
        };
      }) : null,
    };

    // 拼接 user 消息：客户资料 + 历史建议参考
    let userContent = '客户资料：\n' + JSON.stringify(ctx, null, 2);
    if (histRows.length) {
      userContent += '\n\n' + HISTORY_HINT + '\n' + JSON.stringify(histRows.map(function (r) {
        return {
          date: r.recommendation_date,
          message: r.suggested_message,
          strategy: r.suggested_strategy,
          followup_date: r.suggested_followup_date,
          stage: r.suggested_customer_stage,
          goal: r.suggested_followup_goal,
        };
      }), null, 2);
    }

    const messages = [
      { role: 'system', content: buildSystem(operator) },
      { role: 'user', content: userContent },
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
