/**
 * ai_parse — AI 文本/照片解析 → 客户资料（事件云函数，超时 120s，rdb() 版）
 * 入参 event: { text?, images?, image_base64?, content_type?, file_name? }
 *   - text: 待解析的自然语言文本（与图片至少提供一个）；可包含附件文件名/文本文件内容等上下文
 *   - images: 可选，多图数组 [{ base64, content_type?, file_name? }]（不含 data: 前缀），多模态识别
 *   - image_base64: 可选，单图 base64（向后兼容旧入参，等价 images:[{base64}]）
 * 出参: { parsed, raw }
 *   - parsed: { customer_name, gender, phone, birthday, occupation, marital_status,
 *               customer_stage, sales_priority, recruitment_priority, referral_priority,
 *               hobbies, source, additional_info, ... }
 *   - raw: 模型原始输出文本
 *
 * 解析前的原始内容（用户输入文本 + 各照片识别出的全部文字）统一追加到 parsed.additional_info，
 * 由前端确认表单随结构化字段一起入库。
 * 文件本身不再由本函数保存，由前端在客户创建成功后按 category（photo/attachment）调 photos.create 保存。
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
  '你是一个客户信息解析助手。用户会提供一张或多张图片（以及可能的补充文本/附件说明）。',
  '第一步：完整识别每张图片中的所有文字（OCR），并在 ocr_text 中按【照片N：文件名】的格式分段拼接各图识别结果。',
  '第二步：综合所有图片和文本内容提取同一位客户的资料；信息冲突时以更明确的一处为准。',
  '输出 JSON，字段：',
  'ocr_text(所有图片中识别出的全部原始文字，按图片顺序分段拼接),',
].join('\n') + FIELD_SPEC;

exports.main = async (event, context) => {
  try {
    const text = ((event && event.text) || '').trim();
    // 组装多图数组：优先 images，兼容旧的单图入参
    let images = (event && Array.isArray(event.images)) ? event.images : [];
    if (!images.length && event && event.image_base64) {
      images = [{ base64: event.image_base64, content_type: event.content_type, file_name: event.file_name }];
    }
    images = images.filter(function (im) { return im && im.base64; });
    if (!text && !images.length) return { error: 'text or image required' };

    let raw = '';
    if (images.length) {
      // 多模态：多图（+可选补充文本）→ 识别文字 + 结构化提取
      const content = [{ type: 'text', text: text || '请识别图片中的客户资料。' }];
      images.forEach(function (im, idx) {
        const contentType = im.content_type || 'image/jpeg';
        const label = im.file_name ? ('（文件名：' + im.file_name + '）') : '';
        if (images.length > 1 || label) {
          content.push({ type: 'text', text: '照片' + (idx + 1) + label + '：' });
        }
        content.push({ type: 'image_url', image_url: { url: 'data:' + contentType + ';base64,' + im.base64 } });
      });
      const messages = [
        { role: 'system', content: SYSTEM_VISION },
        { role: 'user', content: content },
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
