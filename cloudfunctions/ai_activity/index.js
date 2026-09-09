/**
 * ai_activity — AI 活动分析（事件云函数，超时 60s，rdb() 版）
 * 入参 event: { action:'analyze'|'prepare'|'decompose'|'recommendSpeakers'|'recommendTopics'|'postReview', activity_id }
 *   analyze:   活动后参与者跟进分析（v1.3）
 *   prepare:   AI 筹备助手（v1.7.2）：综合评估 → summary/current_stage/risks/priorities/suggested_tasks
 *   decompose: AI 筹备任务拆解（v1.7.2）：聚焦把筹备工作拆解为建议任务，输出结构同 prepare
 *   recommendSpeakers: AI 推荐嘉宾（v1.7.3）：从嘉宾资源池为活动推荐合适嘉宾
 *                      → recommendations:[{speaker_id, score, reason, suggested_topic, contact_suggestion}]
 *   recommendTopics: AI 推荐主题（v1.7.4）：从主题资源池推荐 → recommendations:[{topic_id, score, reason, suggested_speaker}]
 *   postReview: AI 活动复盘（v1.7.5）：活动 ended/reviewed 后从 6 维度发现经营机会
 *               → {summary, customer_actions[], recruit_actions[], speaker_actions[], topic_actions[],
 *                  opportunity_suggestions[], next_activity_suggestions[]}
 *   prepare/decompose/recommendSpeakers/recommendTopics/postReview 只返回建议，绝不写库；
 *   用户确认后由前端调 ai_recommend/followups/opportunities/recruit_followups/activity_speakers/activities 写入
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
    if (action === 'prepare') return await prepare(event, false);
    if (action === 'decompose') return await prepare(event, true);
    if (action === 'recommendSpeakers') return await recommendSpeakers(event);
    if (action === 'recommendTopics') return await recommendTopics(event);
    if (action === 'postReview') return await postReview(event);
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
        participant_role: p.participant_role || 'attendee',
        followup_status: p.followup_status || 'none',
        stage: info ? (info.customer_stage || info.stage || '') : '',
        priority: info ? (info.sales_priority || info.priority || '') : '',
        occupation: info ? (info.occupation || '') : '',
        additional_info: info ? (info.additional_info || '') : '',
        next_followup_date: linked && p.person_type === 'customer' ? (nextFollowMap[p.person_id] || '') : '',
      };
    });

    var today = todayStr();

    // 活动生命周期上下文（v1.7.0 新增）
    var STATUS_LABEL = { idea: '想法', preparing: '筹备中', confirmed: '已确定', in_progress: '进行中', ended: '已结束', reviewed: '已复盘' };
    var actStatus = activity.status ? (STATUS_LABEL[activity.status] || activity.status) : '未设';
    var goalTypes = Array.isArray(activity.goal_types) && activity.goal_types.length
      ? activity.goal_types.join('/') : '未设';
    var actGoals = '';
    if (activity.target_participants != null) actGoals += '；计划' + activity.target_participants + '人';
    if (activity.actual_participants != null) actGoals += '；实际' + activity.actual_participants + '人';
    var reviewInfo = '';
    if (activity.review_summary) reviewInfo += '；复盘摘要：' + clip(activity.review_summary, 60);
    if (activity.review_score) reviewInfo += '；评分：' + activity.review_score + '/5';

    var sys = [
      '你是保险业务员的活动经营助手。业务员刚结束一场活动，你需要分析参与者情况，给出跟进建议。',
      '【活动信息】名称：' + activity.name + '；日期：' + (activity.activity_date || '未定') + '；类型：' + (activity.activity_type || '未分类') + '；地点：' + (activity.location || '未定') + '；状态：' + actStatus + '；目标：' + goalTypes + actGoals + reviewInfo + '。',
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
      '6. 如果活动目标包含 referral（转介绍），优先推荐有社交影响力的参与者。',
      '7. 如果活动目标包含 recruit（增员），关注职业诉求与保险行业契合的人。',
      '8. 只输出 JSON，不要解释、不要 markdown。',
    ].join('\n');

    // 参与者角色标签
    var ROLE_LABEL = { attendee: '参与者', speaker: '嘉宾', organizer: '组织者', partner: '合作方', guest: '宾客' };
    var FS_LABEL = { none: '无需跟进', pending: '待跟进', done: '已跟进', not_needed: '不需要' };

    var userContent = '参与者列表（共 ' + participantInfo.length + ' 人）：\n' +
      participantInfo.map(function(p, i) {
        var role = p.participant_role ? (ROLE_LABEL[p.participant_role] || p.participant_role) : '参与者';
        var fs = p.followup_status ? (FS_LABEL[p.followup_status] || p.followup_status) : '';
        return (i+1) + '. [' + p.person_type + (p.linked ? ' #' + p.person_id : ' #0 待关联') + '] ' + p.name +
          '；角色：' + role +
          '；参加状态：' + p.status +
          (fs ? '；跟进：' + fs : '') +
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



// ========== v1.7.2 AI 活动筹备助手（prepare / decompose 共用数据拉取，只读不写） ==========
var PREPARE_TYPE_ENUM = ['preparation', 'invitation', 'speaker', 'onsite', 'followup', 'review', 'other'];
var PREPARE_PRIORITY_ENUM = ['high', 'medium', 'low'];

async function loadActivityContext(activityId) {
  var a = assertOk(await rdb.from('activities').select()
    .eq('id', activityId).is('deleted_at', null).maybeSingle());
  if (!a.data) return { error: 'activity not found' };
  var activity = a.data;

  var parts = assertOk(await rdb.from('activity_participants').select()
    .eq('activity_id', activityId).is('deleted_at', null)
    .order('created_at', { ascending: true })).data || [];

  var tasks = assertOk(await rdb.from('activity_tasks').select()
    .eq('activity_id', activityId)
    .order('created_at', { ascending: true })).data || [];

  var customerIds = parts.filter(function(p){ return p.person_type === 'customer' && p.person_id; }).map(function(p){ return p.person_id; });
  var recruitIds = parts.filter(function(p){ return p.person_type === 'recruit' && p.person_id; }).map(function(p){ return p.person_id; });
  var speakerIds = parts.filter(function(p){ return p.person_type === 'speaker' && p.person_id; }).map(function(p){ return p.person_id; });
  var nameMap = {};
  if (customerIds.length) {
    var cs = assertOk(await rdb.from('customers').select('Id, customer_name, customer_stage, sales_priority, occupation')
      .in('Id', customerIds).is('deleted_at', null)).data || [];
    cs.forEach(function(c){ nameMap['customer:' + c.Id] = c; });
  }
  if (recruitIds.length) {
    var rs = assertOk(await rdb.from('recruit_candidates').select('id, name, stage, priority, occupation')
      .in('id', recruitIds).is('deleted_at', null)).data || [];
    rs.forEach(function(rc){ nameMap['recruit:' + rc.id] = rc; });
  }
  if (speakerIds.length) {
    var sps = assertOk(await rdb.from('activity_speakers').select('id, name, organization, position, expertise, topic_summary, relationship_stage, cooperation_count')
      .in('id', speakerIds).is('deleted_at', null)).data || [];
    sps.forEach(function(s){ nameMap['speaker:' + s.id] = s; });
  }

  var participants = parts.map(function(p) {
    var info = p.person_id ? nameMap[p.person_type + ':' + p.person_id] : null;
    return {
      name: info ? (info.customer_name || info.name) : (p.person_name || '未知'),
      person_type: p.person_type,
      linked: !!p.person_id,
      status: p.status,
      participant_role: p.participant_role || 'attendee',
      stage: info ? (info.customer_stage || info.stage || info.relationship_stage || '') : '',
      priority: info ? (info.sales_priority || info.priority || '') : '',
      occupation: info ? (info.occupation || info.organization || '') : '',
      expertise: info ? (info.expertise || '') : '',
    };
  });

  var taskItems = tasks.map(function(t) {
    return { task_title: t.task_title, task_type: t.task_type, status: t.status, priority: t.priority, due_date: t.due_date };
  });

  return { activity: activity, participants: participants, tasks: taskItems };
}

// ============ AI 推荐嘉宾（v1.7.3）============
// 从嘉宾资源池（active）为指定活动推荐嘉宾。只读：绝不创建/修改嘉宾，也绝不把嘉宾加入活动；
// 用户在前端点「加入活动」后才由前端调 activities.addParticipant。
async function recommendSpeakers(event) {
  var activityId = parseInt(event && event.activity_id, 10);
  if (!activityId) return { error: 'activity_id required' };

  var ctx = await loadActivityContext(activityId);
  if (ctx.error) return ctx;
  var activity = ctx.activity;

  // 嘉宾池：仅 active 且未删除；排除已是本场参与者（speaker 类型已关联）的人
  var pool = assertOk(await rdb.from('activity_speakers').select()
    .eq('status', 'active').is('deleted_at', null)
    .order('updated_at', { ascending: false }).limit(50)).data || [];
  var parts = assertOk(await rdb.from('activity_participants').select('person_type, person_id')
    .eq('activity_id', activityId).is('deleted_at', null)).data || [];
  var existingIds = {};
  parts.forEach(function(p){ if (p.person_type === 'speaker' && p.person_id) existingIds[p.person_id] = true; });
  var candidates = pool.filter(function(s){ return !existingIds[s.id]; });
  if (!candidates.length) {
    return { recommendations: [], note: '嘉宾池中没有可推荐的新嘉宾（池子为空或可用嘉宾均已在本场参与者中）' };
  }

  var poolDesc = candidates.map(function(s, i) {
    return (i + 1) + '. #' + s.id + ' ' + s.name
      + '｜机构：' + (s.organization || '未知')
      + '｜职务：' + (s.position || '未知')
      + '｜专业：' + (s.expertise || '未知')
      + '｜代表主题：' + (s.topic_summary || '未知')
      + '｜关系阶段：' + (s.relationship_stage || 'new')
      + '｜历史合作：' + (s.cooperation_count || 0) + '次'
      + '｜偏好形式：' + (s.preferred_format || '未知')
      + '｜最近联系：' + (s.last_contact_date || '未记录');
  }).join('\n');

  var sys = [
    '你是保险业务员的活动嘉宾推荐助手。基于活动信息和嘉宾资源池，推荐最合适的嘉宾（最多5位，按匹配度从高到低）。',
    '【活动信息】名称：' + activity.name + '；日期：' + (activity.activity_date || '未定') + '；类型：' + (activity.activity_type || '未知') + '；地点：' + (activity.location || '未知') + '；目标：' + (Array.isArray(activity.goal_types) && activity.goal_types.length ? activity.goal_types.join('、') : '未设') + '；说明：' + (activity.description || '无'),
    '【已有参与者】' + (ctx.participants.length ? ctx.participants.map(function(p){ return p.name + '(' + p.person_type + ')'; }).join('、') : '暂无'),
    '【嘉宾资源池】\n' + poolDesc,
    '只能从资源池中推荐（speaker_id 必须是池中真实存在的 #编号），严禁编造不存在的人。若池中无人匹配，recommendations 返回空数组，并在 note 说明原因。',
    '【只输出 JSON】结构：{recommendations:[{speaker_id, score, reason, suggested_topic, contact_suggestion}], note}',
    'score 为 0-100 整数匹配度；reason ≤40字（为何适合本场）；suggested_topic ≤30字（建议分享主题，需贴合其专业）；contact_suggestion ≤40字（联系邀约要点，最近未联系的建议先重建联系）',
  ].join('\n');

  var gen = await generateText([
    { role: 'system', content: sys },
    { role: 'user', content: '请推荐嘉宾。' },
  ], { timeout: 55000 });

  var parsed = extractJson(gen.text) || {};
  var byId = {};
  candidates.forEach(function(s){ byId[s.id] = s; });
  var recommendations = (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])
    .map(function(r) {
      var sid = parseInt(r && r.speaker_id, 10);
      if (!sid || !byId[sid]) return null; // AI 编造的 ID 直接丢弃
      var score = parseInt(r.score, 10);
      if (isNaN(score)) score = 0;
      if (score < 0) score = 0;
      if (score > 100) score = 100;
      return {
        speaker_id: sid,
        speaker_name: byId[sid].name,
        score: score,
        reason: clip(r.reason, 40) || '信息不足',
        suggested_topic: clip(r.suggested_topic, 30) || '信息不足',
        contact_suggestion: clip(r.contact_suggestion, 40) || '信息不足',
      };
    })
    .filter(Boolean)
    .sort(function(a, b){ return b.score - a.score; })
    .slice(0, 5);

  return { recommendations: recommendations, note: clip(parsed.note, 60) || '' };
}

// AI 推荐活动主题（v1.7.4）：基于本场活动/参与者/历史活动/主题池推荐；只读不写
async function recommendTopics(event) {
  var activityId = parseInt(event && event.activity_id, 10);
  if (!activityId) return { error: 'activity_id required' };

  var ctx = await loadActivityContext(activityId);
  if (ctx.error) return ctx;
  var activity = ctx.activity;

  // 主题池：active 未删除，按使用次数排序；排除本场已选
  var pool = assertOk(await rdb.from('activity_topics').select()
    .eq('status', 'active').is('deleted_at', null)
    .order('use_count', { ascending: false }).limit(50)).data || [];
  var chosen = {};
  (Array.isArray(activity.topic_ids) ? activity.topic_ids : []).forEach(function (id) { chosen[parseInt(id, 10)] = true; });
  var candidates = pool.filter(function (t) { return !chosen[t.id]; });
  if (!candidates.length) {
    return { recommendations: [], note: '主题池中没有可推荐的新主题（池子为空或可用主题均已选入本场）' };
  }

  // 近期活动（供 AI 参考主题复用）
  var hist = assertOk(await rdb.from('activities').select('id, name, activity_type, topic_ids, activity_date')
    .is('deleted_at', null).neq('id', activityId)
    .order('activity_date', { ascending: false }).limit(10)).data || [];
  var histDesc = hist.filter(function (h) { return Array.isArray(h.topic_ids) && h.topic_ids.length; })
    .map(function (h) { return (h.activity_date ? String(h.activity_date).slice(0, 10) : '日期未定') + '《' + h.name + '》(' + (h.activity_type || '') + ')'; })
    .join('、') || '暂无';

  // 嘉宾池（供 suggested_speaker 给真实姓名）
  var speakers = assertOk(await rdb.from('activity_speakers').select('name')
    .eq('status', 'active').is('deleted_at', null).limit(50)).data || [];
  var speakerNames = speakers.map(function (s) { return s.name; });

  var poolDesc = candidates.map(function (t, i) {
    return (i + 1) + '. #' + t.id + ' ' + t.topic_name
      + '｜分类：' + (t.category || '未分类')
      + '｜目标人群：' + (t.target_audience || '未知')
      + '｜关键词：' + (Array.isArray(t.keywords) && t.keywords.length ? t.keywords.join('、') : '无')
      + '｜历史使用：' + (t.use_count || 0) + '次'
      + '｜说明：' + (t.description || '无');
  }).join('\n');

  var sys = [
    '你是保险业务员的活动主题推荐助手。基于本场活动信息、历史活动和主题资源池，推荐最合适的主题（最多5个，按匹配度从高到低）。',
    '【本场活动】名称：' + activity.name + '；日期：' + (activity.activity_date || '未定') + '；类型：' + (activity.activity_type || '未知') + '；目标：' + (Array.isArray(activity.goal_types) && activity.goal_types.length ? activity.goal_types.join('、') : '未设') + '；说明：' + (activity.description || '无'),
    '【已有参与者】' + (ctx.participants.length ? ctx.participants.map(function (p) { return p.name; }).join('、') : '暂无'),
    '【近期用过主题的活动】' + histDesc,
    '【主题资源池】\n' + poolDesc,
    '【可用嘉宾】' + (speakerNames.length ? speakerNames.join('、') : '暂无'),
    '只能从主题池中推荐（topic_id 必须是池中真实 #编号），严禁编造。若无匹配，recommendations 返回空数组并在 note 说明。',
    'suggested_speaker：建议由哪位嘉宾主讲，必须是【可用嘉宾】名单中的真实姓名；名单为空或无合适人选时填"信息不足"，严禁编造姓名。',
    '【只输出 JSON】结构：{recommendations:[{topic_id, score, reason, suggested_speaker}], note}',
    'score 为 0-100 整数匹配度；reason ≤40字（为何适合本场）；suggested_speaker 填嘉宾姓名或"信息不足"',
  ].join('\n');

  var gen = await generateText([
    { role: 'system', content: sys },
    { role: 'user', content: '请推荐活动主题。' },
  ], { timeout: 55000 });

  var parsed = extractJson(gen.text) || {};
  var byId = {};
  candidates.forEach(function (t) { byId[t.id] = t; });
  var speakerSet = {};
  speakerNames.forEach(function (n) { speakerSet[n] = true; });
  var recommendations = (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])
    .map(function (r) {
      var tid = parseInt(r && r.topic_id, 10);
      if (!tid || !byId[tid]) return null; // AI 编造的 ID 直接丢弃
      var score = parseInt(r.score, 10);
      if (isNaN(score)) score = 0;
      if (score < 0) score = 0;
      if (score > 100) score = 100;
      var sp = clip(r.suggested_speaker, 20) || '';
      if (sp && sp !== '信息不足' && !speakerSet[sp]) sp = '信息不足'; // 编造嘉宾名兜底
      return {
        topic_id: tid,
        topic_name: byId[tid].topic_name,
        score: score,
        reason: clip(r.reason, 40) || '信息不足',
        suggested_speaker: sp || '信息不足',
      };
    })
    .filter(Boolean)
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, 5);

  return { recommendations: recommendations, note: clip(parsed.note, 60) || '' };
}

// 规范化 AI 返回的建议任务：枚举白名单归一化 + due_date 格式校验，非法值不透传
function normSuggestedTasks(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(function(t) {
    if (!t || !t.task_title || !String(t.task_title).trim()) return null;
    var type = PREPARE_TYPE_ENUM.indexOf(t.task_type) >= 0 ? t.task_type : 'other';
    var pri = PREPARE_PRIORITY_ENUM.indexOf(t.priority) >= 0 ? t.priority : 'medium';
    var due = /^\d{4}-\d{2}-\d{2}$/.test(String(t.due_date || '')) ? String(t.due_date) : null;
    return {
      task_title: clip(t.task_title, 30),
      task_type: type,
      priority: pri,
      due_date: due,
      reason: clip(t.reason, 50),
    };
  }).filter(function(t){ return t; }).slice(0, 8);
}

// AI 筹备主流程：prepare（综合评估） / decompose（任务拆解）共用；只读不写 activity_tasks
async function prepare(event, decomposeOnly) {
  try {
    var activityId = parseInt(event && event.activity_id, 10);
    if (!activityId) return { error: 'activity_id required' };

    var ctx = await loadActivityContext(activityId);
    if (ctx.error) return ctx;
    var activity = ctx.activity;
    var today = todayStr();

    // 信息缺口检测：如实告知 AI，不编造
    var gaps = [];
    if (!activity.activity_date) gaps.push('活动日期未定');
    if (!Array.isArray(activity.goal_types) || !activity.goal_types.length) gaps.push('活动目标未设');
    if (!activity.location) gaps.push('地点未定');
    if (!activity.target_participants) gaps.push('计划人数未设');
    if (!ctx.participants.length) gaps.push('暂无参与者');

    var STATUS_LABEL = { idea: '想法', preparing: '筹备中', confirmed: '已确定', in_progress: '进行中', ended: '已结束', reviewed: '已复盘' };
    var actStatus = activity.status ? (STATUS_LABEL[activity.status] || activity.status) : '未设';
    var goalTypes = Array.isArray(activity.goal_types) && activity.goal_types.length ? activity.goal_types.join('/') : '未设';

    var partLines = ctx.participants.map(function(p) {
      return (p.person_type === 'customer' ? '客户' : '增员') + ' ' + p.name
        + '（' + (p.linked ? '已关联' : '待关联')
        + (p.stage ? '；阶段：' + p.stage : '')
        + (p.priority ? '；优先级：' + p.priority : '')
        + '；身份：' + p.participant_role + '）';
    }).join('\n');

    var taskLines = ctx.tasks.map(function(t) {
      return '- [' + t.status + '] ' + t.task_title + '（类型：' + t.task_type + '；优先级：' + t.priority + (t.due_date ? '；截止：' + t.due_date : '') + '）';
    }).join('\n');

    var focus = decomposeOnly
      ? '重点：把这场活动的筹备工作拆解为具体可执行的待办任务清单；summary/current_stage/risks/priorities 仍需给出，可简短。'
      : '重点：综合评估筹备现状（摘要/阶段/风险/优先事项），并给出筹备任务建议。';

    var sys = [
      '你是保险业务员的活动筹备助手。' + focus,
      '【活动信息】名称：' + activity.name + '；日期：' + (activity.activity_date || '未定') + '；类型：' + (activity.activity_type || '未分类') + '；地点：' + (activity.location || '未定') + '；状态：' + actStatus + '；目标：' + goalTypes + (activity.description ? '；描述：' + clip(activity.description, 100) : ''),
      '【今天】' + today,
      '【已有参与者】' + (partLines || '暂无'),
      '【已有任务】' + (taskLines || '暂无'),
      gaps.length ? '【已知缺口】' + gaps.join('；') + '。涉及缺口的内容注明"信息不足"，严禁编造。' : '',
      '【去重纪律】suggested_tasks 不得与【已有任务】中未完成（pending/in_progress）的重复。',
      '【只输出 JSON】结构：{summary, current_stage, risks[], priorities[], suggested_tasks:[{task_title, task_type, priority, due_date, reason}]}',
      'summary≤80字；current_stage≤40字；risks≤6条各≤40字；priorities≤5条各≤40字；suggested_tasks≤8条；task_title≤30字；reason≤50字；due_date 格式 YYYY-MM-DD，无法确定给 null。',
      'task_type 仅允许：preparation/invitation/speaker/onsite/followup/review/other；priority 仅允许：high/medium/low。',
      '【纪律】只基于已知信息，严禁编造客户/增员/活动信息；信息不足时在对应字段写"信息不足"。',
    ].filter(Boolean).join('\n');

    var gen = await generateText([
      { role: 'system', content: sys },
      { role: 'user', content: '请生成' + (decomposeOnly ? '筹备任务拆解' : '活动筹备建议') + '。' },
    ], { timeout: 55000 });

    var parsed = extractJson(gen.text) || {};
    var plan = {
      summary: clip(parsed.summary, 80) || '信息不足',
      current_stage: clip(parsed.current_stage, 40) || '信息不足',
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(function(r){ return clip(r, 40); }).filter(Boolean).slice(0, 6) : [],
      priorities: Array.isArray(parsed.priorities) ? parsed.priorities.map(function(p){ return clip(p, 40); }).filter(Boolean).slice(0, 5) : [],
      suggested_tasks: normSuggestedTasks(parsed.suggested_tasks),
    };
    return { plan: plan, raw: gen.text };
  } catch (e) {
    return { error: e.message };
  }
}

// ============ AI 活动复盘（v1.7.5）============
// 活动 ended/reviewed 后从 6 维度发现经营机会。只读不写：绝不写库；用户确认后由前端调
// followups/ai_recommendations/opportunities/recruit_followups/activity_speakers/activities 写入
var POSTREVIEW_PRIORITY_ENUM = ['high', 'medium', 'low'];
var POSTREVIEW_GOAL_ENUM = ['建立联系', '约见面', '邀请活动', '获取家庭信息', '推进签单', '推进招募', '推进转介绍'];
var POSTREVIEW_OPP_TYPE_ENUM = ['医疗保障', '重疾保障', '养老规划', '教育规划', '财富规划', '家庭保障', '转介绍'];

function validDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
}

async function postReview(event) {
  try {
    var activityId = parseInt(event && event.activity_id, 10);
    if (!activityId) return { error: 'activity_id required' };

    // 1. 活动
    var a = assertOk(await rdb.from('activities').select()
      .eq('id', activityId).is('deleted_at', null).maybeSingle());
    if (!a.data) return { error: 'activity not found' };
    var activity = a.data;

    // 2. 参与者
    var pRes = assertOk(await rdb.from('activity_participants').select()
      .eq('activity_id', activityId).is('deleted_at', null)
      .order('created_at', { ascending: true })).data || [];

    var customerIds = [], recruitIds = [], speakerIds = [];
    pRes.forEach(function (p) {
      if (!p.person_id) return;
      if (p.person_type === 'customer') customerIds.push(p.person_id);
      else if (p.person_type === 'recruit') recruitIds.push(p.person_id);
      else if (p.person_type === 'speaker') speakerIds.push(p.person_id);
    });

    var customerMap = {}, recruitMap = {}, speakerMap = {};
    if (customerIds.length) {
      var cs = assertOk(await rdb.from('customers')
        .select('Id, customer_name, customer_stage, sales_priority, occupation, additional_info')
        .in('Id', customerIds).is('deleted_at', null)).data || [];
      cs.forEach(function (c) { customerMap[c.Id] = c; });
    }
    if (recruitIds.length) {
      var rs = assertOk(await rdb.from('recruit_candidates')
        .select('id, name, stage, priority, occupation')
        .in('id', recruitIds).is('deleted_at', null)).data || [];
      rs.forEach(function (r) { recruitMap[r.id] = r; });
    }
    if (speakerIds.length) {
      var sps = assertOk(await rdb.from('activity_speakers')
        .select('id, name, organization, position, expertise, topic_summary, relationship_stage, cooperation_count, last_contact_date, next_contact_date')
        .in('id', speakerIds).is('deleted_at', null)).data || [];
      sps.forEach(function (s) { speakerMap[s.id] = s; });
    }

    // 3. 客户最近跟进（每客户最多3条，避免上下文膨胀）
    var followupMap = {};
    if (customerIds.length) {
      var fqs = assertOk(await rdb.from('followups')
        .select('customer_id, followup_date, next_followup_date, next_followup_goal')
        .in('customer_id', customerIds).is('deleted_at', null)
        .order('followup_date', { ascending: false }).limit(60)).data || [];
      fqs.forEach(function (f) {
        if (!followupMap[f.customer_id]) followupMap[f.customer_id] = [];
        if (followupMap[f.customer_id].length < 3) followupMap[f.customer_id].push(f);
      });
    }

    // 4. 客户进行中机会（避免重复建议）
    var oppMap = {};
    if (customerIds.length) {
      var opps = assertOk(await rdb.from('opportunities')
        .select('customer_id, opportunity_type, status')
        .in('customer_id', customerIds).is('deleted_at', null)).data || [];
      opps.forEach(function (o) {
        if (o.status === '关闭') return;
        if (!oppMap[o.customer_id]) oppMap[o.customer_id] = [];
        oppMap[o.customer_id].push(o.opportunity_type);
      });
    }

    // 5. 客户未完成 NBA（避免重复建议）
    var nbaCountMap = {};
    if (customerIds.length) {
      var nbas = assertOk(await rdb.from('ai_recommendations')
        .select('id, customer_id, nba')
        .in('customer_id', customerIds)).data || [];
      nbas.forEach(function (n) {
        var nba = n.nba && typeof n.nba === 'object' ? n.nba : {};
        if (nba.status === 'completed' || nba.status === 'skipped') return;
        nbaCountMap[n.customer_id] = (nbaCountMap[n.customer_id] || 0) + 1;
      });
    }

    // 6. 主题池（active）
    var topicPool = assertOk(await rdb.from('activity_topics').select()
      .eq('status', 'active').is('deleted_at', null)
      .order('use_count', { ascending: false }).limit(30)).data || [];
    var topicMap = {};
    topicPool.forEach(function (t) { topicMap[t.id] = t; });

    // 7. 嘉宾池（active，含本场已参与嘉宾；speaker_actions 可涉及池中任何人）
    var speakerPool = assertOk(await rdb.from('activity_speakers').select()
      .eq('status', 'active').is('deleted_at', null)
      .order('updated_at', { ascending: false }).limit(30)).data || [];
    var speakerPoolMap = {};
    speakerPool.forEach(function (s) { speakerPoolMap[s.id] = s; });

    // 8. 近期活动
    var recentActs = assertOk(await rdb.from('activities')
      .select('id, name, activity_type, activity_date, goal_types, topic_ids')
      .is('deleted_at', null).neq('id', activityId)
      .order('activity_date', { ascending: false }).limit(5)).data || [];

    var today = todayStr();
    var STATUS_LABEL = { idea: '想法', preparing: '筹备中', confirmed: '已确定', in_progress: '进行中', ended: '已结束', reviewed: '已复盘' };
    var ROLE_LABEL = { attendee: '参与者', speaker: '嘉宾', organizer: '组织者', partner: '合作方', guest: '宾客' };

    // 参与者描述
    var partLines = pRes.map(function (p, i) {
      var linked = !!p.person_id;
      var info = linked
        ? (p.person_type === 'customer' ? customerMap[p.person_id]
          : (p.person_type === 'recruit' ? recruitMap[p.person_id] : speakerMap[p.person_id]))
        : null;
      var name = info ? (info.customer_name || info.name) : (p.person_name || '未知（待关联）');
      var role = p.participant_role ? (ROLE_LABEL[p.participant_role] || p.participant_role) : '参与者';
      var line = (i + 1) + '. [' + p.person_type + (linked ? ' #' + p.person_id : ' #0 待关联') + '] ' + name
        + '；角色：' + role + '；参加状态：' + p.status;
      if (linked && p.person_type === 'customer') {
        if (info.customer_stage) line += '；阶段：' + info.customer_stage;
        if (info.sales_priority) line += '；优先级：' + info.sales_priority;
        if (info.occupation) line += '；职业：' + info.occupation;
        if (info.additional_info) line += '；附加信息：' + clip(info.additional_info, 80);
        var fqs = followupMap[p.person_id];
        if (fqs && fqs.length) {
          line += '；最近跟进：' + fqs.map(function (f) {
            return (f.followup_date || '').slice(0, 10) + (f.next_followup_date ? '→下次' + f.next_followup_date : '');
          }).join('、');
        }
        var opps = oppMap[p.person_id];
        if (opps && opps.length) line += '；进行中机会：' + opps.join('、');
        if (nbaCountMap[p.person_id]) line += '；未完成NBA：' + nbaCountMap[p.person_id] + '条';
      } else if (linked && p.person_type === 'recruit') {
        if (info.stage) line += '；阶段：' + info.stage;
        if (info.priority) line += '；优先级：' + info.priority;
        if (info.occupation) line += '；职业：' + info.occupation;
      } else if (linked && p.person_type === 'speaker') {
        if (info.organization) line += '；机构：' + info.organization;
        if (info.position) line += '；职务：' + info.position;
        if (info.expertise) line += '；专业：' + info.expertise;
        if (info.topic_summary) line += '；代表主题：' + clip(info.topic_summary, 40);
        if (info.relationship_stage) line += '；关系：' + info.relationship_stage;
        if (info.cooperation_count) line += '；合作' + info.cooperation_count + '次';
      }
      if (p.relationship_note) line += '；关系备注：' + clip(p.relationship_note, 60);
      return line;
    }).join('\n');

    var topicPoolDesc = topicPool.map(function (t, i) {
      return (i + 1) + '. #' + t.id + ' ' + t.topic_name
        + '｜分类：' + (t.category || '未分类')
        + '｜目标人群：' + (t.target_audience || '未知')
        + '｜使用：' + (t.use_count || 0) + '次'
        + (t.last_used_date ? '｜最近' + String(t.last_used_date).slice(0, 10) : '');
    }).join('\n');

    var speakerPoolDesc = speakerPool.map(function (s, i) {
      return (i + 1) + '. #' + s.id + ' ' + s.name
        + '｜机构：' + (s.organization || '未知')
        + '｜专业：' + (s.expertise || '未知')
        + '｜主题：' + (s.topic_summary || '未知')
        + '｜关系：' + (s.relationship_stage || 'new')
        + '｜合作：' + (s.cooperation_count || 0) + '次'
        + (s.last_contact_date ? '｜最近联系' + String(s.last_contact_date).slice(0, 10) : '')
        + (s.next_contact_date ? '｜下次联系' + String(s.next_contact_date).slice(0, 10) : '');
    }).join('\n');

    var recentDesc = recentActs.map(function (ra) {
      return (ra.activity_date ? String(ra.activity_date).slice(0, 10) : '日期未定')
        + '《' + ra.name + '》(' + (ra.activity_type || '') + ')';
    }).join('、') || '暂无';

    var actStatus = activity.status ? (STATUS_LABEL[activity.status] || activity.status) : '未设';
    var goalTypes = Array.isArray(activity.goal_types) && activity.goal_types.length
      ? activity.goal_types.join('/') : '未设';
    var actGoals = '';
    if (activity.target_participants != null) actGoals += '；计划' + activity.target_participants + '人';
    if (activity.actual_participants != null) actGoals += '；实际' + activity.actual_participants + '人';
    var reviewInfo = '';
    if (activity.review_summary) reviewInfo += '；已有复盘：' + clip(activity.review_summary, 60);
    if (activity.review_score) reviewInfo += '；评分：' + activity.review_score + '/5';
    var topicInfo = '';
    if (Array.isArray(activity.topic_ids) && activity.topic_ids.length) {
      var tnames = activity.topic_ids.map(function (tid) {
        var t = topicMap[tid];
        return t ? t.topic_name : ('#' + tid);
      });
      topicInfo = '；本场主题：' + tnames.join('、');
    }

    var sys = [
      '你是保险业务员的活动复盘助手。一场活动刚结束（或已复盘），你需要从 6 个维度发现经营机会，帮业务员把活动成果转化为后续行动。',
      '【活动信息】名称：' + activity.name + '；日期：' + (activity.activity_date || '未定') + '；类型：' + (activity.activity_type || '未分类') + '；地点：' + (activity.location || '未定') + '；状态：' + actStatus + '；目标：' + goalTypes + actGoals + topicInfo + reviewInfo + '。',
      '【今天】' + today + '。',
      '【参与者】共 ' + pRes.length + ' 人：\n' + (partLines || '暂无'),
      '【主题资源池（可复用）】\n' + (topicPoolDesc || '暂无'),
      '【嘉宾资源池（可继续经营）】\n' + (speakerPoolDesc || '暂无'),
      '【近期活动】' + recentDesc,
      '【6 个维度的建议】',
      '1. customer_actions：客户经营机会——参与者中已关联客户（person_id 必须是上面 customer 类型的真实 #编号），值得跟进的人。每条 {person_id, priority, reason, suggested_action, suggested_message, suggested_followup_date, suggested_followup_goal}。',
      '2. recruit_actions：增员经营机会——参与者中已关联增员（person_id 必须是上面 recruit 类型的真实 #编号）。每条 {person_id, priority, reason, suggested_action, suggested_followup_date}。',
      '3. speaker_actions：嘉宾经营机会——从嘉宾资源池中挑值得继续经营的人（speaker_id 必须是池中真实 #编号，可以是本场已参与的，也可以是池中其他人）。每条 {speaker_id, priority, reason, suggested_action, suggested_contact_date}。',
      '4. topic_actions：主题复用机会——从主题资源池中挑本场验证过/可复用的主题（topic_id 必须是池中真实 #编号）。每条 {topic_id, recommendation, reason}。',
      '5. opportunity_suggestions：业务机会——参与者中已关联客户（customer_id 必须真实）的经营机会。每条 {customer_id, opportunity_type, reason}。opportunity_type 只能取：医疗保障/重疾保障/养老规划/教育规划/财富规划/家庭保障/转介绍。不得与该客户已有进行中机会重复。',
      '6. next_activity_suggestions：下一场活动建议——基于本场效果给出。每条 {activity_type, topic, target_audience, reason}。topic 可以是池中主题名或新主题描述。',
      '【纪律】',
      '1. 严禁编造：所有 person_id/speaker_id/topic_id/customer_id 必须是上下文中出现的真实编号；待关联人员（#0）不能出现在建议中。',
      '2. priority 只能取：high/medium/low。',
      '3. suggested_followup_goal 只能取：建立联系/约见面/邀请活动/获取家庭信息/推进签单/推进招募/推进转介绍；无法确定给空字符串。',
      '4. 日期格式 YYYY-MM-DD；无法确定给空字符串。',
      '5. 信息不足时对应数组返回空，不要硬凑。',
      '6. summary ≤120字，聚焦本场复盘（亮点/不足/可改进）。',
      '7. 每条建议的 reason/suggested_action ≤60字；suggested_message ≤150字；recommendation ≤40字。',
      '8. 只输出 JSON，不要解释、不要 markdown。结构：{summary, customer_actions[], recruit_actions[], speaker_actions[], topic_actions[], opportunity_suggestions[], next_activity_suggestions[]}',
    ].join('\n');

    var gen = await generateText([
      { role: 'system', content: sys },
      { role: 'user', content: '请生成这场活动的 AI 复盘建议。' },
    ], { timeout: 60000 });

    var parsed = extractJson(gen.text) || {};

    // 清洗输出：ID 必须真实存在（防编造），枚举白名单校验，日期格式校验
    var customer_actions = (Array.isArray(parsed.customer_actions) ? parsed.customer_actions : [])
      .map(function (c) {
        var pid = parseInt(c && c.person_id, 10);
        if (!pid || !customerMap[pid]) return null;
        return {
          person_id: pid,
          person_name: customerMap[pid].customer_name || '',
          priority: POSTREVIEW_PRIORITY_ENUM.indexOf(c.priority) >= 0 ? c.priority : 'medium',
          reason: clip(c.reason, 60) || '信息不足',
          suggested_action: clip(c.suggested_action, 60) || '信息不足',
          suggested_message: clip(c.suggested_message, 150) || '信息不足',
          suggested_followup_date: validDate(c.suggested_followup_date),
          suggested_followup_goal: POSTREVIEW_GOAL_ENUM.indexOf(c.suggested_followup_goal) >= 0 ? c.suggested_followup_goal : '',
        };
      }).filter(Boolean).slice(0, 10);

    var recruit_actions = (Array.isArray(parsed.recruit_actions) ? parsed.recruit_actions : [])
      .map(function (c) {
        var pid = parseInt(c && c.person_id, 10);
        if (!pid || !recruitMap[pid]) return null;
        return {
          person_id: pid,
          person_name: recruitMap[pid].name || '',
          priority: POSTREVIEW_PRIORITY_ENUM.indexOf(c.priority) >= 0 ? c.priority : 'medium',
          reason: clip(c.reason, 60) || '信息不足',
          suggested_action: clip(c.suggested_action, 60) || '信息不足',
          suggested_followup_date: validDate(c.suggested_followup_date),
        };
      }).filter(Boolean).slice(0, 10);

    var speaker_actions = (Array.isArray(parsed.speaker_actions) ? parsed.speaker_actions : [])
      .map(function (c) {
        var sid = parseInt(c && c.speaker_id, 10);
        if (!sid || !speakerPoolMap[sid]) return null;
        return {
          speaker_id: sid,
          speaker_name: speakerPoolMap[sid].name || '',
          priority: POSTREVIEW_PRIORITY_ENUM.indexOf(c.priority) >= 0 ? c.priority : 'medium',
          reason: clip(c.reason, 60) || '信息不足',
          suggested_action: clip(c.suggested_action, 60) || '信息不足',
          suggested_contact_date: validDate(c.suggested_contact_date),
        };
      }).filter(Boolean).slice(0, 10);

    var topic_actions = (Array.isArray(parsed.topic_actions) ? parsed.topic_actions : [])
      .map(function (c) {
        var tid = parseInt(c && c.topic_id, 10);
        if (!tid || !topicMap[tid]) return null;
        return {
          topic_id: tid,
          topic_name: topicMap[tid].topic_name || '',
          recommendation: clip(c.recommendation, 40) || '信息不足',
          reason: clip(c.reason, 60) || '信息不足',
        };
      }).filter(Boolean).slice(0, 10);

    var opportunity_suggestions = (Array.isArray(parsed.opportunity_suggestions) ? parsed.opportunity_suggestions : [])
      .map(function (c) {
        var cid = parseInt(c && c.customer_id, 10);
        if (!cid || !customerMap[cid]) return null;
        var ot = POSTREVIEW_OPP_TYPE_ENUM.indexOf(c.opportunity_type) >= 0 ? c.opportunity_type : '';
        if (!ot) return null;
        var existing = oppMap[cid] || [];
        if (existing.indexOf(ot) >= 0) return null; // 去重：已有同类型进行中机会
        return {
          customer_id: cid,
          customer_name: customerMap[cid].customer_name || '',
          opportunity_type: ot,
          reason: clip(c.reason, 60) || '信息不足',
        };
      }).filter(Boolean).slice(0, 10);

    var next_activity_suggestions = (Array.isArray(parsed.next_activity_suggestions) ? parsed.next_activity_suggestions : [])
      .map(function (c) {
        return {
          activity_type: clip(c && c.activity_type, 20) || '未分类',
          topic: clip(c && c.topic, 40) || '信息不足',
          target_audience: clip(c && c.target_audience, 30) || '信息不足',
          reason: clip(c && c.reason, 60) || '信息不足',
        };
      }).filter(function (s) { return s.reason && s.reason !== '信息不足'; }).slice(0, 5);

    return {
      summary: clip(parsed.summary, 120) || '信息不足',
      customer_actions: customer_actions,
      recruit_actions: recruit_actions,
      speaker_actions: speaker_actions,
      topic_actions: topic_actions,
      opportunity_suggestions: opportunity_suggestions,
      next_activity_suggestions: next_activity_suggestions,
      raw: gen.text,
    };
  } catch (e) {
    return { error: e.message };
  }
}
