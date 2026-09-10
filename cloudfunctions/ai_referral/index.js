/**
 * ai_referral — AI 转介绍建议（事件云函数，超时 120s，rdb() 版）
 * 入参 event: { customer_id, operator? }
 *
 * v1.4 轻量转介绍经营：AI 只建议、不写库；用户确认后由前端：
 *   ① opportunities create（opportunity_type='转介绍'，status='潜在线索'）
 *   ② ai_recommendations create（NBA，goal=推进转介绍）
 *
 * 判断依据：客户近期关系变化（阶段/跟进频率）、最近沟通结果、成交情况（products）、
 *           服务情况（gifts）、活动情况（activity_participants）、客户画像（职业/家庭/附加信息）。
 * 出参: { suggestion: { suitable, confidence, reason, timing, approach, message, nba }, raw }
 *   - suitable=false 时仅给 reason（为什么暂不适合），前端不显示确认按钮。
 */
'use strict';

const { rdb, generateText, extractJson, assertOk } = require('./db');
const aiStd = require('./ai');

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

exports.main = async (event, context) => {
  try {
    const customerId = parseInt(event && event.customer_id, 10);
    if (!customerId) return { error: 'customer_id required' };

    const c = assertOk(await rdb.from('customers').select().eq('Id', customerId)
      .is('deleted_at', null).maybeSingle());
    if (!c.data) return { error: 'customer not found' };
    const customer = c.data;

    const [fol, prod, gif, parts, refOpp] = await Promise.all([
      rdb.from('followups').select('followup_date, followup_notes, next_followup_goal')
        .eq('customer_id', customerId).is('deleted_at', null)
        .order('followup_date', { ascending: false }).limit(8),
      rdb.from('products').select('ap_all').eq('customer_id', customerId),
      rdb.from('gifts').select('gift_name, given_date').eq('customer_id', customerId)
        .order('given_date', { ascending: false, nullsFirst: false }).limit(5),
      // 活动参与情况（v1.3 activities）
      rdb.from('activity_participants').select('activity_id, status, created_at')
        .eq('person_type', 'customer').eq('person_id', customerId).is('deleted_at', null)
        .order('created_at', { ascending: false }).limit(10),
      // 现有转介绍线索（避免重复建议）
      rdb.from('opportunities').select('status, referred_name, updated_at')
        .eq('customer_id', customerId).eq('opportunity_type', '转介绍').is('deleted_at', null)
        .order('updated_at', { ascending: false }),
    ]);

    const folRows = assertOk(fol).data || [];
    const prodRows = assertOk(prod).data || [];
    const gifRows = assertOk(gif).data || [];
    const partRows = assertOk(parts).data || [];
    const refRows = assertOk(refOpp).data || [];

    // 活动名称补齐
    let actRows = [];
    if (partRows.length) {
      const actIds = partRows.map(function (p) { return p.activity_id; }).filter(Boolean);
      if (actIds.length) {
        const a = assertOk(await rdb.from('activities').select('id, name, activity_date, activity_type')
          .in('id', actIds).is('deleted_at', null));
        actRows = a.data || [];
      }
    }
    const actMap = {};
    actRows.forEach(function (a) { actMap[a.id] = a; });
    const activities = partRows.map(function (p) {
      const a = actMap[p.activity_id] || {};
      return { name: a.name || '', type: a.activity_type || '', date: a.activity_date ? String(a.activity_date).slice(0, 10) : '', attend: p.status };
    }).filter(function (a) { return a.name; });

    const activeRef = refRows.filter(function (o) { return o.status && o.status !== '关闭' && o.status !== '成交'; });
    const totalCover = prodRows.reduce(function (s, p) { return s + (Number(p.ap_all) || 0); }, 0);

    const ctx = {
      today: new Date().toISOString().slice(0, 10),
      customer: {
        name: customer.customer_name, gender: customer.gender, birthday: customer.birthday,
        stage: customer.customer_stage, priority: customer.sales_priority,
        referral_priority: customer.referral_priority,
        occupation: customer.occupation, hobbies: customer.hobbies,
        marital: customer.marital_status, children: customer.children_info,
        info: customer.additional_info,
      },
      recent_followups: folRows.map(function (f) {
        return { date: f.followup_date ? String(f.followup_date).slice(0, 10) : '', notes: clip(f.followup_notes, 200), goal: f.next_followup_goal || '' };
      }),
      deals: { policy_count: prodRows.length, total_cover: totalCover || null },
      recent_services: gifRows.map(function (g) { return { name: g.gift_name, date: g.given_date ? String(g.given_date).slice(0, 10) : '' }; }),
      activities: activities,
      existing_referral_leads: activeRef.map(function (o) { return { referred_name: o.referred_name || '', status: o.status }; }),
    };

    const system = [
      '你是资深保险团队长 Victor 的转介绍经营顾问。根据给定客户资料，判断当前是否适合向该客户尝试转介绍，并给出具体经营建议。',
      '【判断维度（必须综合，严禁编造资料中没有的信息）】',
      '1. 关系变化：客户阶段（转介绍经营/成交推进阶段更佳）、跟进频率与互动温度；',
      '2. 最近沟通结果：跟进记录中是否有满意表达、主动咨询、转介绍意愿信号；',
      '3. 成交情况：持有保单数量/保额，已成交且理赔/服务体验好的客户更适合；',
      '4. 服务情况：近期是否有礼品/服务动作，服务后是自然的转介绍时机；',
      '5. 活动情况：是否参加过客户活动（活动后 1-2 周是转介绍黄金窗口）；',
      '6. 客户画像：职业（教师/医生/公务员/企业主等社交节点型职业加分）、家庭与社交圈。',
      '【已有转介绍线索】existing_referral_leads 非空时：不要建议"重新开口"，应建议推进现有线索（按其状态给下一步）。',
      '【输出 JSON，字段】',
      'suitable: boolean（当前是否适合主动尝试转介绍；关系薄弱/刚认识/有未处理不满时 false）',
      'confidence: "高"|"中"|"低"',
      'reason: 判断依据，2-3句，必须引用具体资料信号（如"参加了9月酒会且近期互动频繁"），不超过120字',
      'timing: 推荐时机（什么时候开口最自然，如"本次保单服务完成后/活动后一周内/下次见面茶歇时"），不超过40字',
      'approach: 推荐切入方式（怎么自然引出，不引起反感），1-2句，不超过80字',
      'message: 推荐话术（微信可直接发送的口语化话术，称呼自然，50-120字；suitable=false 时为空串）',
      aiStd.nbaPromptBlock(true),
      '- nba 必须围绕“推进转介绍”（suitable=false 时围绕“为转介绍铺垫”），nba.goal 与该主题一致，nba.script 与 message 口径一致。',
      '【必填要求】无论 suitable 为 true 还是 false，reason/timing/approach/nba 各字段都必须非空：suitable=false 时，timing 给出“何时再评估/开口”（如“等保单成交或下次活动后”），approach 给出“现阶段铺垫动作”（如何先升温关系）；只有 message 在 suitable=false 时为空串。',
      aiStd.GUARDRAILS,
      '只输出 JSON，不要解释。',
    ].join('\n');

    const { text: raw } = await generateText([
      { role: 'system', content: system },
      { role: 'user', content: '客户资料：\n' + JSON.stringify(ctx, null, 2) },
    ], { timeout: 120000 });

    const parsed = extractJson(raw) || {};
    var suitable = parsed.suitable === true;
    // NBA 统一走标准清洗（9 字段 + 兼容旧 6 字段）；模型缺失时用保守兜底（不编造客户信息）
    var nba = aiStd.normNba(parsed.nba, { legacy: true, priority: suitable ? 'medium' : 'low' });
    if (!nba) {
      nba = aiStd.normNba(suitable
        ? {
            action: '选择自然时机开口，请客户帮忙介绍身边有需要的朋友',
            reason: '客户关系信号积极，适合尝试自然转介绍',
            goal: '推进转介绍', topic: '转介绍',
            avoid: '生硬索取名单，引起客户反感',
            success_criteria: '客户愿意提供 1-2 个被介绍人线索',
            channel: '面谈', priority: 'medium', confidence: 'low', evidence: [],
          }
        : {
            action: '保持规律联络，借服务/活动自然增加接触',
            reason: clip(parsed.reason, 160) || '当前关系基础尚不足以开口转介绍',
            goal: '先升温关系，为未来转介绍铺垫', topic: '关系维护',
            avoid: '现阶段不要提转介绍或保险推销',
            success_criteria: '关系升温（成交/服务/共同活动）后再评估',
            channel: '微信', priority: 'low', confidence: 'low', evidence: [],
          }, { legacy: true });
    }
    var timing = clip(parsed.timing, 80);
    var approach = clip(parsed.approach, 160);
    if (!suitable) {
      if (!timing) timing = '等关系升温（成交/服务/活动）后再评估';
      if (!approach) approach = '现阶段先保持自然联络与价值输出，不主动提转介绍';
    }

    const suggestion = {
      suitable: suitable,
      confidence: ['高', '中', '低'].indexOf(parsed.confidence) >= 0 ? parsed.confidence : '中',
      reason: clip(parsed.reason, 200) || (suitable ? '客户关系信号积极' : '当前关系基础尚不足以开口转介绍'),
      timing: timing,
      approach: approach,
      message: suitable ? clip(parsed.message, 300) : '',
      nba: nba,
    };
    return { suggestion: suggestion, raw: raw };
  } catch (e) {
    return { error: e.message };
  }
};
