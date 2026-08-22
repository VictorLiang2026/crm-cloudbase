/**
 * ai_parse — AI 文本/照片解析 → 客户资料（事件云函数，超时 120s，rdb() 版）
 * 入参 event: { text?, image_base64?, content_type? }
 *   - text: 待解析的自然语言文本（与 image_base64 至少提供一个）
 *   - image_base64: 可选，照片 base64（不含 data: 前缀）；提供时走多模态识别图中文字
 * 出参: { parsed, raw }
 *   - parsed: { customer_name, gender, phone, birthday, occupation, marital_status,
 *               customer_stage, sales_priority, recruitment_priority, referral_priority,
 *               hobbies, source, additional_info, ... }
 *   - raw: 模型原始输出文本
 *
 * 解析前的原始内容（用户输入文本 + 照片识别出的全部文字）统一追加到 parsed.additional_info，
 * 由前端确认表单随结构化字段一起入库。
 * 照片本身不再由本函数保存，由前端在客户创建/更新成功后调 photos.create 保存。
 */
'use strict';

const { rdb, generateText, extractJson, assertOk } = require('./db');

const AI_MODEL = process.env.AI_MODEL || 'hy3';
// 视觉模型用 hy3-preview（实测支持多模态输入；hy3 会静默忽略图片）
const VISION_MODEL = process.env.VISION_MODEL || 'hy3-preview';

const FIELD_SPEC = [
  'customer_name(姓名), gender(性别:男/女/未知), phone(电话),',
  'birthday(生日 YYYY-MM-DD), occupation(职业),',
  'marital_status(婚况:未婚/已婚/未知),',
  'customer_stage(客户经营阶段:新认识/关系维护/需求挖掘/方案沟通/成交推进/转介绍经营),',
  'sales_priority(签单优先级:A/B/C/D/E), recruitment_priority(招募优先级:A/B/C/D/E),',
  'referral_priority(转介绍优先级:A/B/C/D/E),',
  'hobbies(爱好), source(来源), additional_info(其它信息)。',
  '无法判断的字段设为 null。只输出 JSON，不要解释。',
].join('\n');

const SYSTEM = '你是一个客户信息解析助手。从用户提供的文本中提取客户资料，输出 JSON。\n字段：\n' + FIELD_SPEC;

const SYSTEM_VISION = [
  '你是一个客户信息解析助手。第一步：完整识别图片中的所有文字（OCR）。',
  '第二步：从识别出的文字中提取客户资料。',
  '输出 JSON，字段：',
  'ocr_text(图片中识别出的全部原始文字，按阅读顺序拼接),',
].join('\n') + FIELD_SPEC;

exports.main = async (event, context) => {
  try {
    const text = ((event && event.text) || '').trim();
    const imageBase64 = event && event.image_base64;
    if (!text && !imageBase64) return { error: 'text or image required' };

    let raw = '';
    if (imageBase64) {
      // 多模态：图片（+可选补充文本）→ 识别文字 + 结构化提取
      const contentType = (event && event.content_type) || 'image/jpeg';
      const dataUrl = 'data:' + contentType + ';base64,' + imageBase64;
      const userText = text || '请识别图片中的客户资料。';
      const messages = [
        { role: 'system', content: SYSTEM_VISION },
        { role: 'user', content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] },
      ];
      const res = await generateText(messages, { timeout: 120000, model: VISION_MODEL });
      raw = res.text;
    } else {
      const messages = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text },
      ];
      const res = await generateText(messages, { timeout: 120000 });
      raw = res.text;
    }

    const parsed = extractJson(raw) || {};

    // 解析前的原始内容统一追加到 additional_info（保留 ocr_text 供前端展示，入库前剔除）
    const origParts = [];
    if (text) origParts.push('【原始输入】' + text);
    if (parsed.ocr_text) origParts.push('【照片识别文字】' + parsed.ocr_text);
    if (origParts.length) {
      const orig = origParts.join('\n');
      parsed.additional_info = parsed.additional_info
        ? (parsed.additional_info + '\n' + orig)
        : orig;
    }

    return { parsed: parsed, raw: raw };
  } catch (e) {
    return { error: e.message };
  }
};
