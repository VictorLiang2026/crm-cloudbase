/**
 * ai_activity — AI 活动分析（事件云函数，超时 60s，rdb() 版）
 * 入参 event: { action:'analyze', activity_id }
 *   流程：拉取活动 + 参与者 → 逐个补充客户/增员信息 → hy3 分析 → 返回建议（不写库）
 * 出参: { analysis, raw }
 *   analysis: {
 *     top3: [{ person_type, person_id, name, reason, suggested_action, suggested_message, suggested_date, opportunity_type? }],
 *     no_followup: [{ person_type, person_id, name, reason }]
 *   }
 * AI 只生成建议；用户确认后才由前端调 ai_recommend/followups/opportunities 写入。
 */
'use strict';

const { rdb, generateText, extractJson, assertOk, nowIso } = require('./db');

function bjNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function todayStr() { return bjNow().toISOString().slice(0, 10); }
function clip(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; }

exports.main = async (event, context) => {
  try {
    var action = (event && event.action) || 'analyze';
    if (action !== 'analyze') return { error: 'unknown action: ' + action };

    var activityId = parseInt(event && event.activity_id, 10);
    if (!activityId) return { error: 'activity_id required' };

    // 拉取活动
    var a = assertOk(await rdb.from('activities').select()
      .eq('id', activityId).is('deleted_at', null).maybeSingle());
    if (!a.data) return { error: 'activity not found' };
    var activity = a.data;

    // 拉取参与者
    var parts = assertOk(await rdb.from('activity_participants').select()
      .eq('activity_id', activityId).is('deleted_at', null)
      .order('created_at', { ascending: true })).data || [];

    if (!parts.length) return { analysis: { top3: [], no_followup: [] }, raw: '', message: '暂无参与者' };

    // 批量拉取客户和增员信息（仅已关联的参与者有 person_id）
    var customerIds = parts.filter(function(p){ return p.person_type === 'customer' && p.person_id; }).map(function(p){ return p.person_id; });
    var recruitIds = parts.filter(function(p){ return p.person_type === 'recruit' && p.person_id; }).map(function(p){ return p.person_id; });

    var customerMap = {};
    var recruitMap = {};

    if (customerIds.length) {
      var cs = assertOk(await rdb.from('customers').select('Id, customer_name, customer_stage, sales_priority, occupation, additional_info')
        .in('Id', customerIds).is('deleted_at', null)).data || [];
      cs.forEach(function(c){ customerMap[c.Id] = c; });
    }
    if (recruitIds.length) {
      var rs = assertOk(await rdb.from('recruit_candidates').select('id, name, stage, priority, occupation')
        .in('id', recruitIds).is('deleted_at', null)).data || [];
      rs.forEach(function(r){ recruitMap[r.id] = r; });
    }

    // 客户"下次跟进日期"在 followups 表（最近一条有 next_followup_date 的记录）
    var nextFollowMap = {};
    if (customerIds.length) {
      var fqs = assertOk(await rdb.from('followups').select('customer_id, followup_date, next_followup_date')
        .in('customer_id', customerIds).is('deleted_at', null)
        .not('next_followup_date', 'is', null)
        .order('followup_date', { ascending: false })).data || [];
      fqs.forEach(function(f){
        if (!nextFollowMap[f.customer_id]) nextFollowMap[f.customer_id] = f.next_followup_date;
      });
    }

    // 组装参与者信息（未关联的暂存参与者只有姓名和活动现场状态，无客户资料）
    var participantInfo = parts.map(function(p) {
      var linked = !!p.person_id;
      var info = linked ? (p.person_type === 'customer' ? customerMap[p.person_id] : recruitMap[p.person_id]) : null;
      return {
        person_type: p.person_type,
        person_id: linked ? p.person_id : 0,
        name: info ? (info.customer_name || info.name) : (p.person_name || '未知（待关联）'),
        linked: linked,
        status: p.status,
        relationship_note: p.relationship_note || '',
        stage: info ? (info.customer_stage || info.stage || '') : '',
        priority: info ? (info.sales_priority || info.priority || '') : '',
        occupation: info ? (info.occupation || '') : '',
        additional_info: info ? (info.additional_info || '') : '',
        next_followup_date: linked && p.person_type === 'customer' ? (nextFollowMap[p.person_id] || '') : '',
      };
    });

    var today = todayStr();

    var sys = [
      '你是保险业务员的活动经营助手。业务员刚结束一场活动，你需要分析参与者情况，给出跟进建议。',
      '【活动信息】名称：' + activity.name + '；日期：' + (activity.activity_date || '未定') + '；类型：' + (activity.activity_type || '未分类') + '；地点：' + (activity.location || '未定') + '。',
      '【今天】' + today + '。',
      '【只输出 JSON】结构如下：',
      'top3: 最值得跟进的3人（数组），每人 { person_type, person_id, name, reason(1句为什么值得跟进), suggested_action(推荐动作1句), suggested_message(推荐话术2-3句), suggested_date(推荐跟进日期YYYY-MM-DD), opportunity_type(经营机会类型，可空) }；',
      '  opportunity_type 只能取：医疗保障/重疾保障/养老规划/教育规划/财富规划/家庭保障/转介绍；无明确机会给空字符串。',
      'no_followup: 暂不需要跟进的人（数组），每人 { person_type, person_id, name, reason(1句为什么暂不需要) }。',
      '【纪律】',
      '1. 只基于参与者已知信息判断，严禁编造。',
      '2. 优先推荐：参加了活动且与业务有交集/关系有升温/表达了需求的人。',
      '3. 没参加或缺席的人，除非有特殊价值，一般放 no_followup。',
      '4. suggested_message 要自然口语化，像业务员会说的话。',
      '5. linked=false 的人是"待关联"状态（库中暂无资料），信息不足，一律放 no_followup，理由注明"库中暂无资料，建议先补充客户信息"。',
      '6. 只输出 JSON，不要解释、不要 markdown。',
    ].join('\n');

    var userContent = '参与者列表（共 ' + participantInfo.length + ' 人）：\n' +
      participantInfo.map(function(p, i) {
        return (i+1) + '. [' + p.person_type + (p.linked ? ' #' + p.person_id : ' #0 待关联') + '] ' + p.name +
          '；参加状态：' + p.status +
          (p.linked ? '' : '；（库中暂无资料）') +
          (p.stage ? '；阶段：' + p.stage : '') +
          (p.priority ? '；优先级：' + p.priority : '') +
          (p.occupation ? '；职业：' + p.occupation : '') +
          (p.next_followup_date ? '；下次跟进：' + p.next_followup_date : '') +
          (p.relationship_note ? '；关系备注：' + p.relationship_note : '') +
          (p.additional_info ? '；附加信息：' + clip(p.additional_info, 100) : '');
      }).join('\n');

    var gen = await generateText([
      { role: 'system', content: sys },
      { role: 'user', content: userContent },
    ], { timeout: 60000 });

    var parsed = extractJson(gen.text) || {};
    var analysis = {
      top3: Array.isArray(parsed.top3) ? parsed.top3.map(function(p) {
        return {
          person_type: p.person_type || 'customer',
          person_id: parseInt(p.person_id, 10) || 0,
          name: clip(p.name, 30),
          reason: clip(p.reason, 80),
          suggested_action: clip(p.suggested_action, 80),
          suggested_message: clip(p.suggested_message, 200),
          suggested_date: clip(p.suggested_date, 10),
          opportunity_type: clip(p.opportunity_type, 10),
        };
      }).filter(function(p){ return p.person_id; }).slice(0, 3) : [],
      // no_followup 保留待关联者（person_id=0），用于提示"先补资料"
      no_followup: Array.isArray(parsed.no_followup) ? parsed.no_followup.map(function(p) {
        return {
          person_type: p.person_type || 'customer',
          person_id: parseInt(p.person_id, 10) || 0,
          name: clip(p.name, 30),
          reason: clip(p.reason, 60),
        };
      }).filter(function(p){ return p.name; }) : [],
    };

    return { analysis: analysis, raw: gen.text };
  } catch (e) {
    return { error: e.message };
  }
};
