(() => {
  'use strict';

  // Trusted Types 兼容处理
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      if (!window.trustedTypes.defaultPolicy) {
        window.trustedTypes.createPolicy('default', {
          createHTML: (s) => s,
          createScript: (s) => s,
          createScriptURL: (s) => s
        });
      }
    } catch (e) {
      try {
        window.trustedTypes.createPolicy('aihub-fallback', {
          createHTML: (s) => s,
          createScript: (s) => s,
          createScriptURL: (s) => s
        });
      } catch (e2) {
        console.warn('TrustedTypes 策略创建失败，继续运行', e2);
      }
    }
  }

  const config = {
    LONG_LOAD_DELAY: 5000,
    SCROLL_JIGGLES: 4,
    MAX_SCROLL_TRIES: 300
  };

  const STORAGE_KEY = 'aihub_export_format';
  const STORAGE_KEY_CHATGPT_MODE = 'aihub_chatgpt_export_mode';
  const DEFAULT_FORMAT = 'txt';

  let currentFormat = DEFAULT_FORMAT;
  let chatgptExportMode = 'api'; // 'api' | 'dom'，ChatGPT 默认 API 导出，备选通用

  let isScrolling = false;
  let currentAdapter = null;
  let directorySignature = '';
  let anchorSeq = 0;
  let currentThemeMode = null;
  let themeObserver = null;
  let themeUpdateTimer = null;
  let exportAllState = { running: false, cancel: false };

  const UI = {
    toggleButton: null,
    panel: null,
    directoryPanel: null,
    status: null,
    formatSelector: null,
    exportModeSection: null,
    exportModeSelector: null,
    exportButton: null,
    exportAllButton: null,
    canvasButton: null,
    combinedButton: null,
    stopButton: null,
    directoryContainer: null,
    directoryToggle: null,
    progressBar: null,
    progressFill: null,
    toastContainer: null
  };

  // Toast 通知系统 - 替代原生 alert
  const Toast = {
    show(message, type = 'info', duration = 3000) {
      if (!UI.toastContainer) {
        UI.toastContainer = CommonUtil.createElement('div', { className: 'aihub-toast-container' });
        document.body.appendChild(UI.toastContainer);
      }
      const toast = CommonUtil.createElement('div', {
        className: `aihub-toast aihub-toast-${type}`,
        text: message
      });
      UI.toastContainer.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('show'));
      setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      }, duration);
    },
    success(msg, duration) { this.show(msg, 'success', duration); },
    error(msg, duration) { this.show(msg, 'error', duration || 5000); },
    warning(msg, duration) { this.show(msg, 'warning', duration); },
    info(msg, duration) { this.show(msg, 'info', duration); }
  };

  // 进度条控制
  const Progress = {
    show() {
      if (UI.progressBar) UI.progressBar.style.display = 'block';
      this.set(0);
    },
    hide() {
      if (UI.progressBar) UI.progressBar.style.display = 'none';
    },
    set(percent) {
      if (UI.progressFill) UI.progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }
  };

  const CommonUtil = {
    createElement(tag, options = {}) {
      const element = document.createElement(tag);
      if (options.text) element.textContent = options.text;
      if (options.className) element.className = options.className;
      if (options.attributes) {
        Object.entries(options.attributes).forEach(([key, value]) => {
          element.setAttribute(key, value);
        });
      }
      if (options.children) {
        options.children.forEach((child) => element.appendChild(child));
      }
      return element;
    },
    safeSetInnerHTML(element, html) {
      try {
        if (window.trustedTypes && window.trustedTypes.createPolicy) {
          const policy = window.trustedTypes.defaultPolicy ||
            window.trustedTypes.createPolicy('aihub-temp', { createHTML: (s) => s });
          element.innerHTML = policy.createHTML(html);
        } else {
          element.innerHTML = html;
        }
      } catch (e) {
        element.textContent = html.replace(/<[^>]*>/g, '');
      }
    }
  };

  // 统一文件命名工具
  const FileNaming = {
    // 获取北京时间日期字符串: YYYY-MM-dd
    getBeijingTimeStr() {
      const now = new Date();
      // 北京时间 = UTC + 8 小时
      const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const yyyy = beijingTime.getUTCFullYear();
      const mm = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(beijingTime.getUTCDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    },

    // 截取对话名称为 1-10 字符
    truncateTitle(title, maxLen = 10) {
      const cleaned = (title || 'untitled')
        .replace(/[\\/\-:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .trim();
      // 按字符截取（支持中文）
      return [...cleaned].slice(0, maxLen).join('') || 'untitled';
    },

    // 生成标准化导出文件名
    // 格式：{平台}-{对话名称1-10字}-{北京时间YYYY-MM-dd}.{后缀}
    build(platform, title, ext) {
      const platformName = {
        'gemini': 'Gemini',
        'chatgpt': 'ChatGPT',
        'grok': 'Grok'
      }[platform] || platform || 'AI';
      const shortTitle = this.truncateTitle(title);
      const dateStr = this.getBeijingTimeStr();
      return `${platformName}-${shortTitle}-${dateStr}.${ext}`;
    }
  };

  const HtmlToMarkdown = {
    to(html, platform) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const isGemini = platform === 'gemini';

      if (!isGemini) {
        doc.querySelectorAll('span.katex-html').forEach((el) => el.remove());
      }
      doc.querySelectorAll('mrow').forEach((mrow) => mrow.remove());
      doc.querySelectorAll('annotation[encoding="application/x-tex"]').forEach((el) => {
        if (el.closest('.katex-display')) {
          const latex = el.textContent || '';
          el.replaceWith(`\n$$\n${latex.trim()}\n$$\n`);
        } else {
          const latex = el.textContent || '';
          el.replaceWith(`$${latex.trim()}$`);
        }
      });
      doc.querySelectorAll('strong, b').forEach((bold) => {
        const markdownBold = `**${bold.textContent}**`;
        bold.parentNode.replaceChild(document.createTextNode(markdownBold), bold);
      });
      doc.querySelectorAll('em, i').forEach((italic) => {
        const markdownItalic = `*${italic.textContent}*`;
        italic.parentNode.replaceChild(document.createTextNode(markdownItalic), italic);
      });
      doc.querySelectorAll('p code').forEach((code) => {
        const markdownCode = `\`${code.textContent}\``;
        code.parentNode.replaceChild(document.createTextNode(markdownCode), code);
      });
      doc.querySelectorAll('a').forEach((link) => {
        const markdownLink = `[${link.textContent}](${link.href})`;
        link.parentNode.replaceChild(document.createTextNode(markdownLink), link);
      });
      doc.querySelectorAll('img').forEach((img) => {
        const markdownImage = `![${img.alt}](${img.src})`;
        img.parentNode.replaceChild(document.createTextNode(markdownImage), img);
      });

      if (platform === 'chatgpt') {
        doc.querySelectorAll('pre').forEach((pre) => {
          const codeType = pre.querySelector('div > div:first-child')?.textContent || '';
          const markdownCode = pre.querySelector('div > div:nth-child(3) > code')?.textContent || pre.textContent;
          pre.innerHTML = `\n\`\`\`${codeType}\n${markdownCode}\n\`\`\``;
        });
      } else if (platform === 'grok') {
        doc.querySelectorAll('div.not-prose').forEach((div) => {
          const codeType = div.querySelector('div > div > span')?.textContent || '';
          const markdownCode = div.querySelector('div > div:nth-child(3) > code')?.textContent || div.textContent;
          div.innerHTML = `\n\`\`\`${codeType}\n${markdownCode}\n\`\`\``;
        });
      } else if (isGemini) {
        doc.querySelectorAll('code-block').forEach((div) => {
          const codeType = div.querySelector('div > div > span')?.textContent || '';
          const markdownCode = div.querySelector('div > div:nth-child(2) > div > pre')?.textContent || div.textContent;
          div.innerHTML = `\n\`\`\`${codeType}\n${markdownCode}\n\`\`\``;
        });
      }

      doc.querySelectorAll('ul').forEach((ul) => {
        let markdown = '';
        ul.querySelectorAll(':scope > li').forEach((li) => {
          markdown += `- ${li.textContent.trim()}\n`;
        });
        ul.parentNode.replaceChild(document.createTextNode(`\n${markdown.trim()}`), ul);
      });
      doc.querySelectorAll('ol').forEach((ol) => {
        let markdown = '';
        ol.querySelectorAll(':scope > li').forEach((li, index) => {
          markdown += `${index + 1}. ${li.textContent.trim()}\n`;
        });
        ol.parentNode.replaceChild(document.createTextNode(`\n${markdown.trim()}`), ol);
      });
      for (let i = 1; i <= 6; i++) {
        doc.querySelectorAll(`h${i}`).forEach((header) => {
          const markdownHeader = `\n${'#'.repeat(i)} ${header.textContent}\n`;
          header.parentNode.replaceChild(document.createTextNode(markdownHeader), header);
        });
      }
      doc.querySelectorAll('p').forEach((p) => {
        const markdownParagraph = `\n${p.textContent}\n`;
        p.parentNode.replaceChild(document.createTextNode(markdownParagraph), p);
      });
      doc.querySelectorAll('table').forEach((table) => {
        let markdown = '';
        table.querySelectorAll('thead tr').forEach((tr) => {
          tr.querySelectorAll('th').forEach((th) => { markdown += `| ${th.textContent} `; });
          markdown += '|\n';
          tr.querySelectorAll('th').forEach(() => { markdown += '| ---- '; });
          markdown += '|\n';
        });
        table.querySelectorAll('tbody tr').forEach((tr) => {
          tr.querySelectorAll('td').forEach((td) => { markdown += `| ${td.textContent} `; });
          markdown += '|\n';
        });
        table.parentNode.replaceChild(document.createTextNode(`\n${markdown.trim()}\n`), table);
      });

      const markdown = doc.body.innerHTML.replace(/<[^>]*>/g, '');
      return markdown
        .replaceAll(/- &gt;/g, '- $\\gt$')
        .replaceAll(/>/g, '>')
        .replaceAll(/</g, '<')
        .replaceAll(/≥/g, '>=')
        .replaceAll(/≤/g, '<=')
        .replaceAll(/≠/g, '\\neq')
        .trim();
    }
  };

  const Download = {
    start(data, filename, type) {
      const file = new Blob([data], { type });
      const a = document.createElement('a');
      const url = URL.createObjectURL(file);
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 0);
    }
  };

  // --- ChatGPT API 导出 (gpt_2 核心，无 FAB/面板 UI，供插件调用) ---
  const ChatGPTAPIExport = (function (downloadFn) {
    const U = {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      nowStr: () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; },
      sanitize: (s) => (s || 'untitled').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80),
      isConvPage: () => /^\/c\/[0-9a-f-]+$/i.test(location.pathname) || /^\/g\/[^/]+\/c\/[0-9a-f-]+$/i.test(location.pathname),
      convId: () => { const m1 = location.pathname.match(/^\/c\/([0-9a-f-]+)$/i); if (m1) return m1[1] || ''; const m2 = location.pathname.match(/^\/g\/[^/]+\/c\/([0-9a-f-]+)$/i); return (m2 && m2[1]) || ''; },
      projectId: () => { const m = location.pathname.match(/^\/g\/([^/]+)\/c\/[0-9a-f-]+$/i); return (m && m[1]) || ''; },
      ts: (s) => { if (!s && s !== 0) return ''; const n = typeof s === 'number' ? s : Number(s); const ms = n > 1e12 ? n : n * 1000; const d = new Date(ms); return isFinite(d) ? d.toISOString().replace('T', ' ').replace('Z', ' UTC') : ''; },
      isoToStamp: (s) => { if (!s) return ''; const d = new Date(s); if (!isFinite(d)) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; },
      // 统一文件名: ChatGPT-对话名称(1-10字)-北京日期(YYYY-MM-dd).后缀
      buildFilename: (title, ext) => {
        const now = new Date();
        const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const p = (n) => String(n).padStart(2, '0');
        const dateStr = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
        const shortTitle = [...(title || 'untitled').replace(/[\\/\-:*?"<>|]+/g, '_').replace(/\s+/g, '_').trim()].slice(0, 10).join('') || 'untitled';
        return `ChatGPT-${shortTitle}-${dateStr}.${ext}`;
      }
    };
    const MAX_CONCURRENCY = 5;

    const Cred = (() => {
      let token = null, accountId = null, lastErr = '';
      const ensureViaSession = async (tries = 4) => {
        for (let i = 0; i < tries; i++) {
          try {
            const r = await fetch('/api/auth/session', { credentials: 'include' });
            if (r.ok) {
              const j = await r.json().catch(() => ({}));
              if (j && j.accessToken) { token = j.accessToken; lastErr = ''; }
              if (!accountId) { const m = document.cookie.match(/(?:^|;\s*)_account=([^;]+)/); if (m) accountId = decodeURIComponent(m[1]); }
              if (token) return true;
            } else { lastErr = 'session ' + r.status; }
          } catch (e) { lastErr = (e && e.message) ? e.message : 'session_error'; }
          await U.sleep(300 * (i + 1));
        }
        return !!token;
      };
      const getAuthHeaders = () => { const h = new Headers(); if (token) h.set('authorization', 'Bearer ' + token); if (accountId) h.set('chatgpt-account-id', accountId); return h; };
      return { get token() { return token; }, ensureViaSession, getAuthHeaders };
    })();

    const Net = (() => {
      const base = () => location.origin;
      const mergeHeaders = (a, b) => { const h = new Headers(a || {}); (b || new Headers()).forEach((v, k) => h.set(k, v)); return h; };
      const backoff = (i) => U.sleep(Math.min(15000, 500 * Math.pow(1.8, i)));
      const req = async (url, opt = {}, expectJson = true, attempt = 0) => {
        if (!Cred.token) await Cred.ensureViaSession(6);
        const h = mergeHeaders(opt.headers, Cred.getAuthHeaders());
        const init = Object.assign({ credentials: 'include' }, opt, { headers: h });
        const resp = await fetch(url, init).catch(() => null);
        if (!resp) throw new Error('network_failed');
        if (resp.status === 401 && attempt < 2) { await Cred.ensureViaSession(6); return req(url, opt, expectJson, attempt + 1); }
        if ((resp.status === 429 || resp.status >= 500) && attempt < 5) { await backoff(attempt); return req(url, opt, expectJson, attempt + 1); }
        if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error('http_' + resp.status + ':' + t.slice(0, 160)); }
        return expectJson ? resp.json() : resp.blob();
      };
      const list = (p) => {
        const { is_archived, is_starred, offset = 0, limit = 50, order = 'updated' } = p || {};
        const q = new URLSearchParams({ offset: String(offset), limit: String(limit), order: String(order), ...(typeof is_archived === 'boolean' ? { is_archived: String(is_archived) } : {}), ...(typeof is_starred === 'boolean' ? { is_starred: String(is_starred) } : {}) });
        return req(base() + '/backend-api/conversations?' + q.toString(), { method: 'GET' });
      };
      const getConv = (id, projectId) => { const headers = projectId ? { 'chatgpt-project-id': projectId } : undefined; return req(base() + '/backend-api/conversation/' + id, { method: 'GET', headers }); };
      const listGizmosSidebar = (p) => {
        const { conversations_per_gizmo = 20, owned_only = true, cursor = null } = p || {};
        const n = Math.min(typeof conversations_per_gizmo === 'number' ? conversations_per_gizmo : 20, 20);
        const q = new URLSearchParams({ conversations_per_gizmo: String(n), owned_only: String(owned_only) }); if (cursor) q.set('cursor', cursor);
        return req(base() + '/backend-api/gizmos/snorlax/sidebar?' + q.toString(), { method: 'GET' });
      };
      return { list, getConv, listGizmosSidebar };
    })();

    const MD = (() => {
      const roleZh = (r) => ({ user: '用户', assistant: '助手', system: '系统', tool: '工具' })[r] || r || '未知';
      const joinParts = (parts) => Array.isArray(parts) ? parts.map((x) => String(x || '')).join('\n\n').trim() : String(parts || '').trim();

      // 清理内部标签 (image_group{...}, entity[...] 等)
      const cleanInternalTags = (text) => {
        if (!text) return '';
        let result = text;

        // 清理 image_group{...} 标签 - 使用循环处理嵌套大括号
        // 匹配 image_group 后跟 { 开始到配对的 } 结束
        result = result.replace(/image_group\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');

        // 清理带转义引号的 image_group (JSON 格式)
        result = result.replace(/image_group\{[^\n]*\}/g, '');

        // 清理 entity["type","显示名称",...] 标签，保留显示名称
        // 处理可能的转义引号
        result = result.replace(/entity\s*\[\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*,\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*(?:,[^\]]*)*\]/g, '$1');

        // 简化处理：删除所有 entity[...] 残留
        result = result.replace(/entity\s*\[[^\]]*\]/g, '');

        // 清理连续空行
        result = result.replace(/\n{3,}/g, '\n\n');

        return result.trim();
      };

      const nodesToArray = (mapping) => {
        const arr = [];
        if (!mapping || typeof mapping !== 'object') return arr;
        for (const k of Object.keys(mapping)) {
          const n = mapping[k];
          if (!n || !n.message) continue;
          const m = n.message;
          arr.push({
            id: n.id || m.id || k,
            role: m.author?.role || '',
            create_time: m.create_time ?? null,
            content: m.content || {},
            metadata: m.metadata || {}
          });
        }
        return arr;
      };

      // 增强过滤：跳过隐藏消息、空消息、敏感用户配置
      const shouldSkip = (msg) => {
        // 跳过显式标记为隐藏的消息
        if (msg.metadata?.is_visually_hidden_from_conversation) return true;

        const ct = msg.content?.content_type;

        // 跳过空的系统消息
        if (msg.role === 'system') {
          if (ct === 'text' && joinParts(msg.content?.parts) === '') return true;
          if (ct === 'model_editable_context' && !msg.content?.model_set_context) return true;
          // 跳过 rebase 类型的系统消息
          if (msg.metadata?.rebase_system_message || msg.metadata?.rebase_developer_message) return true;
        }

        // 跳过用户配置消息 (user_editable_context)
        if (ct === 'user_editable_context') return true;

        // 跳过空文本消息
        if (ct === 'text' && joinParts(msg.content?.parts) === '') return true;

        // 跳过空的 model_editable_context
        if (ct === 'model_editable_context' && !msg.content?.model_set_context) return true;

        return false;
      };

      const fmtThoughts = (c) => {
        const t = c?.thoughts;
        if (!Array.isArray(t) || t.length === 0) return '';
        return t.map((it, i) => (it?.summary ? (i + 1) + '. ' + it.summary : (i + 1) + '.') + '\n' + (it?.content || (Array.isArray(it?.chunks) ? it.chunks.join('\n') : '') || '').trim()).join('\n\n');
      };
      const fmtRecap = (c) => (typeof c?.content === 'string' ? c.content : '').trim();
      const fmtText = (c) => cleanInternalTags(joinParts(c?.parts));
      const fmtContext = (c) => (c?.model_set_context || '').trim();

      const getMessageBody = (m) => {
        const ct = m.content?.content_type;
        if (ct === 'text') return fmtText(m.content);
        if (ct === 'thoughts') return cleanInternalTags(fmtThoughts(m.content));
        if (ct === 'reasoning_recap') return cleanInternalTags(fmtRecap(m.content));
        if (ct === 'model_editable_context') return fmtContext(m.content);
        // 对于未知类型，返回空而非 JSON
        return '';
      };

      const conversationToMD = (conv) => {
        const title = conv?.title || 'untitled';
        const id = conv?.conversation_id || conv?.id || '';
        const projId = conv?.gizmo_id || conv?.conversation_template_id || conv?.project_id || '';
        let linkLine = null;
        if (id) linkLine = projId ? '- 链接: https://chatgpt.com/g/' + projId + '/c/' + id : '- 链接: https://chatgpt.com/c/' + id;
        const meta = [
          '- 会话ID: ' + id,
          conv?.create_time ? '- 创建: ' + U.ts(conv.create_time) : null,
          conv?.update_time ? '- 更新: ' + U.ts(conv.update_time) : null,
          conv?.default_model_slug ? '- 模型: ' + conv.default_model_slug : null,
          linkLine
        ].filter(Boolean).join('\n');

        const nodes = nodesToArray(conv?.mapping);
        nodes.sort((a, b) => {
          const ta = a.create_time ?? 0, tb = b.create_time ?? 0;
          if (ta !== tb) return ta - tb;
          return String(a.id).localeCompare(String(b.id));
        });

        const renderMsg = (m, c) => {
          if (shouldSkip(m)) return '';
          const role = roleZh(m.role);
          const tstr = U.ts(m.create_time);
          const head = '**' + role + (tstr ? ' — ' + tstr : '') + '**';
          const body = getMessageBody(m);
          if (!body) return '';
          return head + '\n\n' + body;
        };

        const lines = ['# ' + title + '\n', meta ? meta + '\n\n---\n' : ''];
        for (const m of nodes) {
          const s = renderMsg(m, conv);
          if (s) lines.push(s, '\n');
        }

        // 过滤参考链接：只保留与对话相关的链接
        if (Array.isArray(conv?.safe_urls) && conv.safe_urls.length) {
          const relevantUrls = conv.safe_urls.filter(u =>
            !u.includes('chatgpt.com/apps') &&
            !u.includes('openai.com') &&
            !u.includes('private-repo') &&
            !u.includes('notion.so') &&
            !u.includes('docs.google.com')
          );
          if (relevantUrls.length) {
            lines.push('---\n**参考链接**\n');
            relevantUrls.forEach((u) => lines.push('- ' + u));
            lines.push('');
          }
        }
        return lines.join('\n').trim() + '\n';
      };

      const conversationToTxt = (conv) => {
        const nodes = nodesToArray(conv?.mapping);
        nodes.sort((a, b) => {
          const ta = a.create_time ?? 0, tb = b.create_time ?? 0;
          if (ta !== tb) return ta - tb;
          return String(a.id).localeCompare(String(b.id));
        });
        const lines = [];
        for (const m of nodes) {
          if (shouldSkip(m)) continue;
          const body = getMessageBody(m);
          if (!body) continue;
          lines.push('--- ' + roleZh(m.role) + ' ---', body, '');
        }
        return lines.join('\n').trim();
      };

      // 精简 JSON 导出结构
      const conversationToCleanJSON = (conv) => {
        const nodes = nodesToArray(conv?.mapping);
        nodes.sort((a, b) => {
          const ta = a.create_time ?? 0, tb = b.create_time ?? 0;
          if (ta !== tb) return ta - tb;
          return String(a.id).localeCompare(String(b.id));
        });

        const messages = [];
        for (const m of nodes) {
          if (shouldSkip(m)) continue;
          const body = getMessageBody(m);
          if (!body) continue;
          messages.push({
            role: m.role,
            content: body,
            timestamp: m.create_time ? U.ts(m.create_time) : null
          });
        }

        return {
          title: conv?.title || 'untitled',
          id: conv?.conversation_id || conv?.id || '',
          model: conv?.default_model_slug || '',
          created: conv?.create_time ? U.ts(conv.create_time) : null,
          updated: conv?.update_time ? U.ts(conv.update_time) : null,
          messages
        };
      };

      return { conversationToMD, conversationToTxt, conversationToCleanJSON };
    })();

    let isExporting = false;
    const fetchConvWithRetry = async (id, projectId, retries, getIsCancelled) => {
      let attempt = 0, lastErr = null;
      while (attempt <= retries) { if (getIsCancelled && getIsCancelled()) throw new Error('已停止'); try { return await Net.getConv(id, projectId); } catch (e) { lastErr = e; attempt++; if (attempt > retries) break; await U.sleep(500 * Math.pow(2, attempt - 1)); } }
      throw lastErr || new Error('fetch_failed');
    };
    const fetchAllConversations = async (tasks, concurrency, progressCb, getIsCancelled) => {
      const total = tasks.length; if (!total) return [];
      const results = new Array(total); let done = 0, index = 0, fatalErr = null;
      const worker = async () => { while (true) { if ((getIsCancelled && getIsCancelled()) || fatalErr) return; const i = index++; if (i >= total) return; const t = tasks[i]; try { const data = await fetchConvWithRetry(t.id, t.projectId, 2, getIsCancelled); results[i] = data; done++; if (progressCb) progressCb(done, total, '导出中：' + done + '/' + total); } catch (e) { fatalErr = e; return; } } };
      const n = Math.max(1, Math.min(concurrency || 1, total)); const workers = []; for (let i = 0; i < n; i++) workers.push(worker()); await Promise.all(workers); if (fatalErr) throw fatalErr; return results;
    };
    const buildProjectFolderNames = (projects) => { const map = new Map(); const counts = {}; projects.forEach((p) => { const base = U.sanitize(p.projectName || p.projectId || 'project'); counts[base] = (counts[base] || 0) + 1; }); projects.forEach((p) => { let baseName = U.sanitize(p.projectName || p.projectId || 'project'); if (counts[baseName] > 1 && p.createdAt) { const stamp = U.isoToStamp(p.createdAt); if (stamp) baseName = U.sanitize((p.projectName || baseName) + '_' + stamp); } map.set(p.projectId, baseName || 'project'); }); return map; };
    const collectAllIds = async (progressCb) => {
      const combos = [{ is_archived: false, is_starred: false }, { is_archived: true, is_starred: false }, { is_archived: false, is_starred: true }, { is_archived: true, is_starred: true }];
      const rootSet = new Set(); const projectMap = new Map();
      const addRoot = (id) => { if (id) rootSet.add(id); };
      const addProjectConv = (projectId, id, title) => { if (!projectId || !id) return; let rec = projectMap.get(projectId); if (!rec) { rec = { projectId, projectName: '', createdAt: '', convs: [] }; projectMap.set(projectId, rec); } if (!rec.convs.some((x) => x.id === id)) rec.convs.push({ id, title: title || '' }); if (rootSet.has(id)) rootSet.delete(id); };
      for (const c of combos) { let offset = 0, limit = 50; while (true) { const page = await Net.list({ ...c, offset, limit, order: 'updated' }); const arr = Array.isArray(page?.items) ? page.items : []; arr.forEach((it) => { if (!it || !it.id) return; const projId = it.conversation_template_id || it.gizmo_id || null; if (projId) addProjectConv(projId, it.id, it.title || ''); else addRoot(it.id); }); const total = Number(page?.total || 0); const got = offset + arr.length; if (progressCb) progressCb(5, total, '扫描：' + Math.min(got, total) + '/' + total); if (!arr.length || got >= total) break; offset += limit; await U.sleep(200); } }
      try { let cursor = null; do { const sidebar = await Net.listGizmosSidebar({ cursor }); const items = Array.isArray(sidebar?.items) ? sidebar.items : []; for (const it of items) { const g = it?.gizmo?.gizmo; if (!g?.id) continue; const pid = g.id; let rec = projectMap.get(pid); if (!rec) { rec = { projectId: pid, projectName: (g.display && g.display.name) || pid, createdAt: g.created_at || '', convs: [] }; projectMap.set(pid, rec); } const convItems = it?.conversations?.items; if (Array.isArray(convItems)) convItems.forEach((cv) => { if (cv?.id) addProjectConv(pid, cv.id, cv.title || ''); }); } cursor = sidebar?.cursor || null; } while (cursor); } catch (_) { }
      return { rootIds: Array.from(rootSet), projects: Array.from(projectMap.values()) };
    };

    const runExport = async (opts, fn) => { if (isExporting) throw new Error('请等待当前导出完成'); isExporting = true; const onProgress = opts?.onProgress || (() => { }); try { await fn(onProgress); } finally { isExporting = false; } };

    const exportCurrentJSON = async (opts) => runExport(opts, async (onProgress) => {
      onProgress('准备中…');
      await Cred.ensureViaSession(6);
      const id = U.convId();
      if (!id) throw new Error('no_conv_id');
      const pid = U.projectId();
      const j = await Net.getConv(id, pid || undefined);
      // 使用精简 JSON 格式
      const cleanData = MD.conversationToCleanJSON({ ...j, conversation_id: id, gizmo_id: pid || j?.gizmo_id });
      const blob = new Blob([JSON.stringify(cleanData, null, 2)], { type: 'application/json' });
      downloadFn(blob, U.buildFilename(j?.title, 'json'), blob.type);
      onProgress('完成');
    });
    const exportCurrentMD = async (opts) => runExport(opts, async (onProgress) => { onProgress('准备中…'); await Cred.ensureViaSession(6); const id = U.convId(); if (!id) throw new Error('no_conv_id'); const pid = U.projectId(); const j = await Net.getConv(id, pid || undefined); const md = MD.conversationToMD({ ...j, conversation_id: id, gizmo_id: pid || j?.gizmo_id }); const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' }); downloadFn(blob, U.buildFilename(j?.title, 'md'), blob.type); onProgress('完成'); });
    const exportCurrentTxt = async (opts) => runExport(opts, async (onProgress) => { onProgress('准备中…'); await Cred.ensureViaSession(6); const id = U.convId(); if (!id) throw new Error('no_conv_id'); const pid = U.projectId(); const j = await Net.getConv(id, pid || undefined); const txt = MD.conversationToTxt({ ...j, conversation_id: id, gizmo_id: pid || j?.gizmo_id }); const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' }); downloadFn(blob, U.buildFilename(j?.title, 'txt'), blob.type); onProgress('完成'); });

    const _exportAll = async (isJson, opts) => {
      const onProgress = opts?.onProgress || (() => { }); const getIsCancelled = opts?.getIsCancelled || (() => false);
      onProgress('扫描列表…'); await Cred.ensureViaSession(6);
      const all = await collectAllIds((pct, total, text) => onProgress(text));
      const { rootIds = [], projects = [] } = all;
      const tasks = []; rootIds.forEach((id) => tasks.push({ kind: 'root', id, projectId: null })); projects.forEach((p) => { (p.convs || []).forEach((c) => tasks.push({ kind: 'proj', id: c.id, projectId: p.projectId })); });
      if (!tasks.length && !projects.length) throw new Error('列表为空');
      const zip = typeof JSZip !== 'undefined' ? new JSZip() : null; if (!zip) throw new Error('JSZip 未加载');
      zip.file('summary.json', JSON.stringify({ exportedAt: new Date().toISOString(), total: tasks.length, root: { count: rootIds.length, ids: rootIds }, projects: projects.map((p) => ({ projectId: p.projectId, projectName: p.projectName, createdAt: p.createdAt || '', conversationIds: (p.convs || []).map((c) => c.id) })) }, null, 2));
      const results = await fetchAllConversations(tasks, MAX_CONCURRENCY, (done, total, text) => onProgress(text), getIsCancelled); if (getIsCancelled && getIsCancelled()) throw new Error('已停止');
      const convDataMap = new Map(); tasks.forEach((t, i) => { if (results[i]) convDataMap.set(t.id, results[i]); });
      const folderNameByProjectId = buildProjectFolderNames(projects);
      let idxRoot = 0;
      for (const id of rootIds) {
        if (getIsCancelled && getIsCancelled()) throw new Error('已停止');
        const data = convDataMap.get(id);
        if (!data) continue;
        const title = U.sanitize(data?.title || 'untitled');
        idxRoot++;
        const seq = String(idxRoot).padStart(3, '0');
        if (isJson) {
          // 使用精简 JSON 格式
          const cleanData = MD.conversationToCleanJSON({ ...data, conversation_id: id });
          zip.file(seq + '_' + title + '_' + id + '.json', JSON.stringify(cleanData, null, 2));
        } else {
          zip.file(seq + '_' + title + '_' + id + '.md', MD.conversationToMD({ ...data, conversation_id: id }));
        }
      }
      projects.forEach((p) => {
        const folderName = folderNameByProjectId.get(p.projectId) || U.sanitize(p.projectName || p.projectId || 'project');
        const folder = zip.folder(folderName);
        if (!folder) return;
        let idx = 0;
        (p.convs || []).forEach((c) => {
          if (getIsCancelled && getIsCancelled()) return;
          const data = convDataMap.get(c.id);
          if (!data) return;
          const title = U.sanitize(data?.title || c.title || 'untitled');
          idx++;
          const seq = String(idx).padStart(3, '0');
          if (isJson) {
            // 使用精简 JSON 格式
            const cleanData = MD.conversationToCleanJSON({ ...data, conversation_id: c.id, gizmo_id: p.projectId });
            folder.file(seq + '_' + title + '_' + c.id + '.json', JSON.stringify(cleanData, null, 2));
          } else {
            folder.file(seq + '_' + title + '_' + c.id + '.md', MD.conversationToMD({ ...data, conversation_id: c.id, gizmo_id: p.projectId }));
          }
        });
      });
      onProgress('压缩中…'); const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } }); const ext = isJson ? 'json' : 'md'; downloadFn(blob, 'chatgpt-conversations-' + ext + '-' + U.nowStr() + '.zip', blob.type); onProgress('完成');
    };
    const exportAllJSON = async (opts) => { if (isExporting) throw new Error('请等待当前导出完成'); isExporting = true; try { await _exportAll(true, opts); } finally { isExporting = false; } };
    const exportAllMD = async (opts) => { if (isExporting) throw new Error('请等待当前导出完成'); isExporting = true; try { await _exportAll(false, opts); } finally { isExporting = false; } };

    return { isConvPage: () => U.isConvPage(), convId: () => U.convId(), projectId: () => U.projectId(), exportCurrentJSON, exportCurrentMD, exportCurrentTxt, exportAllJSON, exportAllMD };
  })((blob, name, type) => Download.start(blob, name, type || (blob && blob.type) || 'application/octet-stream'));

  function sanitizeFilename(input, replacement = '_') {
    const illegalRe = /[\/\\\?\%\*\:\|"<>\.]/g;
    const controlRe = /[\x00-\x1f\x80-\x9f]/g;
    const reservedRe = /^\.+$/;
    const windowsReservedRe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    let name = (input || '').replace(illegalRe, replacement).replace(controlRe, replacement).replace(/\s+/g, ' ').trim();
    if (reservedRe.test(name)) name = 'file';
    if (windowsReservedRe.test(name)) name = `file_${name}`;
    return name || 'untitled';
  }

  // 主题同步：跟随页面深浅色模式
  function parseRgbColor(colorString) {
    if (!colorString) return null;
    const match = colorString.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!match) return null;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  }

  function getPageBackgroundColor() {
    try {
      const bodyBg = window.getComputedStyle(document.body).backgroundColor;
      if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') return bodyBg;
    } catch (_) { }
    try {
      return window.getComputedStyle(document.documentElement).backgroundColor;
    } catch (_) { }
    return '';
  }

  function detectPageThemeMode() {
    try {
      const scheme = window.getComputedStyle(document.documentElement).colorScheme;
      if (scheme && scheme.includes('dark')) return 'dark';
      if (scheme && scheme.includes('light')) return 'light';
    } catch (_) { }

    const rgb = parseRgbColor(getPageBackgroundColor());
    if (rgb) {
      const luminance = (0.2126 * rgb.r) + (0.7152 * rgb.g) + (0.0722 * rgb.b);
      return luminance < 128 ? 'dark' : 'light';
    }

    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) { }
    return 'dark';
  }

  function applyThemeVariables(mode) {
    const lightVars = {
      '--aihub-panel-bg': '#f8fafc',
      '--aihub-panel-text': '#0f172a',
      '--aihub-text-muted': '#475569',
      '--aihub-border': '#e2e8f0',
      '--aihub-surface': '#ffffff',
      '--aihub-surface-soft': '#f1f5f9',
      '--aihub-primary': '#1e40af',
      '--aihub-primary-hover': '#1d4ed8',
      '--aihub-success': '#059669',
      '--aihub-danger': '#b91c1c',
      '--aihub-neutral': '#334155',
      '--aihub-neutral-border': '#475569',
      '--aihub-accent': '#b45309',
      '--aihub-shadow': '0 10px 30px rgba(15, 23, 42, 0.1)'
    };
    const darkVars = {
      '--aihub-panel-bg': '#0f172a',
      '--aihub-panel-text': '#f8fafc',
      '--aihub-text-muted': '#94a3b8',
      '--aihub-border': '#334155',
      '--aihub-surface': '#1e293b',
      '--aihub-surface-soft': '#0f172a',
      '--aihub-primary': '#3b82f6',
      '--aihub-primary-hover': '#60a5fa',
      '--aihub-success': '#10b981',
      '--aihub-danger': '#ef4444',
      '--aihub-neutral': '#64748b',
      '--aihub-neutral-border': '#475569',
      '--aihub-accent': '#f59e0b',
      '--aihub-shadow': '0 16px 40px rgba(0, 0, 0, 0.4)'
    };

    const vars = mode === 'light' ? lightVars : darkVars;
    Object.entries(vars).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, value);
    });
    currentThemeMode = mode;
  }

  function refreshThemeIfNeeded() {
    const nextMode = detectPageThemeMode();
    if (nextMode === currentThemeMode) return;
    applyThemeVariables(nextMode);
  }

  function scheduleThemeRefresh(delayMs = 120) {
    if (themeUpdateTimer) window.clearTimeout(themeUpdateTimer);
    themeUpdateTimer = window.setTimeout(() => {
      themeUpdateTimer = null;
      refreshThemeIfNeeded();
    }, delayMs);
  }

  function startThemeSync() {
    applyThemeVariables(detectPageThemeMode());

    if (themeObserver) themeObserver.disconnect();
    themeObserver = new MutationObserver(() => scheduleThemeRefresh(120));
    try {
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'color-scheme']
      });
    } catch (_) { }
    try {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    } catch (_) { }

    try {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      if (media && media.addEventListener) media.addEventListener('change', () => scheduleThemeRefresh(120));
      else if (media && media.addListener) media.addListener(() => scheduleThemeRefresh(120));
    } catch (_) { }
  }

  function getTimestamp() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}`;
  }

  function ensureAnchorId(element) {
    if (!element) return null;
    if (element.dataset.aihubAnchorId) return element.dataset.aihubAnchorId;
    if (element.id) {
      element.dataset.aihubAnchorId = element.id;
      return element.id;
    }
    anchorSeq += 1;
    const id = `aihub-anchor-${anchorSeq}`;
    element.id = id;
    element.dataset.aihubAnchorId = id;
    return id;
  }

  const adapters = [
    {
      id: 'gemini',
      match: (url) => url.includes('gemini.google.com'),
      messageSelectors: 'user-query, model-response',
      getTitle: () => {
        return document.querySelector('conversations-list div.selected')?.textContent
          || document.querySelector('div.conversation-title')?.textContent
          || document.title;
      },
      getTurns: () => {
        const userQueries = document.querySelectorAll('user-query');
        const modelResponses = document.querySelectorAll('model-response');
        const turns = [];
        for (let i = 0; i < userQueries.length; i++) {
          if (userQueries[i]) turns.push({ role: 'user', element: userQueries[i], html: userQueries[i].innerHTML });
          if (modelResponses[i]) turns.push({ role: 'assistant', element: modelResponses[i], html: modelResponses[i].innerHTML });
        }
        return turns;
      }
    },
    {
      id: 'chatgpt',
      match: (url) => url.includes('chat.openai.com') || url.includes('chatgpt.com'),
      messageSelectors: 'div[data-message-id], article[data-testid^="conversation-turn"]',
      getTitle: () => {
        return document.querySelector('div[class*="react-scroll-to-bottom"] h1')?.textContent
          || document.querySelector('#history a[data-active]')?.textContent
          || document.querySelector('nav a[class*="active"]')?.textContent
          || document.title;
      },
      getTurns: () => {
        // 尝试多种选择器
        let nodes = document.querySelectorAll('div[data-message-id]');
        if (!nodes.length) {
          nodes = document.querySelectorAll('article[data-testid^="conversation-turn"]');
        }
        if (!nodes.length) {
          nodes = document.querySelectorAll('[data-testid*="conversation-turn"]');
        }
        const turns = [];
        nodes.forEach((node) => {
          // 通过 DOM 属性判断角色
          let role = 'assistant';

          // 方法1: 检查元素本身的 data-message-author-role 属性
          let authorRole = node.getAttribute('data-message-author-role');

          // 方法2: 查找子元素中的 data-message-author-role
          if (!authorRole) {
            const authorEl = node.querySelector('[data-message-author-role]');
            if (authorEl) {
              authorRole = authorEl.getAttribute('data-message-author-role');
            }
          }

          // 方法3: 检查父元素
          if (!authorRole) {
            const parentWithRole = node.closest('[data-message-author-role]');
            if (parentWithRole) {
              authorRole = parentWithRole.getAttribute('data-message-author-role');
            }
          }

          if (authorRole) {
            role = authorRole === 'user' ? 'user' : 'assistant';
          } else {
            // 方法4: data-testid 属性
            const testId = node.getAttribute('data-testid') || node.closest('[data-testid]')?.getAttribute('data-testid') || '';
            if (testId.includes('user')) {
              role = 'user';
            } else if (testId.includes('assistant') || testId.includes('gpt')) {
              role = 'assistant';
            } else {
              // 方法5: 奇偶判断 (最后的降级方案)
              // 获取在同类节点中的索引
              const allNodes = document.querySelectorAll(nodes[0]?.tagName + '[data-message-id], article[data-testid^="conversation-turn"]');
              const index = Array.from(allNodes).indexOf(node);
              role = index % 2 === 0 ? 'user' : 'assistant';
            }
          }
          turns.push({ role, element: node, html: node.innerHTML });
        });
        return turns;
      }
    },
    {
      id: 'grok',
      match: (url) => {
        if (url.includes('grok.x.ai')) return true;
        if (url.includes('grok.com')) return true;
        if (url.includes('/i/grok')) return true;
        return url.includes('x.com') && document.querySelector('div.message-bubble');
      },
      messageSelectors: 'div.message-bubble',
      getTitle: () => document.title,
      getTurns: () => {
        const nodes = document.querySelectorAll('div.message-bubble');
        const turns = [];
        nodes.forEach((node) => {
          // 通过 DOM 结构和属性判断角色
          const container = node.closest('[data-role], [class*="user"], [class*="assistant"], [class*="grok"]');
          let role = 'assistant';
          if (container) {
            const dataRole = container.getAttribute('data-role');
            if (dataRole === 'user') role = 'user';
            else if (container.className.includes('user')) role = 'user';
          } else {
            // 降级：检查消息位置（用户消息通常在右侧）
            const style = window.getComputedStyle(node);
            const isRight = style.marginLeft === 'auto' || node.classList.contains('self') || node.classList.contains('outgoing');
            role = isRight ? 'user' : 'assistant';
          }
          turns.push({ role, element: node, html: node.innerHTML });
        });
        return turns;
      }
    }
  ];

  function detectAdapter() {
    const url = window.location.href;
    return adapters.find((adapter) => adapter.match(url)) || null;
  }

  function findScrollableContainer(messageSelectors) {
    const firstMessage = document.querySelector(messageSelectors);
    if (!firstMessage) return null;
    let parent = firstMessage.parentElement;
    while (parent && parent !== document.body) {
      if (parent.scrollHeight > parent.clientHeight) return parent;
      parent = parent.parentElement;
    }
    return window;
  }

  async function scrollToTopAndLoadAll(messageSelectors) {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const scrollContainer = findScrollableContainer(messageSelectors);
    if (!scrollContainer) return;

    const getMessageCount = () => document.querySelectorAll(messageSelectors).length;
    let tries = 0;
    let stableCount = 0;
    const STABLE_THRESHOLD = 3; // 连续 3 次消息数不变视为加载完成

    // 使用 MutationObserver 检测内容变化，替代固定等待时间
    const waitForContentStable = () => {
      return new Promise((resolve) => {
        const startCount = getMessageCount();
        let resolved = false;
        let lastCount = startCount;
        let checkCount = 0;

        const observer = new MutationObserver(() => {
          const currentCount = getMessageCount();
          if (currentCount !== lastCount) {
            lastCount = currentCount;
            checkCount = 0; // 重置稳定计数
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // 定期检查是否稳定
        const checkInterval = setInterval(() => {
          if (!isScrolling || resolved) {
            clearInterval(checkInterval);
            observer.disconnect();
            if (!resolved) { resolved = true; resolve(); }
            return;
          }
          const currentCount = getMessageCount();
          if (currentCount === lastCount) {
            checkCount++;
            if (checkCount >= STABLE_THRESHOLD) {
              clearInterval(checkInterval);
              observer.disconnect();
              if (!resolved) { resolved = true; resolve(); }
            }
          } else {
            lastCount = currentCount;
            checkCount = 0;
          }
        }, 500);

        // 最长等待时间保护
        setTimeout(() => {
          clearInterval(checkInterval);
          observer.disconnect();
          if (!resolved) { resolved = true; resolve(); }
        }, config.LONG_LOAD_DELAY * 2);
      });
    };

    while (tries < config.MAX_SCROLL_TRIES && isScrolling) {
      const lastMessageCount = getMessageCount();

      // 滚动到顶部
      for (let i = 0; i < config.SCROLL_JIGGLES; i++) {
        if (scrollContainer === window) window.scrollTo({ top: 0 });
        else scrollContainer.scrollTo({ top: 0 });
        await delay(50);
      }

      // 等待内容稳定 (使用 MutationObserver)
      await waitForContentStable();

      const currentMessageCount = getMessageCount();
      if (currentMessageCount === lastMessageCount && lastMessageCount > 0) {
        stableCount++;
        if (stableCount >= 2) break; // 连续 2 轮无变化则完成
      } else {
        stableCount = 0;
      }
      tries += 1;

      // 更新进度
      const progressPercent = Math.min(90, (tries / config.MAX_SCROLL_TRIES) * 90);
      Progress.set(progressPercent);
    }
  }

  function buildDirectoryItems(turns) {
    const items = [];
    turns.forEach((turn) => {
      if (turn.role !== 'user') return;
      const text = (turn.element?.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text) return;
      const anchorId = ensureAnchorId(turn.element);
      items.push({ anchorId, text });
    });
    return items;
  }

  function renderDirectory(items) {
    if (!UI.directoryContainer) return;
    // 使用安全方式清空容器，避免 Trusted Types 违规
    while (UI.directoryContainer.firstChild) {
      UI.directoryContainer.removeChild(UI.directoryContainer.firstChild);
    }

    if (!items.length) {
      const empty = CommonUtil.createElement('div', {
        className: 'aihub-directory-empty',
        text: '未检测到用户提问'
      });
      UI.directoryContainer.appendChild(empty);
      return;
    }

    items.forEach((item, idx) => {
      const row = CommonUtil.createElement('div', {
        className: 'aihub-directory-item',
        text: `${idx + 1}. ${item.text.length > 60 ? `${item.text.slice(0, 60)}...` : item.text}`
      });
      row.dataset.anchorId = item.anchorId;
      UI.directoryContainer.appendChild(row);
    });
  }

  function updateDirectory() {
    if (!currentAdapter) return;
    const turns = currentAdapter.getTurns();
    const items = buildDirectoryItems(turns);
    const signature = items.map((item) => `${item.anchorId}:${item.text.slice(0, 80)}`).join('|');
    if (signature === directorySignature) return;
    directorySignature = signature;
    renderDirectory(items);
  }

  function updateStatus(message) {
    if (!UI.status) return;
    UI.status.textContent = message;
    UI.status.style.display = message ? 'block' : 'none';
  }

  function updateFormatUI() {
    if (!UI.formatSelector) return;
    UI.formatSelector.querySelectorAll('.aihub-format-option').forEach((el) => {
      el.classList.toggle('selected', el.dataset.format === currentFormat);
    });
  }

  function setFormat(format) {
    currentFormat = format;
    updateFormatUI();
    updateChatgptExportAllVisibility();
    updateStatus('导出格式已切换为: ' + format.toUpperCase());
    if (chrome?.storage?.local) chrome.storage.local.set({ [STORAGE_KEY]: format });
    setTimeout(() => { if (UI.status && /导出格式已切换/.test(UI.status.textContent)) updateStatus(''); }, 2000);
  }

  function loadFormat() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      const next = res[STORAGE_KEY];
      if (next === 'txt' || next === 'json' || next === 'md') currentFormat = next;
      else currentFormat = DEFAULT_FORMAT;
      updateFormatUI();
      updateChatgptExportAllVisibility();
    });
  }

  function loadChatgptMode() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get([STORAGE_KEY_CHATGPT_MODE], (res) => {
      const v = res[STORAGE_KEY_CHATGPT_MODE];
      if (v === 'api' || v === 'dom') chatgptExportMode = v;
      updateChatgptModeUI();
      updateChatgptExportAllVisibility();
    });
  }

  function setChatgptMode(mode) {
    if (mode !== 'api' && mode !== 'dom') return;
    chatgptExportMode = mode;
    if (chrome?.storage?.local) chrome.storage.local.set({ [STORAGE_KEY_CHATGPT_MODE]: mode });
    updateChatgptModeUI();
    updateChatgptExportAllVisibility();
    updateStatus('ChatGPT 导出方式: ' + (mode === 'api' ? 'API (推荐)' : '通用'));
    setTimeout(() => { if (UI.status && /ChatGPT 导出方式/.test(UI.status.textContent)) updateStatus(''); }, 2000);
  }

  function updateChatgptModeUI() {
    if (!UI.exportModeSelector) return;
    UI.exportModeSelector.querySelectorAll('.aihub-export-mode-option').forEach((el) => { el.classList.toggle('selected', el.dataset.mode === chatgptExportMode); });
  }

  function updateChatgptExportAllVisibility() {
    if (!UI.exportAllButton) return;
    const show = currentAdapter?.id === 'chatgpt' && chatgptExportMode === 'api' && (currentFormat === 'json' || currentFormat === 'md');
    UI.exportAllButton.style.display = show ? 'inline-flex' : 'none';
  }

  function escapeMd(s) {
    return s.replace(/`/g, '\u0060').replace(/</g, '&lt;');
  }

  function buildChatExport(turns, title, platform) {
    const mode = currentFormat;
    // 使用统一文件命名: 平台-北京时间-对话名称.后缀
    const buildFilename = (ext) => FileNaming.build(platform, title, ext);

    if (mode === 'json') {
      const payload = turns.map((turn, idx) => ({
        role: turn.role,
        content: (turn.element?.textContent || '').trim(),
        id: `${idx}-${turn.role}`
      }));
      return {
        blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
        filename: buildFilename('json')
      };
    }

    if (mode === 'md') {
      const timeStr = FileNaming.getBeijingTimeStr();
      let md = `# ${title || '对话导出'}\n\n导出时间：${timeStr}\n\n`;
      turns.forEach((turn, idx) => {
        const raw = turn.html || turn.element?.innerHTML || turn.element?.textContent || '';
        const content = HtmlToMarkdown.to(raw, platform);
        const roleLabel = turn.role === 'user' ? '用户' : 'AI';
        md += `## ${roleLabel} ${Math.floor(idx / 2) + 1}\n\n`;
        md += `${escapeMd(content)}\n\n---\n\n`;
      });
      return {
        blob: new Blob([md], { type: 'text/markdown;charset=utf-8' }),
        filename: buildFilename('md')
      };
    }

    let body = `对话导出\n=========================================\n\n`;
    turns.forEach((turn) => {
      const roleLabel = turn.role === 'user' ? '用户' : 'AI';
      const text = (turn.element?.textContent || '').trim();
      body += `--- ${roleLabel} ---\n${text}\n\n------------------------------\n\n`;
    });
    body = body.replace(/\n\n------------------------------\n\n$/, '\n').trim();
    return {
      blob: new Blob([body], { type: 'text/plain;charset=utf-8' }),
      filename: buildFilename('txt')
    };
  }

  // 提取 Canvas 内容（包括代码和文本）
  // 返回 Promise 以支持异步点击切换
  async function extractCanvasContent() {
    const canvasData = [];
    const seen = new Set();
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // 内部帮助函数：滚动提取 Monaco 内容
    async function extractScrollableMonaco(panel) {
      try {
        const scrollable = panel.querySelector('.monaco-scrollable-element');
        const linesContainer = panel.querySelector('.view-lines, .lines-content');
        if (!scrollable || !linesContainer) return null;

        const { scrollHeight, clientHeight } = scrollable;
        // 只有当内容显著超过容器高度时才滚动
        if (scrollHeight <= clientHeight + 50) return null;

        const originalScrollTop = scrollable.scrollTop;
        const lineMap = new Map();
        let currentScroll = 0;
        const maxAttempts = 150;

        for (let i = 0; i < maxAttempts && currentScroll < scrollHeight; i++) {
          scrollable.scrollTop = currentScroll;
          await wait(80);
          const lines = linesContainer.querySelectorAll('.view-line');
          lines.forEach(line => {
            const top = parseInt(line.style.top || '0', 10);
            if (!isNaN(top)) lineMap.set(top, line.textContent || '');
          });
          currentScroll += clientHeight;
        }
        scrollable.scrollTop = originalScrollTop;

        if (lineMap.size === 0) return null;
        return Array.from(lineMap.entries()).sort((a, b) => a[0] - b[0]).map(e => e[1]).join('\n');
      } catch (e) {
        console.error('Scroll extraction failed', e);
        return null;
      }
    }

    // 查找所有的 immersive-panel 并锁定可见面板
    const panels = Array.from(document.querySelectorAll('immersive-panel, code-immersive-panel'));
    let targetPanel = panels.find(p => {
      const rect = p.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) || panels[0];

    if (targetPanel) {
      // 切换到代码模式
      const tabGroup = targetPanel.querySelector('mat-button-toggle-group');
      if (tabGroup) {
        const codeTab = Array.from(tabGroup.querySelectorAll('mat-button-toggle')).find(
          tab => tab.textContent?.includes('代码') || tab.textContent?.toLowerCase().includes('code')
        );
        if (codeTab && !codeTab.classList.contains('mat-button-toggle-checked')) {
          const btn = codeTab.querySelector('button');
          if (btn) btn.click();
          let attempts = 0;
          while (attempts < 30) {
            await wait(100);
            if (targetPanel.querySelectorAll('.view-line').length > 5) break;
            attempts++;
          }
        }
      }

      let codeContent = '';

      // 策略1: 滚动提取 (针对长文件)
      if (typeof updateStatus === 'function') updateStatus('正在扫描 Canvas 代码...');
      const scrolledContent = await extractScrollableMonaco(targetPanel);
      if (scrolledContent) codeContent = scrolledContent;

      // 策略2: 简单提取 (短文件或失败回退)
      if (!codeContent) {
        // 再次确认加载
        let viewLines = targetPanel.querySelectorAll('.view-line');
        // 如果行数过少，多等一会儿
        if (viewLines.length <= 1) { await wait(500); viewLines = targetPanel.querySelectorAll('.view-line'); }

        if (viewLines.length > 0) {
          codeContent = Array.from(viewLines).map(line => line.textContent || '').join('\n').trim();
        }

        if (!codeContent) {
          const rawEl = targetPanel.querySelector('.lines-content, .monaco-scrollable-element');
          if (rawEl) codeContent = (rawEl.textContent || '').trim();
        }

        if (!codeContent) {
          const monacoEditor = targetPanel.querySelector('.monaco-editor');
          if (monacoEditor) codeContent = (monacoEditor.textContent || '').trim();
        }
      }

      if (codeContent) {
        const key = codeContent.substring(0, 100);
        if (!seen.has(key)) {
          seen.add(key);
          const langHint = targetPanel.querySelector('[data-mode-id]')?.getAttribute('data-mode-id')
            || targetPanel.querySelector('.detected-link')?.textContent?.toLowerCase()
            || 'html';
          canvasData.push({
            type: 'code', index: canvasData.length + 1, content: codeContent.trim(), language: langHint, source: 'canvas'
          });
        }
      }
    }

    // 2. 提取页面中的代码块 (code-block)
    const codeBlocks = document.querySelectorAll('code-block, pre code, .code-block');
    codeBlocks.forEach((block) => {
      // 跳过 immersive-panel 内部的，因为已经处理过了
      if (block.closest('immersive-panel, code-immersive-panel')) return;

      const codeContent = block.textContent || block.innerText;
      if (!codeContent || !codeContent.trim()) return;
      const trimmedContent = codeContent.trim();
      const key = trimmedContent.substring(0, 100);
      if (seen.has(key)) return;
      seen.add(key);
      canvasData.push({
        type: 'code',
        index: canvasData.length + 1,
        content: trimmedContent,
        language: block.querySelector('[data-lang]')?.getAttribute('data-lang') || 'unknown',
        source: 'code-block'
      });
    });

    // 3. 如果没有找到代码块，提取响应文本作为备用
    if (canvasData.length === 0) {
      const responseElements = document.querySelectorAll('.markdown, .model-response-text');
      responseElements.forEach((element) => {
        if (element.closest('code-block') || element.querySelector('code-block')) return;
        const textContent = element.textContent || element.innerText;
        if (!textContent || !textContent.trim()) return;
        const trimmedContent = textContent.trim();
        const key = trimmedContent.substring(0, 100);
        if (seen.has(key)) return;
        seen.add(key);
        canvasData.push({
          type: 'text',
          index: canvasData.length + 1,
          content: trimmedContent,
          source: 'response'
        });
      });
    }

    return canvasData;
  }

  function formatCanvasData(canvasData, title) {
    const mode = currentFormat;
    // Canvas 导出文件名: Gemini-北京时间-Canvas_标题.后缀
    const buildFilename = (ext) => FileNaming.build('gemini', 'Canvas_' + (title || ''), ext);
    const timeStr = FileNaming.getBeijingTimeStr();

    if (mode === 'json') {
      const jsonData = {
        exportType: 'canvas',
        timestamp: timeStr,
        projectName: title,
        content: canvasData
      };
      return {
        blob: new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json;charset=utf-8' }),
        filename: buildFilename('json')
      };
    }

    if (mode === 'md') {
      let md = `# ${title} Canvas 内容导出\n\n导出时间：${timeStr}\n\n`;
      canvasData.forEach((item, idx) => {
        md += `## 内容块 ${idx + 1}\n\n`;
        if (item.type === 'code') {
          md += `**代码块** (语言: ${item.language}):\n\n\`\`\`${item.language}\n${item.content}\n\`\`\`\n\n`;
        } else if (item.type === 'text') {
          md += `**文本内容**:\n\n${escapeMd(item.content)}\n\n`;
        } else {
          md += `**完整内容**:\n\n${escapeMd(item.content)}\n\n`;
        }
        md += `---\n\n`;
      });
      return {
        blob: new Blob([md], { type: 'text/markdown;charset=utf-8' }),
        filename: buildFilename('md')
      };
    }

    let body = 'Gemini Canvas 内容导出\n=========================================\n\n';
    canvasData.forEach((item) => {
      if (item.type === 'code') {
        body += `--- 代码块 ${item.index} (${item.language}) ---\n${item.content}\n\n`;
      } else if (item.type === 'text') {
        body += `--- 文本内容 ${item.index} ---\n${item.content}\n\n`;
      } else {
        body += `--- 完整内容 ---\n${item.content}\n\n`;
      }
      body += '------------------------------\n\n';
    });
    body = body.replace(/\n\n------------------------------\n\n$/, '\n').trim();
    return {
      blob: new Blob([body], { type: 'text/plain;charset=utf-8' }),
      filename: buildFilename('txt')
    };
  }

  function formatCombinedExport(chatTurns, canvasData, title) {
    const mode = currentFormat;
    // 组合导出文件名: Gemini-北京时间-Combined_标题.后缀
    const buildFilename = (ext) => FileNaming.build('gemini', 'Combined_' + (title || ''), ext);
    const timeStr = FileNaming.getBeijingTimeStr();

    if (mode === 'json') {
      const payload = {
        exportType: 'combined',
        timestamp: timeStr,
        projectName: title,
        dialogue: chatTurns.map((turn, idx) => ({
          role: turn.role,
          content: (turn.element?.textContent || '').trim(),
          id: `${idx}-${turn.role}`
        })),
        canvas: canvasData || []
      };
      return {
        blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
        filename: buildFilename('json')
      };
    }

    if (mode === 'md') {
      let md = `# ${title} 组合导出\n\n导出时间：${timeStr}\n\n`;
      if (chatTurns.length) {
        md += '## 对话内容\n\n';
        chatTurns.forEach((turn, idx) => {
          const raw = turn.html || turn.element?.innerHTML || turn.element?.textContent || '';
          const content = HtmlToMarkdown.to(raw, currentAdapter?.id || 'gemini');
          const roleLabel = turn.role === 'user' ? '用户' : 'AI';
          md += `### ${roleLabel} ${Math.floor(idx / 2) + 1}\n\n`;
          md += `${escapeMd(content)}\n\n---\n\n`;
        });
      }
      if (canvasData && canvasData.length) {
        md += '## Canvas 内容\n\n';
        canvasData.forEach((item, idx) => {
          md += `### 内容块 ${idx + 1}\n\n`;
          if (item.type === 'code') {
            md += `**代码块** (语言: ${item.language}):\n\n\`\`\`${item.language}\n${item.content}\n\`\`\`\n\n`;
          } else if (item.type === 'text') {
            md += `**文本内容**:\n\n${escapeMd(item.content)}\n\n`;
          } else {
            md += `**完整内容**:\n\n${escapeMd(item.content)}\n\n`;
          }
          md += `---\n\n`;
        });
      }
      return {
        blob: new Blob([md], { type: 'text/markdown;charset=utf-8' }),
        filename: buildFilename('md')
      };
    }

    let body = 'Gemini 组合导出 (对话 + Canvas)\n=========================================\n\n';
    if (chatTurns.length) {
      body += '=== 对话内容 ===\n\n';
      chatTurns.forEach((turn) => {
        const roleLabel = turn.role === 'user' ? '用户' : 'AI';
        const text = (turn.element?.textContent || '').trim();
        body += `--- ${roleLabel} ---\n${text}\n\n------------------------------\n\n`;
      });
    }
    if (canvasData && canvasData.length) {
      body += '\n\n=== Canvas 内容 ===\n\n';
      canvasData.forEach((item) => {
        if (item.type === 'code') {
          body += `--- 代码块 ${item.index} (${item.language}) ---\n${item.content}\n\n`;
        } else if (item.type === 'text') {
          body += `--- 文本内容 ${item.index} ---\n${item.content}\n\n`;
        } else {
          body += `--- 完整内容 ---\n${item.content}\n\n`;
        }
        body += '------------------------------\n\n';
      });
    }
    body = body.replace(/\n\n------------------------------\n\n$/, '\n').trim();
    return {
      blob: new Blob([body], { type: 'text/plain;charset=utf-8' }),
      filename: buildFilename('txt')
    };
  }

  async function handleExportChat() {
    if (!currentAdapter) return;

    if (currentAdapter.id === 'chatgpt' && chatgptExportMode === 'api') {
      if (typeof ChatGPTAPIExport === 'undefined') { Toast.error('ChatGPT API 导出未加载，请刷新后重试。'); return; }
      if (!ChatGPTAPIExport.isConvPage()) { Toast.warning('请先打开一个具体对话以使用 API 导出当前。'); return; }
      try {
        Progress.show();
        updateStatus('准备中…');
        if (currentFormat === 'json') await ChatGPTAPIExport.exportCurrentJSON({ onProgress: updateStatus });
        else if (currentFormat === 'md') await ChatGPTAPIExport.exportCurrentMD({ onProgress: updateStatus });
        else await ChatGPTAPIExport.exportCurrentTxt({ onProgress: updateStatus });
        Progress.set(100);
        Toast.success('导出成功');
        updateStatus('导出成功');
      } catch (e) {
        console.error('导出对话失败', e);
        Toast.error('导出对话失败: ' + (e?.message || e));
        updateStatus('导出失败');
      } finally { Progress.hide(); setTimeout(() => updateStatus(''), 2000); }
      return;
    }

    if (isScrolling) return;
    isScrolling = true;
    Progress.show();
    updateStatus('正在加载完整对话...');
    UI.stopButton.disabled = false;
    UI.stopButton.style.display = 'inline-flex';

    try {
      await scrollToTopAndLoadAll(currentAdapter.messageSelectors);
      Progress.set(95);
      const turns = currentAdapter.getTurns();
      if (!turns.length) {
        Toast.warning('未检测到对话内容，请刷新后重试。');
        return;
      }
      const title = currentAdapter.getTitle();
      const pack = buildChatExport(turns, title, currentAdapter.id);
      Download.start(pack.blob, pack.filename, pack.blob.type);
      Progress.set(100);
      Toast.success('导出成功: ' + pack.filename);
      updateStatus('导出成功: ' + pack.filename);
    } catch (e) {
      console.error('导出对话失败', e);
      Toast.error('导出对话失败: ' + (e?.message || e));
      updateStatus('导出失败');
    } finally {
      isScrolling = false;
      Progress.hide();
      UI.stopButton.style.display = 'none';
      UI.stopButton.disabled = true;
      setTimeout(() => updateStatus(''), 2000);
    }
  }

  async function handleExportAll() {
    if (currentAdapter?.id !== 'chatgpt' || chatgptExportMode !== 'api') return;
    if (currentFormat !== 'json' && currentFormat !== 'md') return;
    if (typeof ChatGPTAPIExport === 'undefined' || typeof JSZip === 'undefined') { Toast.error('ChatGPT 全部导出依赖未加载，请刷新后重试。'); return; }

    exportAllState.running = true;
    exportAllState.cancel = false;
    Progress.show();
    UI.stopButton.style.display = 'inline-flex';
    UI.stopButton.disabled = false;
    UI.exportAllButton.disabled = true;

    try {
      const onProgress = (text) => {
        updateStatus(text);
        // 从文本中提取进度 (格式: 导出中：X/Y)
        const match = text.match(/(\d+)\/(\d+)/);
        if (match) {
          const [, current, total] = match;
          Progress.set((parseInt(current) / parseInt(total)) * 90);
        }
      };
      const getIsCancelled = () => exportAllState.cancel;
      if (currentFormat === 'json') await ChatGPTAPIExport.exportAllJSON({ onProgress, getIsCancelled });
      else await ChatGPTAPIExport.exportAllMD({ onProgress, getIsCancelled });
      if (exportAllState.cancel) { updateStatus('已停止'); Toast.warning('已停止'); return; }
      Progress.set(100);
      Toast.success('导出全部成功');
      updateStatus('导出全部成功');
    } catch (e) {
      if (String(e?.message || e) === '已停止') { updateStatus('已停止'); Toast.warning('已停止'); return; }
      console.error('导出全部失败', e);
      Toast.error('导出全部失败: ' + (e?.message || e));
      updateStatus('导出全部失败');
    } finally {
      exportAllState.running = false;
      Progress.hide();
      UI.stopButton.style.display = 'none';
      UI.stopButton.disabled = true;
      UI.exportAllButton.disabled = false;
      setTimeout(() => updateStatus(''), 2000);
    }
  }

  function handleStopScroll() {
    if (exportAllState.running) { exportAllState.cancel = true; updateStatus('正在停止…'); return; }
    if (!isScrolling) return;
    isScrolling = false;
    updateStatus('已停止滚动加载。');
  }

  async function handleExportCanvas() {
    if (!currentAdapter || currentAdapter.id !== 'gemini') return;
    Progress.show();
    updateStatus('正在提取 Canvas 内容...');
    try {
      Progress.set(30);
      const canvasData = await extractCanvasContent();
      if (!canvasData.length) {
        Toast.warning('未找到 Canvas 内容，请确认页面存在代码块或文档内容。');
        updateStatus('Canvas 导出失败：无内容');
        return;
      }
      Progress.set(70);
      const title = currentAdapter.getTitle();
      const pack = formatCanvasData(canvasData, title);
      Download.start(pack.blob, pack.filename, pack.blob.type);
      Progress.set(100);
      Toast.success(`Canvas 导出成功: ${pack.filename}`);
      updateStatus(`Canvas 导出成功: ${pack.filename}`);
    } catch (e) {
      console.error('Canvas 导出失败', e);
      Toast.error(`Canvas 导出失败: ${e.message}`);
      updateStatus('Canvas 导出失败');
    } finally {
      Progress.hide();
      setTimeout(() => updateStatus(''), 2000);
    }
  }

  async function handleExportCombined() {
    if (!currentAdapter || currentAdapter.id !== 'gemini') return;
    if (isScrolling) return;
    isScrolling = true;
    Progress.show();
    updateStatus('正在准备组合导出...');
    UI.stopButton.disabled = false;
    UI.stopButton.style.display = 'inline-flex';

    try {
      Progress.set(10);
      const canvasData = await extractCanvasContent();
      Progress.set(30);
      await scrollToTopAndLoadAll(currentAdapter.messageSelectors);
      Progress.set(90);
      const turns = currentAdapter.getTurns();
      const title = currentAdapter.getTitle();
      if (!turns.length && !canvasData.length) {
        Toast.warning('未检测到可导出的内容。');
        updateStatus('组合导出失败：无内容');
        return;
      }
      const pack = formatCombinedExport(turns, canvasData, title);
      Download.start(pack.blob, pack.filename, pack.blob.type);
      Progress.set(100);
      Toast.success(`组合导出成功: ${pack.filename}`);
      updateStatus(`组合导出成功: ${pack.filename}`);
    } catch (e) {
      console.error('组合导出失败', e);
      Toast.error(`组合导出失败: ${e.message}`);
      updateStatus('组合导出失败');
    } finally {
      isScrolling = false;
      Progress.hide();
      UI.stopButton.style.display = 'none';
      UI.stopButton.disabled = true;
      setTimeout(() => updateStatus(''), 2000);
    }
  }

  function bindDirectoryEvents() {
    if (!UI.directoryContainer) return;
    UI.directoryContainer.addEventListener('click', (event) => {
      const target = event.target.closest('.aihub-directory-item');
      if (!target) return;
      const anchorId = target.dataset.anchorId;
      if (!anchorId) return;
      const anchorEl = document.getElementById(anchorId);
      if (!anchorEl) return;
      anchorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('active');
      setTimeout(() => target.classList.remove('active'), 1200);
    });
  }

  function initUI() {
    UI.toggleButton = CommonUtil.createElement('div', {
      className: 'aihub-toggle',
      text: '<'
    });
    UI.panel = CommonUtil.createElement('div', { className: 'aihub-panel' });

    const header = CommonUtil.createElement('div', { className: 'aihub-header' });
    const headerTitle = CommonUtil.createElement('div', { className: 'aihub-header-title', text: 'AI 对话导出助手' });
    const headerSub = CommonUtil.createElement('div', { className: 'aihub-header-sub', text: '导出对话并查看对话目录' });
    header.appendChild(headerTitle);
    header.appendChild(headerSub);

    const tipCard = CommonUtil.createElement('div', { className: 'aihub-tip' });
    const tipTitle = CommonUtil.createElement('div', { className: 'aihub-tip-title', text: '使用提示' });
    const tipContent = CommonUtil.createElement('div', { className: 'aihub-tip-content', text: '如果是使用通用导出方式而不是API方式，导出内容如果不全，导出前建议先滚动到对话顶部，避免缺失。' });
    tipCard.appendChild(tipTitle);
    tipCard.appendChild(tipContent);

    // 对话目录独立为右侧浮层，避免放在侧边栏内部
    UI.directoryPanel = CommonUtil.createElement('div', { className: 'aihub-directory-panel' });
    const directoryHeader = CommonUtil.createElement('div', { className: 'aihub-directory-header' });
    const directoryTitle = CommonUtil.createElement('span', { text: '对话目录' });
    UI.directoryToggle = CommonUtil.createElement('button', { className: 'aihub-directory-toggle', text: '-' });
    directoryHeader.appendChild(directoryTitle);
    directoryHeader.appendChild(UI.directoryToggle);
    UI.directoryContainer = CommonUtil.createElement('div', { className: 'aihub-directory' });
    UI.directoryPanel.appendChild(directoryHeader);
    UI.directoryPanel.appendChild(UI.directoryContainer);

    // 目录折叠/展开事件
    UI.directoryToggle.addEventListener('click', () => {
      const isCollapsed = UI.directoryPanel.classList.toggle('collapsed');
      UI.directoryToggle.textContent = isCollapsed ? '+' : '-';
    });

    // 对话目录拖拽功能
    let isDragging = false;
    let currentX = 0;
    let currentY = 0;
    let initialX = 0;
    let initialY = 0;
    let xOffset = 0;
    let yOffset = 0;

    directoryHeader.addEventListener('mousedown', (e) => {
      // 点击折叠按钮时不触发拖拽
      if (e.target === UI.directoryToggle || e.target.closest('.aihub-directory-toggle')) {
        return;
      }
      isDragging = true;
      UI.directoryPanel.classList.add('dragging');
      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;
      xOffset = currentX;
      yOffset = currentY;
      UI.directoryPanel.style.transform = `translate(${currentX}px, ${currentY}px)`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        UI.directoryPanel.classList.remove('dragging');
      }
    });

    // 进度条组件
    UI.progressBar = CommonUtil.createElement('div', { className: 'aihub-progress-bar' });
    UI.progressFill = CommonUtil.createElement('div', { className: 'aihub-progress-fill' });
    UI.progressBar.appendChild(UI.progressFill);
    UI.progressBar.style.display = 'none';

    const formatSection = CommonUtil.createElement('div', { className: 'aihub-section' });
    const formatTitle = CommonUtil.createElement('div', { className: 'aihub-section-title', text: '导出格式' });
    UI.formatSelector = CommonUtil.createElement('div', { className: 'aihub-format-selector' });
    ['txt', 'json', 'md'].forEach((format) => {
      const option = CommonUtil.createElement('div', {
        className: 'aihub-format-option',
        text: format.toUpperCase(),
        attributes: { 'data-format': format }
      });
      UI.formatSelector.appendChild(option);
    });
    formatSection.appendChild(formatTitle);
    formatSection.appendChild(UI.formatSelector);

    UI.exportModeSection = CommonUtil.createElement('div', { className: 'aihub-section aihub-chatgpt-mode-section' });
    UI.exportModeSection.style.display = 'none';
    const exportModeTitle = CommonUtil.createElement('div', { className: 'aihub-section-title', text: 'ChatGPT 导出方式' });
    UI.exportModeSelector = CommonUtil.createElement('div', { className: 'aihub-format-selector' });
    [{ mode: 'api', label: 'API (推荐)' }, { mode: 'dom', label: '通用' }].forEach(({ mode, label }) => {
      const o = CommonUtil.createElement('div', { className: 'aihub-format-option aihub-export-mode-option', text: label, attributes: { 'data-mode': mode } }); UI.exportModeSelector.appendChild(o);
    });
    UI.exportModeSection.appendChild(exportModeTitle); UI.exportModeSection.appendChild(UI.exportModeSelector);

    const buttonSection = CommonUtil.createElement('div', { className: 'aihub-section' });
    UI.exportButton = CommonUtil.createElement('button', { className: 'aihub-button primary', text: '导出对话' });
    UI.exportAllButton = CommonUtil.createElement('button', { className: 'aihub-button neutral', text: '导出全部 (ZIP)' });
    UI.exportAllButton.style.display = 'none';
    UI.canvasButton = CommonUtil.createElement('button', { className: 'aihub-button success', text: '导出 Canvas' });
    UI.combinedButton = CommonUtil.createElement('button', { className: 'aihub-button neutral', text: '组合导出' });
    UI.stopButton = CommonUtil.createElement('button', { className: 'aihub-button danger', text: '停止滚动' });
    UI.stopButton.style.display = 'none';
    UI.stopButton.disabled = true;

    buttonSection.appendChild(UI.exportButton);
    buttonSection.appendChild(UI.exportAllButton);
    buttonSection.appendChild(UI.canvasButton);
    buttonSection.appendChild(UI.combinedButton);
    buttonSection.appendChild(UI.stopButton);

    UI.status = CommonUtil.createElement('div', { className: 'aihub-status' });

    // 底部版权信息
    const footer = CommonUtil.createElement('div', { className: 'aihub-footer' });
    const copyright = CommonUtil.createElement('div', { className: 'aihub-footer-text', text: '© 2026 AIhubEnhanced' });
    const repoLink = CommonUtil.createElement('a', {
      className: 'aihub-footer-link',
      text: 'GitHub 开源仓库',
      attributes: {
        href: 'https://github.com/Sxuan-Coder/AIhubEnhenced',
        target: '_blank',
        rel: 'noopener noreferrer'
      }
    });
    footer.appendChild(copyright);
    footer.appendChild(repoLink);

    UI.panel.appendChild(header);
    UI.panel.appendChild(tipCard);
    UI.panel.appendChild(formatSection);
    UI.panel.appendChild(UI.exportModeSection);
    UI.panel.appendChild(buttonSection);
    UI.panel.appendChild(UI.progressBar);
    UI.panel.appendChild(UI.status);
    UI.panel.appendChild(footer);

    document.body.appendChild(UI.toggleButton);
    document.body.appendChild(UI.panel);
    document.body.appendChild(UI.directoryPanel);

    UI.toggleButton.addEventListener('click', () => {
      const isOpen = document.body.classList.toggle('aihub-open');
      UI.toggleButton.textContent = isOpen ? '>' : '<';
    });

    UI.formatSelector.addEventListener('click', (event) => {
      const option = event.target.closest('.aihub-format-option');
      if (!option) return;
      const format = option.dataset.format;
      if (!format) return;
      setFormat(format);
    });

    UI.exportModeSelector.addEventListener('click', (event) => {
      const option = event.target.closest('.aihub-export-mode-option');
      if (!option) return;
      const mode = option.dataset.mode;
      if (mode === 'api' || mode === 'dom') setChatgptMode(mode);
    });

    UI.exportButton.addEventListener('click', handleExportChat);
    UI.exportAllButton.addEventListener('click', handleExportAll);
    UI.canvasButton.addEventListener('click', handleExportCanvas);
    UI.combinedButton.addEventListener('click', handleExportCombined);
    UI.stopButton.addEventListener('click', handleStopScroll);

    bindDirectoryEvents();
    updateFormatUI();
  }

  function updatePlatformButtons() {
    const isGemini = currentAdapter?.id === 'gemini';
    const isChatgpt = currentAdapter?.id === 'chatgpt';
    UI.canvasButton.style.display = isGemini ? 'inline-flex' : 'none';
    UI.combinedButton.style.display = isGemini ? 'inline-flex' : 'none';
    if (UI.exportModeSection) UI.exportModeSection.style.display = isChatgpt ? 'flex' : 'none';
    updateChatgptModeUI();
    updateChatgptExportAllVisibility();
  }

  function startDirectoryObserver() {
    if (!currentAdapter) return;
    const root = document.body;
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      // 防抖：避免频繁更新
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        updateDirectory();
      }, 300);
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function init() {
    currentAdapter = detectAdapter();
    if (!currentAdapter) return;
    if (currentAdapter.id === 'gemini') document.body.classList.add('aihub-gemini');
    startThemeSync();
    initUI();
    updatePlatformButtons();
    loadFormat();
    loadChatgptMode();

    // 延迟更新目录，等待 SPA 页面渲染完成
    updateDirectory();
    setTimeout(() => updateDirectory(), 1000);
    setTimeout(() => updateDirectory(), 3000);

    startDirectoryObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
