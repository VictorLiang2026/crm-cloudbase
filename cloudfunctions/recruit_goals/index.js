/**
 * recruit_goals — 增员目标管理 + 行业基准（事件云函数，rdb() 版）
 * 借鉴国际保险行业增员 KPI 体系（友邦「最优秀代理」+ LIMRA 漏斗基准 + CareerPlug/Gem 招聘漏斗）
 * 三层 KPI：活动量（7阶段目标）→ 阶段转化率 → 结果产出（签约达成）
 *
 * 入参 event: { action, ... }
 *   listGoals:      { action:'listGoals', startMonth, endMonth } → { rows }
 *   saveGoals:      { action:'saveGoals', goalMonth, goals:{stage:count,...} } → { ok }
 *   getProgress:    { action:'getProgress', startMonth, endMonth } → { rows, trends, overall, benchmarks }
 *   listBenchmarks: { action:'listBenchmarks' } → { rows }
 *   saveBenchmarks: { action:'saveBenchmarks', benchmarks:[{stage_from,stage_to,conversion_min,conversion_avg,conversion_good},...] } → { ok }
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

const STAGES = ['新增人才','互动暖客','初次面谈','增员活动','精准面谈','入职申请','签约入司'];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'listGoals':      return await listGoals(event);
      case 'saveGoals':      return await saveGoals(event);
      case 'getProgress':    return await getProgress(event);
      case 'listBenchmarks': return await listBenchmarks(event);
      case 'saveBenchmarks': return await saveBenchmarks(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

// 查询月度目标列表
async function listGoals(event) {
  const startMonth = event.startMonth;
  const endMonth = event.endMonth;
  if (!startMonth || !endMonth) return { error: 'startMonth and endMonth required' };
  var q = rdb.from('recruit_goals').select().order('goal_month', { ascending: true }).order('stage', { ascending: true });
  q = q.gte('goal_month', startMonth + '-01');
  q = q.lte('goal_month', endMonth + '-01');
  const r = assertOk(await q);
  return { rows: r.data || [] };
}

// 批量保存某月目标（upsert）
async function saveGoals(event) {
  const goalMonth = event.goalMonth;
  if (!goalMonth) return { error: 'goalMonth required (YYYY-MM)' };
  const goals = event.goals || {};
  const goalDate = goalMonth + '-01';
  const ts = nowIso();

  // 先删除该月所有目标，再批量插入
  assertOk(await rdb.from('recruit_goals').delete().eq('goal_month', goalDate));

  const rows = [];
  for (const stage of STAGES) {
    const count = parseInt(goals[stage], 10);
    // 只保存非0目标：全0保存 = 清空该月目标
    if (count > 0) {
      rows.push({
        goal_month: goalDate,
        stage: stage,
        target_count: count || 0,
        operator: event.operator || null,
        created_at: ts,
        updated_at: ts,
      });
    }
  }

  if (rows.length > 0) {
    const r = assertOk(await rdb.from('recruit_goals').insert(rows).select('id'));
    return { ok: true, inserted: (r.data || []).length };
  }
  return { ok: true, inserted: 0 };
}

// 目标 vs 实际完成统计（核心）
async function getProgress(event) {
  const startMonth = event.startMonth;
  const endMonth = event.endMonth;
  if (!startMonth || !endMonth) return { error: 'startMonth and endMonth required' };

  // 1. 查目标
  var goalQ = rdb.from('recruit_goals').select().order('goal_month', { ascending: true });
  goalQ = goalQ.gte('goal_month', startMonth + '-01');
  goalQ = goalQ.lte('goal_month', endMonth + '-01');
  const goalRes = assertOk(await goalQ);
  const goalRows = goalRes.data || [];

  // 2. 查里程碑实际达成
  var msQ = rdb.from('recruit_milestones').select('to_stage,happened_at');
  msQ = msQ.gte('happened_at', startMonth + '-01');
  // endMonth + '-01' 下个月1日
  var endParts = endMonth.split('-');
  var endY = parseInt(endParts[0], 10);
  var endM = parseInt(endParts[1], 10);
  var nextM = endM + 1;
  var nextY = endY;
  if (nextM > 12) { nextM = 1; nextY++; }
  var endBoundary = nextY + '-' + String(nextM).padStart(2, '0') + '-01';
  msQ = msQ.lt('happened_at', endBoundary);
  const msRes = assertOk(await msQ);
  const msRows = msRes.data || [];

  // 3. 查基准
  const bmRes = assertOk(await rdb.from('recruit_goal_benchmarks').select());
  const bmRows = bmRes.data || [];
  var bmMap = {};
  bmRows.forEach(function(b) { bmMap[b.stage_from + '→' + b.stage_to] = b; });

  // 4. 按月汇总实际达成
  var actualByMonth = {}; // { '2026-09': { '新增人才': 5, '互动暖客': 3, ... } }
  msRows.forEach(function(m) {
    if (!m.happened_at || !m.to_stage) return;
    var d = m.happened_at.substring(0, 10);
    var ym = d.substring(0, 7);
    if (!actualByMonth[ym]) actualByMonth[ym] = {};
    var s = m.to_stage;
    actualByMonth[ym][s] = (actualByMonth[ym][s] || 0) + 1;
  });

  // 5. 按月汇总目标
  var goalByMonth = {};
  goalRows.forEach(function(g) {
    if (!g.goal_month) return;
    var ym = String(g.goal_month).substring(0, 10).substring(0, 7);
    if (!goalByMonth[ym]) goalByMonth[ym] = {};
    goalByMonth[ym][g.stage] = g.target_count;
  });

  // 6. 生成月列表
  var months = [];
  var curY = parseInt(startMonth.split('-')[0], 10);
  var curM = parseInt(startMonth.split('-')[1], 10);
  var endY2 = parseInt(endMonth.split('-')[0], 10);
  var endM2 = parseInt(endMonth.split('-')[1], 10);
  while (curY < endY2 || (curY === endY2 && curM <= endM2)) {
    months.push(curY + '-' + String(curM).padStart(2, '0'));
    curM++;
    if (curM > 12) { curM = 1; curY++; }
  }

  // 7. 聚合每阶段目标 + 实际
  var rows = [];
  for (var i = 0; i < STAGES.length; i++) {
    var stage = STAGES[i];
    var totalTarget = 0;
    var totalActual = 0;
    for (var j = 0; j < months.length; j++) {
      totalTarget += (goalByMonth[months[j]] && goalByMonth[months[j]][stage]) || 0;
      totalActual += (actualByMonth[months[j]] && actualByMonth[months[j]][stage]) || 0;
    }
    var achieveRate = totalTarget > 0 ? Math.round(totalActual / totalTarget * 1000) / 10 : 0;

    // 转化率：本阶段实际 / 上一阶段实际
    var convRate = null;
    var convBench = null;
    var convStatus = '';
    if (i > 0) {
      var prevStage = STAGES[i - 1];
      var prevActual = 0;
      for (var k = 0; k < months.length; k++) {
        prevActual += (actualByMonth[months[k]] && actualByMonth[months[k]][prevStage]) || 0;
      }
      // 目标转化率（行业基准均值）：始终返回，与实际数据无关
      var key = prevStage + '→' + stage;
      var bm = bmMap[key];
      if (bm) {
        convBench = { min: parseFloat(bm.conversion_min), avg: parseFloat(bm.conversion_avg), good: parseFloat(bm.conversion_good) };
      }
      // 实际转化率：分母（上一阶段实际人数）为 0 时不计算、不显示
      if (prevActual > 0) {
        convRate = Math.round(totalActual / prevActual * 1000) / 10;
        if (convBench) {
          if (convRate < convBench.min) convStatus = 'red';
          else if (convRate < convBench.avg) convStatus = 'yellow';
          else convStatus = 'green';
        }
      }
    }

    rows.push({
      stage: stage,
      target: totalTarget,
      actual: totalActual,
      achieve_rate: achieveRate,
      conv_rate: convRate,
      conv_bench: convBench,
      conv_status: convStatus,
    });
  }

  // 8. 整体漏斗转化率
  var newActual = rows.length > 0 ? rows[0].actual : 0;
  var signActual = rows.length > 0 ? rows[rows.length - 1].actual : 0;
  var overallRate = newActual > 0 ? Math.round(signActual / newActual * 1000) / 10 : 0;
  var overallBench = bmMap['新增人才→签约入司'] || null;
  var overallStatus = '';
  if (overallBench) {
    var ob = { min: parseFloat(overallBench.conversion_min), avg: parseFloat(overallBench.conversion_avg), good: parseFloat(overallBench.conversion_good) };
    if (overallRate < ob.min) overallStatus = 'red';
    else if (overallRate < ob.avg) overallStatus = 'yellow';
    else overallStatus = 'green';
  }

  // 9. 月度趋势
  var trends = [];
  for (var t = 0; t < months.length; t++) {
    var monthData = { month: months[t], stages: {} };
    for (var s = 0; s < STAGES.length; s++) {
      var st = STAGES[s];
      monthData.stages[st] = {
        target: (goalByMonth[months[t]] && goalByMonth[months[t]][st]) || 0,
        actual: (actualByMonth[months[t]] && actualByMonth[months[t]][st]) || 0,
      };
    }
    trends.push(monthData);
  }

  return {
    rows: rows,
    overall: {
      rate: overallRate,
      bench: overallBench ? { min: parseFloat(overallBench.conversion_min), avg: parseFloat(overallBench.conversion_avg), good: parseFloat(overallBench.conversion_good) } : null,
      status: overallStatus,
      new_count: newActual,
      sign_count: signActual,
    },
    trends: trends,
    benchmarks: bmRows,
  };
}

// 查询行业基准
async function listBenchmarks(event) {
  const r = assertOk(await rdb.from('recruit_goal_benchmarks').select().order('id', { ascending: true }));
  return { rows: r.data || [] };
}

// 修改行业基准
async function saveBenchmarks(event) {
  const benchmarks = event.benchmarks || [];
  const ts = nowIso();
  var updated = 0;
  for (var i = 0; i < benchmarks.length; i++) {
    var b = benchmarks[i];
    if (!b.stage_from || !b.stage_to) continue;
    var payload = {
      conversion_min: parseFloat(b.conversion_min) || 0,
      conversion_avg: parseFloat(b.conversion_avg) || 0,
      conversion_good: parseFloat(b.conversion_good) || 0,
      updated_at: ts,
    };
    if (b.source !== undefined) payload.source = b.source;
    var r = assertOk(await rdb.from('recruit_goal_benchmarks').update(payload)
      .eq('stage_from', b.stage_from)
      .eq('stage_to', b.stage_to)
      .select('id'));
    updated += (r.data || []).length;
  }
  return { ok: true, updated: updated };
}
