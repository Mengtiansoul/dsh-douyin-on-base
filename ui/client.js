/**
 * ui/client.js — 「抖音助手」设置面板（浏览器半身）
 *
 * 契约：宿主只认「已构建的 __ModuleLoader__ bundle」，require 只能拿到基座模块
 * （react 在里面），所以这里用 createElement 手写组件 —— 零构建、零第三方依赖。
 *
 * 挂载位：settings.section（官方给仓库外插件预留的整页设置位）。
 * 数据来源（ui/host.mjs）：
 *   GET  /douyin/api/config   → { config(apiKey 掩码), defaults, state, files }
 *   POST /douyin/api/config   → 触发写 config.json，工具下一次调用生效
 *   GET  /douyin/api/state    → 今日状态（只读）
 *
 * 设计纪律：
 *   · 改动先落本地草稿，只有点「保存」才 POST（避免边打字边写盘）
 *   · apiKey 留空 = 不修改（面板只回显掩码，永远不回传明文）
 *   · 任何网络/格式失败都降级成一行可读提示，绝不把设置页搞白屏
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-on-base-ui',
  factory: function (require) {
    var React = require('react');
    var h = React.createElement;
    var module = { exports: {} };
    var exports = module.exports;

    var API = '/douyin/api';
    /** 保存开始时间：用来保证「保存中…」至少显示 SAVE_MIN_MS */
    var savingStartedAt = 0;
    /** 两个按钮的最小反馈时长（ms）——放最前面，避免 var 提升让 refreshState 读到 undefined */
    var SAVE_MIN_MS = 900;

    /** UTF-8 安全的 base64（btoa 只吃 latin1，直接塞中文会抛错） */
    function b64EncodeUtf8(str) {
      var bytes = new TextEncoder().encode(str);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }

    /** hooks 兜底：宿主基座 shim 不完整时降级成静态渲染 */
    var useState = typeof React.useState === 'function' ? React.useState : function (v) { return [v, function () {}]; };
    var useEffect = typeof React.useEffect === 'function' ? React.useEffect : function () {};

    // 请求一律带超时：宿主路由要是卡住，界面会一直显示"保存中…"，看着像按钮坏了
    var REQ_TIMEOUT_MS = 10000;

    function doFetch(path, init) {
      var opts = Object.assign({ headers: { accept: 'application/json' } }, init || {});
      try { opts.signal = AbortSignal.timeout(REQ_TIMEOUT_MS); } catch (e) { /* 老浏览器没有 AbortSignal.timeout */ }
      return fetch(API + path, opts).then(function (r) {
        return r.text().then(function (txt) {
          var body = null;
          try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = { ok: false, error: '响应不是 JSON: ' + String(txt).slice(0, 120) }; }
          return { ok: r.ok, status: r.status, body: body };
        });
      });
    }

    function getJson(path) { return doFetch(path, {}); }

    function postJson(path, payload) {
      return doFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    // —— 视觉尺度 ——
    // 圆角同心：外层 14 → 内嵌块 10 → 控件 8，每层差 4，圆心对齐。
    // 描边一律拿 inset 阴影画，不用 border：hover / 聚焦只改阴影颜色，
    // 不会有「选中时加粗把盒子撑大 1px」的抖动。
    var R = { card: '14px', block: '10px', control: '8px', pill: '999px' };
    var EDGE = 'var(--dsw-alias-border-l2, rgba(127,127,127,.3))';
    var EDGE_SOFT = 'var(--dsw-alias-border-l3, rgba(127,127,127,.16))';
    var SH = {
      card: 'inset 0 0 0 1px ' + EDGE_SOFT + ', 0 1px 2px rgba(15,23,42,.04), 0 10px 24px -16px rgba(15,23,42,.30)',
      control: 'inset 0 0 0 1px ' + EDGE + ', 0 1px 1px rgba(15,23,42,.03)',
      block: 'inset 0 0 0 1px ' + EDGE_SOFT,
    };
    var NUM = { fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1' };

    /** 文件名按「省略号放在后缀前」截断：很长的名字变成 很长…很长的名字.md */
    function shortName(name, max) {
      var s = String(name || '');
      max = max || 30;
      if (s.length <= max) return s;
      var dot = s.lastIndexOf('.');
      var ext = dot > 0 ? s.slice(dot) : '';
      var base = dot > 0 ? s.slice(0, dot) : s;
      if (ext.length >= max - 4) return s.slice(0, max - 1) + '…';
      var keep = Math.max(4, max - ext.length - 1);
      return base.slice(0, keep) + '…' + ext;
    }

    var C = {
      wrap: { padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '760px' },
      card: {
        borderRadius: R.card, padding: '16px 18px', boxShadow: SH.card,
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
        display: 'flex', flexDirection: 'column', gap: '12px',
      },
      title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))', lineHeight: '1.6' },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      label: { width: '150px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, inherit)', flexShrink: 0 },
      input: {
        flex: 1, minWidth: 0, height: '32px', padding: '0 10px', borderRadius: R.control, fontSize: '13px',
        boxShadow: SH.control, border: 'none',
        background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', outline: 'none',
      },
      num: { width: '110px', height: '32px', padding: '0 10px', borderRadius: R.control, fontSize: '13px',
        boxShadow: SH.control, border: 'none',
        background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', outline: 'none',
        fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1' },
      area: { width: '100%', minHeight: '84px', padding: '10px', borderRadius: R.control, fontSize: '13px',
        boxShadow: SH.control, border: 'none',
        background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', outline: 'none',
        fontFamily: 'inherit', resize: 'vertical' },
      btn: { height: '34px', minWidth: '88px', padding: '0 18px', borderRadius: R.control, cursor: 'pointer',
        fontSize: '13px', fontWeight: 600, color: '#fff', border: 'none',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.14), 0 1px 2px rgba(15,23,42,.18)',
        background: '#2f6fed' },
      btnGhost: { height: '32px', padding: '0 12px', borderRadius: R.control, cursor: 'pointer', fontSize: '13px',
        boxShadow: SH.control, border: 'none', background: 'transparent', color: 'inherit' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
      kv: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 12px', borderRadius: R.block,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))' },
      k: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))' },
      v: { fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)',
        fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1' },
      // Tab 三态共用同一套盒模型：字重、内边距、高度都不随选中变，
      // 否则 400→600 的字重一换，文本宽度就变，按钮跟着被撑大。
      tabBase: { height: '32px', padding: '0 16px', borderRadius: R.control, cursor: 'pointer',
        fontSize: '13px', fontWeight: 600, fontFamily: 'inherit', border: 'none',
        transition: 'background .15s ease, color .15s ease, box-shadow .15s ease' },
      msg: { fontSize: '12px', padding: '8px 10px', borderRadius: R.control,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1))' },
    };

    function Panel() {
      var loaded = useState(null);
      var cfg = loaded[0], setCfg = loaded[1];
      var errState = useState(''), setErr = errState[1];
      var err = errState[0];
      var infoState = useState(''), setInfo = infoState[1];
      var info = infoState[0];
      var st = useState(null);
      var stateData = st[0], setState = st[1];
      var savingState = useState(false);
      var setSaving = savingState[1];
      var saving = savingState[0];
      // 保存成功后的短暂提示态（约 2 秒），让点击有明确的完成感
      var savedState = useState(false);
      var justSaved = savedState[0];
      var setJustSaved = savedState[1];
      // 刷新按钮的转圈状态（用户要的视觉反馈）
      var refreshingState = useState(false);
      var setRefreshing = refreshingState[1];
      var refreshing = refreshingState[0];
      // 刷新成功的短暂提示态（2 秒），跟保存按钮保持一致的完成感
      var refreshedState = useState(false);
      var justRefreshed = refreshedState[0];
      var setJustRefreshed = refreshedState[1];

      // 三页：general=总设置 / content=内容模块 / social=社交模块
      var tabState = useState('general');
      var tab = tabState[0], setTab = tabState[1];
      var rstState = useState(false);
      var resetting = rstState[0], setResetting = rstState[1];
      var rpState = useState(null);
      var report = rpState[0], setReport = rpState[1];
      useEffect(function () {
        getJson('/report').then(function (r) {
          if (r && r.ok && r.body && r.body.ok) setReport(r.body.report);
        }).catch(function () { });
      }, []);
      // 群/好友清单（给白名单勾选）
      var chState = useState(null);
      var channels = chState[0], setChannels = chState[1];
      useEffect(function () {
        getJson('/channels').then(function (r) {
          if (r && r.ok && r.body && r.body.ok && r.body.channels) setChannels(r.body.channels);
        }).catch(function () { });
      }, []);

      // 草稿：vision / limits
      var draft = useState(null);
      var d = draft[0], setD = draft[1];

      function hydrate(data) {
        setCfg(data.config);
        setState(data.state || null);
        setD({
          apiKey: '',
          apiBase: data.config.vision.apiBase || '',
          model: data.config.vision.model || '',
          fallbacks: (data.config.vision.fallbacks || []).join(', '),
          prompt: data.config.vision.prompt || '',
          timeoutSec: data.config.vision.timeoutSec,
          browseMinutes: data.config.limits.browseMinutes,
          groupForwards: data.config.limits.groupForwards,
          privateForwards: data.config.limits.privateForwards,
          replies: data.config.limits.replies,
          minDigg: data.config.limits.minDigg,
          browse: !!(data.config.features && data.config.features.browse),
          like: !!(data.config.features && data.config.features.like),
          favorite: !!(data.config.features && data.config.features.favorite),
          comment: !!(data.config.features && data.config.features.comment),
          share: !!(data.config.features && data.config.features.share),
          chat: !!(data.config.features && data.config.features.chat),
          commentsPerDay: (data.config.limits && data.config.limits.commentsPerDay) || 0,
          mContent: !!(data.config.modules && data.config.modules.content),
          mSocial: !!(data.config.modules && data.config.modules.social),
          schWindows: (function () {
            var s = data.config.schedule || {};
            if (Array.isArray(s.windows)) return s.windows.map(function (w) { return { start: (w && w.start) || '', end: (w && w.end) || '' }; });
            return [];
          })(),
          prefKeywords: ((data.config.preferences && data.config.preferences.keywords) || []).join('，'),
          aiEnabled: !!(data.config.autoInteract && data.config.autoInteract.enabled),
          aiMinScore: (data.config.autoInteract && data.config.autoInteract.minScore) || 7,
          aiLike: !!(data.config.autoInteract && data.config.autoInteract.like),
          aiFav: !!(data.config.autoInteract && data.config.autoInteract.favorite),
          sPersona: data.config.social && data.config.social.personaFile || '',
          sTrigger: data.config.social && data.config.social.trigger || 'mention',
          sDailyLimit: data.config.social && data.config.social.dailyReplyLimit || 40,
          sChPrivate: !!(data.config.social && data.config.social.channels && data.config.social.channels.private),
          sChGroup: !!(data.config.social && data.config.social.channels && data.config.social.channels.group),
          sGroups: ((data.config.social && data.config.social.groupWhitelist) || []).join('，'),
          sFriends: ((data.config.social && data.config.social.friendWhitelist) || []).join('，'),
          sGap: data.config.social && data.config.social.sendGapMs || 400,
          sSegs: data.config.social && data.config.social.maxSegments || 8,
          sSticker: !!(data.config.social && data.config.social.allowSticker),
          sCard: !!(data.config.social && data.config.social.allowCard),
          sOutbox: !!(data.config.social && data.config.social.allowOutbox),
        });
      }

      useEffect(function () {
        getJson('/config').then(function (r) {
          if (r.ok && r.body && r.body.ok) { hydrate(r.body); setErr(''); }
          else setErr('读取配置失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
        }).catch(function (e) { setErr('读取配置失败：' + (e && e.message ? e.message : e)); });
      }, []);

      var refreshStartedAt = 0;

      function refreshState() {
        if (refreshing) return;
        setRefreshing(true);
        setJustRefreshed(false);
        refreshStartedAt = Date.now();
        var settle = function (ok, payload, errMsg) {
          // 和保存按钮一样：哪怕瞬时完成，也至少让「刷新中…」露 0.9 秒
          var wait = Math.max(0, SAVE_MIN_MS - (Date.now() - refreshStartedAt));
          var finish = function () {
            setRefreshing(false);
            if (ok) {
              setState(payload);
              setJustRefreshed(true);
              setTimeout(function () { setJustRefreshed(false); }, 2000);
            } else {
              setErr('刷新失败：' + errMsg);
            }
          };
          if (wait > 0) setTimeout(finish, wait); else finish();
        };
        getJson('/state').then(function (r) {
          if (r.ok && r.body && r.body.ok) settle(true, r.body.state);
          else settle(false, null, (r.body && r.body.error) || ('HTTP ' + r.status));
        }).catch(function (e) {
          settle(false, null, e && e.message ? e.message : e);
        });
      }

      /** 时间段下拉（00:00–23:30，30 分钟一档；空 = 不限） */
      function timeSelect(key, val) {
        var opts = [h('option', { value: '', key: 'none' }, '不限')];
        for (var hh = 0; hh < 24; hh++) {
          for (var mi = 0; mi < 60; mi += 30) {
            var v = (hh < 10 ? '0' : '') + hh + ':' + (mi === 0 ? '00' : '30');
            opts.push(h('option', { value: v, key: v }, v));
          }
        }
        return h('select', {
          style: C.input,
          value: val || '',
          onChange: function (e) {
            var nv = e.target.value;
            setD(function (prev) { var n = Object.assign({}, prev); n[key] = nv; return n; });
          },
        }, opts);
      }

      /** 下拉（value + onChange 版本，给多时段行用） */
      function timeSelectVal(val, onChange) {
        var opts = [h('option', { value: '', key: 'none' }, '--:--')];
        for (var hh = 0; hh < 24; hh++) {
          for (var mi = 0; mi < 60; mi += 30) {
            var v = (hh < 10 ? '0' : '') + hh + ':' + (mi === 0 ? '00' : '30');
            opts.push(h('option', { value: v, key: v }, v));
          }
        }
        return h('select', { style: Object.assign({}, C.input, { flex: '0 0 110px' }), value: val || '', onChange: function (e) { onChange(e.target.value); } }, opts);
      }

      function updateWindow(idx, field, val) {
        setD(function (prev) {
          var n = Object.assign({}, prev);
          var arr = (n.schWindows || []).slice();
          arr[idx] = Object.assign({}, arr[idx]);
          arr[idx][field] = val;
          n.schWindows = arr;
          return n;
        });
      }

      function addWindow() {
        setD(function (prev) {
          var n = Object.assign({}, prev);
          n.schWindows = (n.schWindows || []).concat([{ start: '', end: '' }]);
          return n;
        });
      }

      function removeWindow(idx) {
        setD(function (prev) {
          var n = Object.assign({}, prev);
          var arr = (n.schWindows || []).slice();
          arr.splice(idx, 1);
          n.schWindows = arr;
          return n;
        });
      }

      /** 人设文件：拖入或选择 .md，前端读内容 → 上传 → 记住服务端路径 */
      function personaPicker() {
        function readFile(file) {
          if (!file) return;
          if (file.size > 512 * 1024) { setErr('文件太大（上限 512KB）'); return; }
          var reader = new FileReader();
          reader.onload = function () {
            postJson('/persona', { name: file.name, text: String(reader.result || '') }).then(function (r) {
              if (r && r.ok && r.body && r.body.ok) {
                setD(function (prev) { var n = Object.assign({}, prev); n.sPersona = r.body.file; return n; });
                setInfo('✅ 人设已导入：' + file.name + '（记得点保存）');
                setTimeout(function () { setInfo(''); }, 3000);
              } else {
                setErr('导入失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
              }
            }).catch(function (e) { setErr('导入失败：' + (e && e.message ? e.message : e)); });
          };
          reader.readAsText(file);
        }

        var IDLE_OUTLINE = '1px dashed rgba(127,127,127,.32)';
        var HOT_OUTLINE = '1px dashed rgba(47,111,237,.6)';
        function paint(el, hot) {
          if (!el || !el.style) return;
          el.style.outline = hot ? HOT_OUTLINE : IDLE_OUTLINE;
          el.style.background = hot ? 'rgba(47,111,237,.06)' : 'var(--dsw-alias-bg-base, rgba(127,127,127,.02))';
          el.style.boxShadow = hot
            ? '0 4px 14px -8px rgba(47,111,237,.45), 0 0 0 3px rgba(47,111,237,.10)'
            : 'none';
        }

        var current = String((d && d.sPersona) || '').split(/[\\/]/).pop();

        return h('div', { style: { marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { style: C.label }, '专用人设文件'),
          h('div', {
            style: {
              borderRadius: R.block, padding: '18px 16px', textAlign: 'center',
              outline: IDLE_OUTLINE, outlineOffset: '-1px',
              background: 'var(--dsw-alias-bg-base, rgba(127,127,127,.02))',
              boxShadow: 'none',
              transition: 'background .15s ease, outline-color .15s ease, box-shadow .15s ease',
            },
            onDragOver: function (e) { e.preventDefault(); paint(e.currentTarget, true); },
            onDragLeave: function (e) { paint(e.currentTarget, false); },
            onDrop: function (e) {
              e.preventDefault();
              paint(e.currentTarget, false);
              readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
            },
          },
            h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, '把人设 .md 文件拖到这里'),
            h('div', { style: Object.assign({}, C.hint, { margin: '5px 0 10px' }) }, '或'),
            h('label', { style: Object.assign({}, C.btnGhost, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }) },
              '选择文件',
              h('input', {
                type: 'file', accept: '.md,.txt,text/markdown,text/plain',
                style: { display: 'none' },
                onChange: function (e) { readFile(e.target.files && e.target.files[0]); },
              })
            )
          ),
          current
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                h('span', { style: Object.assign({}, C.hint, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }), title: current },
                  '当前：' + shortName(current, 30)),
                h('button', {
                  style: Object.assign({}, C.btnGhost, { height: '26px', padding: '0 10px', fontSize: '12px', flexShrink: 0 }),
                  onClick: function () { setD(function (prev) { var n = Object.assign({}, prev); n.sPersona = ''; return n; }); },
                }, '清除')
              )
            : h('div', { style: Object.assign({}, C.hint, { margin: '2px 0 0' }) }, '不传 = 用默认人设')
        );
      }

      /** 白名单勾选（群/好友），数据来自 /channels */
      function channelPicker(label, key, kind) {
        var list = (channels && channels[kind]) || [];
        var cur = String((d && d[key]) || '').split(/[，,]/).map(function (s) { return s.trim(); }).filter(Boolean);
        return h('div', { style: { marginTop: '10px' } },
          h('div', { style: C.label }, label),
          list.length === 0
            ? h('div', { style: C.hint }, channels ? '还没拉到列表（社交模块没登录过）' : '加载中…')
            : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '6px' } },
                list.map(function (it) {
                  var on = cur.indexOf(it.id) >= 0;
                  return h('button', {
                    key: it.id,
                    style: Object.assign({}, on ? C.btn : C.btnGhost, { padding: '5px 10px', fontSize: '12px' }),
                    onClick: function () {
                      var next = cur.slice();
                      var i = next.indexOf(it.id);
                      if (i >= 0) next.splice(i, 1); else next.push(it.id);
                      setD(function (prev) { var n = Object.assign({}, prev); n[key] = next.join(','); return n; });
                    },
                  }, (on ? '✓ ' : '') + (it.name || it.id));
                })
              )
        );
      }

      /** 多行文本（关键词 / 白名单） */
      function areaField(label, key, placeholder) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' } },
          h('div', { style: C.label }, label),
          h('textarea', {
            style: C.area,
            value: d ? d[key] : '',
            placeholder: placeholder || '',
            onChange: function (e) {
              var nv = e.target.value;
              setD(function (prev) { var n = Object.assign({}, prev); n[key] = nv; return n; });
            },
          })
        );
      }

      /** 重置今日用量 */
      function resetToday() {
        if (resetting) return;
        if (!window.confirm('确定把今天的用量全部清零？（浏览时长 / 点赞 / 收藏 / 评论 / 转发 / 回复）')) return;
        setResetting(true);
        postJson('/reset', {}).then(function (r) {
          setResetting(false);
          if (r && r.ok && r.body && r.body.ok) { setState(r.body.after); setInfo('✅ 今日用量已清零'); setTimeout(function () { setInfo(''); }, 2000); }
          else setErr('重置失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
        }).catch(function (e) { setResetting(false); setErr('重置失败：' + (e && e.message ? e.message : e)); });
      }

      /** 非当前 Tab 的卡片直接不显示 */
      function cardVis(which) { return tab === which ? null : { display: 'none' }; }

      function save() {
        if (!d || saving) return;
        setSaving(true); setJustSaved(false); setErr(''); setInfo('');
        savingStartedAt = Date.now();
        try {
          doSave();
        } catch (e) {
          // 同步异常（构造 patch / 序列化出错）也要把状态复位，不然按钮永远卡在"保存中…"
          setSaving(false);
          setErr('保存时抛错：' + (e && e.message ? e.message : e));
        }
      }

      /** GET 兜底：把 patch 塞进 query 里保存 */
      function saveViaGet(patch) {
        var b64 = b64EncodeUtf8(JSON.stringify(patch));
        return getJson('/config?patch=' + encodeURIComponent(b64));
      }

      function doSave() {
        var patch = {
          vision: {
            apiBase: d.apiBase,
            model: d.model,
            prompt: d.prompt,
            timeoutSec: Number(d.timeoutSec),
            fallbacks: String(d.fallbacks || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          },
          features: {
            browse: !!d.browse,
            like: !!d.like,
            favorite: !!d.favorite,
            comment: !!d.comment,
            share: !!d.share,
            chat: !!d.chat,
          },
          limits: {
            browseMinutes: Number(d.browseMinutes),
            groupForwards: Number(d.groupForwards),
            privateForwards: Number(d.privateForwards),
            replies: Number(d.replies),
            minDigg: Number(d.minDigg),
            commentsPerDay: Number(d.commentsPerDay) || 0,
          },
          modules: {
            content: !!d.mContent,
            social: !!d.mSocial,
          },
          schedule: {
            windows: (d.schWindows || []).filter(function (w) { return w && w.start && w.end; }),
          },
          preferences: {
            keywords: String(d.prefKeywords || '').split(/[，,]/).map(function (s) { return s.trim(); }).filter(Boolean),
          },
          autoInteract: {
            enabled: !!d.aiEnabled,
            minScore: Number(d.aiMinScore) || 7,
            like: !!d.like,
            favorite: !!d.favorite,
          },
          social: {
            personaFile: String(d.sPersona || '').trim(),
            trigger: d.sTrigger === 'auto' ? 'auto' : 'mention',
            dailyReplyLimit: Number(d.sDailyLimit) || 40,
            channels: { private: !!d.sChPrivate, group: !!d.sChGroup },
            groupWhitelist: String(d.sGroups || '').split(/[，,]/).map(function (s) { return s.trim(); }).filter(Boolean),
            friendWhitelist: String(d.sFriends || '').split(/[，,]/).map(function (s) { return s.trim(); }).filter(Boolean),
            sendGapMs: Number(d.sGap) || 400,
            maxSegments: Number(d.sSegs) || 8,
            allowSticker: !!d.sSticker,
            allowCard: !!d.sCard,
            allowOutbox: !!d.sOutbox,
          },
        };
        // 只有真填了新 key 才提交，留空 = 保持原样
        if (d.apiKey && d.apiKey.trim()) patch.vision.apiKey = d.apiKey.trim();

        function handleResult(r, via) {
          var wait = Math.max(0, SAVE_MIN_MS - (Date.now() - savingStartedAt));
          var ok = !!(r.ok && r.body && r.body.ok);
          var finish = function () {
            setSaving(false);
            if (ok) {
              setJustSaved(true);
              setInfo('✅ 已保存，立即生效');
              setTimeout(function () { setJustSaved(false); }, 2000);
              setTimeout(function () { setInfo(''); }, 2500);
              hydrate(r.body);
            } else {
              setErr('保存失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
            }
          };
          if (wait > 0) setTimeout(finish, wait); else finish();
        }

        // 主通道直接用 GET：实测本机浏览器里 GET 能到宿主、POST 静默挂住
        // （大概率是广告拦截/防跟踪扩展或 Service Worker 把未知 POST 拦了）。
        // 参数很小，GET 完全够用；POST 那条路留作以后别的环境再用。
        saveViaGet(patch).then(function (r) {
          handleResult(r, 'get');
        }).catch(function (e) {
          // GET 也挂了 → 最后试一次 POST
          setInfo('GET 没通，正在试 POST…');
          postJson('/config', { config: patch }).then(function (r) {
            handleResult(r, 'post');
          }).catch(function (e2) {
            setSaving(false);
            setErr('保存失败（GET 和 POST 都没通）：' + (e && e.message ? e.message : e) + ' / ' + (e2 && e2.message ? e2.message : e2));
          });
        });
      }

      function field(label, key, opts) {
        opts = opts || {};
        return h('div', { style: C.row, key: key },
          h('div', { style: C.label }, label),
          h('input', {
            style: opts.number ? C.num : C.input,
            type: opts.number ? 'number' : 'text',
            min: opts.min, max: opts.max,
            value: d ? d[key] : '',
            placeholder: opts.placeholder || '',
            onChange: function (e) {
              var v = e.target.value;
              setD(function (prev) { var n = Object.assign({}, prev); n[key] = v; return n; });
            },
          }),
          opts.suffix ? h('span', { style: C.hint }, opts.suffix) : null
        );
      }

      /** 单个功能开关（圆角按钮，点一下切状态，改动只落草稿） */
      function featureRow(key, label, hint) {
        var on = !!(d && d[key]);
        return h('div', {
          key: key,
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
            padding: '9px 0', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))',
          },
        },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' } }, label),
            hint ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))' } }, hint) : null
          ),
          h('button', {
            type: 'button',
            onClick: function () {
              setD(function (p) { var n = Object.assign({}, p); n[key] = !n[key]; return n; });
            },
            style: {
              flexShrink: 0, width: '62px', height: '28px', borderRadius: '999px', cursor: 'pointer',
              fontSize: '12px', border: 'none', transition: 'background .15s',
              color: on ? '#fff' : 'var(--dsw-alias-label-secondary, inherit)',
              background: on ? 'var(--dsw-alias-state-success-primary, #2f9e44)' : 'rgba(127,127,127,.35)',
            },
          }, on ? '开启' : '关闭')
        );
      }
      var loading = !d || !cfg;

      return h('div', { style: C.wrap },
        h('div', null,
          h('div', { style: { fontSize: '16px', fontWeight: 700 } }, '抖音助手'),
          h('div', { style: C.hint }, '改完点保存就生效，不用重启。')
        ),

        err ? h('div', { style: Object.assign({}, C.msg, { color: 'var(--dsw-alias-error-primary, #e5484d)' }) }, err) : null,
        info ? h('div', { style: C.msg }, info) : null,

        /* ---------- 三页 Tab ---------- */
        h('div', { style: { display: 'flex', gap: '8px', margin: '2px 0 12px' } },
          [['general','总设置'],['content','内容模块'],['social','社交模块']].map(function (kv) {
            var active = tab === kv[0];
            return h('button', {
              key: kv[0],
              style: Object.assign({}, C.tabBase, active
                ? { color: '#fff', background: '#2f6fed', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.14), 0 1px 2px rgba(15,23,42,.18)' }
                : { color: 'inherit', background: 'transparent', boxShadow: SH.control }),
              onClick: function () { setTab(kv[0]); },
            }, kv[1]);
          })
        ),

        /* ---------- API 配置 ---------- */
        h('div', { style: Object.assign({}, C.card, cardVis('general')) },
          h('div', { style: C.title }, '视觉模型'),
          h('div', { style: C.hint },
            cfg && cfg.vision.apiKeySet
              ? '当前 key：' + cfg.vision.apiKeyMasked + '（留空 = 不修改）'
              : '还没配 key。不配也能截图，只是要你自己看画面。'),
          loading ? null : field('API Key', 'apiKey', { placeholder: cfg.vision.apiKeySet ? '留空则不修改' : 'sk-...' }),
          loading ? null : field('API Base', 'apiBase'),
          loading ? null : field('模型', 'model', { placeholder: 'qwen3.8-omni-flash' }),
          loading ? null : field('备用模型', 'fallbacks', { placeholder: '主模型 404 时自动换（逗号分隔）' }),
          loading ? null : field('超时（秒）', 'timeoutSec', { number: true, min: 10, max: 300 }),
          loading ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: C.label }, '自定义提示词'),
            h('textarea', {
              style: C.area,
              value: d.prompt,
              placeholder: '留空则用内置的「短视频审核员」提示词（画面内容 / 内容类型 / 1-10 分 / 建议）',
              onChange: function (e) { setD(function (p) { var n = Object.assign({}, p); n.prompt = e.target.value; return n; }); },
            })
          )
        ),

        /* ---------- 功能开关 ---------- */
        h('div', { style: Object.assign({}, C.card, cardVis('content')) },
          h('div', { style: C.title }, '功能开关（危险动作默认关）'),
          h('div', { style: C.hint },
            '关掉的功能就不会再做。保存后立即生效。'
          ),
          loading ? h('div', { style: C.hint }, '加载中…') : h('div', null,
            featureRow('browse', '浏览 / 下滑', '刷视频、往下滑'),
            featureRow('like', '点赞', '给当前视频点赞'),
            featureRow('favorite', '收藏', '收藏当前视频'),
            featureRow('comment', '评论', '在视频下发评论'),
            featureRow('share', '视频转发', '把视频转发出去'),
            featureRow('aiEnabled', '自动互动', '按评分自动点赞 / 收藏')
          )
        ),
        /* ---------- 安全限额 ---------- */
        h('div', { style: Object.assign({}, C.card, cardVis('content')) },
          h('div', { style: C.title }, '安全限额（防沉迷 / 防封号）'),
          h('div', { style: C.hint }, '每天的硬上限。到了就拒绝，第二天 0 点自动重置。'),
          loading ? null : field('每日浏览上限', 'browseMinutes', { number: true, min: 1, max: 600, suffix: '分钟' }),
          loading ? null : field('群转发上限', 'groupForwards', { number: true, min: 0, max: 50, suffix: '条/天' }),
          loading ? null : field('私聊转发上限', 'privateForwards', { number: true, min: 0, max: 50, suffix: '条/天' }),
          loading ? null : field('自动回复上限', 'replies', { number: true, min: 0, max: 100, suffix: '条/天' }),
          loading ? null : field('点赞参考线', 'minDigg', { number: true, min: 0, max: 10000000, suffix: '（低于只提醒，不拦）' })
        ),

        /* ---------- 今日状态 ---------- */
        h('div', { style: Object.assign({}, C.card, cardVis('general')) },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: C.title }, '今日状态'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('button', {
              style: refreshing
                ? Object.assign({}, C.btnGhost, { background: '#8a94a6', color: '#fff', borderColor: 'transparent', cursor: 'default' })
                : (justRefreshed
                    ? Object.assign({}, C.btnGhost, { background: '#2f9e44', color: '#fff', borderColor: 'transparent', cursor: 'default' })
                    : C.btnGhost),
              disabled: refreshing,
              onClick: refreshState,
            }, refreshing ? '刷新中…' : (justRefreshed ? '✓ 已刷新' : '刷新')),
            h('button', {
              style: Object.assign({}, C.btnGhost, { marginLeft: '0' }),
              disabled: resetting,
              onClick: resetToday,
            }, resetting ? '重置中…' : '重置今日用量')
            )
          ),
          stateData
            ? h('div', { style: C.grid },
              h('div', { style: C.kv }, h('div', { style: C.k }, '浏览时长'), h('div', { style: C.v }, (stateData.browseMinutes || 0) + ' 分钟')),
              h('div', { style: C.kv }, h('div', { style: C.k }, '点赞'), h('div', { style: C.v }, stateData.likes || 0)),
              h('div', { style: C.kv }, h('div', { style: C.k }, '收藏'), h('div', { style: C.v }, stateData.favorites || 0)),
              h('div', { style: C.kv }, h('div', { style: C.k }, '评论'), h('div', { style: C.v }, stateData.comments || 0)),
              h('div', { style: C.kv }, h('div', { style: C.k }, '私信回复'), h('div', { style: C.v }, stateData.replies || 0)),
              h('div', { style: C.kv }, h('div', { style: C.k }, '转发（群/私）'), h('div', { style: C.v }, (stateData.groupForwards || 0) + ' / ' + (stateData.privateForwards || 0)))
            )
            : h('div', { style: C.hint }, '还没有今天的数据（跑一次工具就会生成 state.json）。')
        ),

        /* ---------- 总设置：最近一篇日报 ---------- */
        h('div', { style: Object.assign({}, C.card, cardVis('general')) },
          h('div', { style: C.title }, '最近一篇刷视频日报'),
          h('div', { style: C.hint }, '刷到每日上限时生成，或每天 23:59 兜底生成。'),
          report
            ? h('div', null,
                h('div', { style: C.hint }, report.file + '（共 ' + report.count + ' 篇）'),
                h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: '1.7', margin: '8px 0 0', fontFamily: 'inherit' } }, report.text)
              )
            : h('div', { style: C.hint }, '还没有日报。今天刷满上限、或过了 23:59 才会有。')
        ),

        /* ---------- 总设置：模块开关 ---------- */
        h('div', { style: Object.assign({}, C.card, cardVis('general')) },
          h('div', { style: C.title }, '模块开关'),
          h('div', { style: C.hint }, '关掉某个模块，它的工具会直接拒绝执行——不点页面、不发消息。'),
          loading ? null : h('div', null,
            featureRow('mContent', '内容模块（刷视频）', '刷视频、点赞、收藏'),
            featureRow('mSocial', '社交模块（私信 · 群）', '私信与群消息的收发')
          )
        ),

        /* ---------- 内容：可刷时段 ---------- */
        h('div', { style: Object.assign({}, C.card, cardVis('content')) },
          h('div', { style: C.title }, '每日可刷时段'),
          h('div', { style: C.hint }, '只在这几段时间内允许刷视频，可以加多条（比如中午一段、晚上一段）。一条都不加 = 全天不限。'),
          loading ? null : h('div', null,
            h('div', null, (d.schWindows || []).length
              ? (d.schWindows || []).map(function (w, idx) {
                  return h('div', { key: idx, style: Object.assign({}, C.row, { marginTop: '8px' }) },
                    timeSelectVal(w.start, function (v) { updateWindow(idx, 'start', v); }),
                    h('span', { style: C.hint }, '到'),
                    timeSelectVal(w.end, function (v) { updateWindow(idx, 'end', v); }),
                    h('button', {
                      style: Object.assign({}, C.btnGhost, { marginLeft: 'auto', padding: '5px 10px' }),
                      onClick: function () { removeWindow(idx); },
                    }, '删除')
                  );
                })
              : h('div', { style: Object.assign({}, C.hint, { marginTop: '8px' }) }, '还没添加时段 —— 现在全天都能刷。')
            ),
            h('button', {
              style: Object.assign({}, C.btnGhost, { marginTop: '10px' }),
              onClick: addWindow,
            }, '＋ 添加时间段')
          )
        ),

        /* ---------- 内容：偏好 + 阈值 ---------- */
        h('div', { style: Object.assign({}, C.card, cardVis('content')) },
          h('div', { style: C.title }, '内容偏好与互动设置'),
          h('div', { style: C.hint }, '偏好关键词会写进评估提示词，提高这类视频的互动率。'),
          loading ? null : areaField('偏好关键词（逗号分隔）', 'prefKeywords', 'DSH，AI，大肥鱼，科技前沿，风景，音乐'),
          loading ? null : field('自动互动阈值', 'aiMinScore', { number: true, min: 1, max: 10, suffix: '分（评分 ≥ 此值才动手）' }),
          loading ? null : field('每日评论上限', 'commentsPerDay', { number: true, min: 0, max: 200, suffix: '条/天（0=不限）' })
        ),

        /* ---------- 社交模块 ---------- */
        h('div', { style: Object.assign({}, C.card, cardVis('social')) },
          h('div', { style: C.title }, '社交模块'),
          h('div', { style: C.hint }, '私信与群聊只在这里配置。不依赖浏览器，也不受内容模块影响。'),
          loading ? null : personaPicker(),
          loading ? null : h('div', { style: C.row },
            h('div', { style: C.label }, '回复触发'),
            h('select', {
              style: C.input,
              value: d.sTrigger,
              onChange: function (e) {
                var nv = e.target.value;
                setD(function (prev) { var n = Object.assign({}, prev); n.sTrigger = nv; return n; });
              },
            },
              h('option', { value: 'mention' }, '群里仅 @ 才回'),
              h('option', { value: 'auto' }, '自行判断要不要回')
            )
          ),
          loading ? null : field('每日回复上限', 'sDailyLimit', { number: true, min: 0, max: 200, suffix: '条/天' }),
          loading ? null : h('div', null,
            featureRow('sChPrivate', '私信通道', '一对一私聊'),
            featureRow('sChGroup', '群聊通道', '群消息（白名单见下）')
          ),
          loading ? null : channelPicker('群白名单（不选 = 全部群）', 'sGroups', 'groups'),
          loading ? null : channelPicker('好友白名单（不选 = 全部好友）', 'sFriends', 'friends'),
          loading ? null : h('div', null,
            field('分段间隔(ms)', 'sGap', { number: true, min: 0, max: 5000 }),
            field('单轮最多几段', 'sSegs', { number: true, min: 1, max: 20 })
          ),
          loading ? null : h('div', null,
            featureRow('sSticker', '允许发收藏表情', '发你收藏的图片表情'),
            featureRow('sCard', '允许发视频卡片', '把视频以卡片形式发出去'),
            featureRow('sOutbox', '允许主动投递', '允许她主动发消息给你或群里')
          )
        ),

        /* ---------- 保存 ---------- */
        h('div', { style: C.row },
          h('button', {
            style: saving || justSaved
              ? Object.assign({}, C.btn, { background: saving ? '#8a94a6' : '#2f9e44', cursor: 'default' })
              : C.btn,
            disabled: saving || loading,
            onClick: save,
          }, saving ? '正在保存…' : (justSaved ? '✓ 已保存' : '保存')),
          h('span', { style: C.hint }, cfg && cfg.files ? '配置文件：' + cfg.files.config : '')
        )
      );
    }

    /** 错误边界：面板崩了也只坏这一块，不连累整个设置页 */
    function Boundary(props) {
      var e = useState(null);
      if (e[0]) {
        return h('div', { style: { padding: '16px', color: 'var(--dsw-alias-error-primary, #e5484d)', fontSize: '13px' } },
          '抖音助手面板渲染出错：' + String(e[0] && e[0].message ? e[0].message : e[0]));
      }
      return props.children;
    }

    /**
     * 挂载到设置页。
     * 参照 dsh-douyin-browser-local（已验证能出现在设置菜单）的写法：
     *   · 导出里必须带 inject: ['slots']，否则 ctx.slots 不保证可用；
     *   · 不套 ctx.effect，直接调即可（老插件就这么写的，能正常挂）。
     */
    function applyDouyinSettings(ctx) {
      try {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'douyin-on-base',
            order: 120,
            label: function () { return '抖音助手'; },
          }, function DouyinSettingsWithBoundary() {
            return h(Boundary, null, h(Panel, null));
          });
        });
      } catch (e) {
        return function () {};
      }
    }

    module.exports = {
      name: 'dsh-douyin-on-base-ui',
      inject: ['slots'],
      apply: applyDouyinSettings,
    };

    return module.exports;
  },
});
