/* dc-lite: a tiny runtime for the portfolio pages.
   Each page keeps its markup in <template id="dc"> with {{holes}}, <sc-if> and <sc-for>,
   and its logic in <script type="text/x-dc"> as `class Component extends DCLogic`.
   This file renders the template once into real DOM, then updates only the holes when
   state changes, so elements persist and CSS transitions / Web Animations keep playing. */
(function () {
  'use strict';

  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;

  function lookup(path, scope) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return parseFloat(path);
    if (/^(['"]).*\1$/.test(path)) return path.slice(1, -1);
    var parts = path.split('.');
    var v = scope(parts[0]);
    for (var i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
    return v;
  }
  function str(v) { return v == null || v === false || v === true ? '' : String(v); }
  function interp(tpl, scope) { return tpl.replace(HOLE, function (_, p) { return str(lookup(p, scope)); }); }

  // Split an inline style into declarations, respecting quotes and parentheses.
  function splitDecls(s) {
    var out = [], cur = '', depth = 0, q = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { if (c === q) q = ''; cur += c; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  }
  DCLogic.prototype.setState = function (u, cb) {
    var host = this.__host;
    if (!host) { // before mount (constructor): apply directly
      var p0 = typeof u === 'function' ? u(this.state, this.props) : u;
      if (p0) this.state = Object.assign({}, this.state, p0);
      if (cb) cb.call(this);
      return;
    }
    host.queue.push(u);
    if (cb) host.cbs.push(cb);
    host.schedule();
  };
  DCLogic.prototype.forceUpdate = function (cb) {
    if (!this.__host) return;
    if (cb) this.__host.cbs.push(cb);
    this.__host.schedule();
  };
  DCLogic.prototype.renderVals = function () { return {}; };
  window.DCLogic = DCLogic;

  function Host(inst) {
    this.inst = inst;
    this.queue = [];
    this.cbs = [];
    this.updaters = [];
    this.vals = {};
    this.pending = false;
    var self = this;
    this.scope = function (name) { return self.vals[name]; };
  }
  Host.prototype.schedule = function () {
    if (this.pending) return;
    this.pending = true;
    var self = this;
    Promise.resolve().then(function () { self.flush(); });
  };
  Host.prototype.flush = function () {
    this.pending = false;
    var inst = this.inst, st = inst.state;
    var q = this.queue; this.queue = [];
    for (var i = 0; i < q.length; i++) {
      var p = typeof q[i] === 'function' ? q[i](st, inst.props) : q[i];
      if (p) st = Object.assign({}, st, p);
    }
    inst.state = st;
    this.vals = inst.renderVals() || {};
    run(this.updaters);
    var cbs = this.cbs; this.cbs = [];
    if (typeof inst.componentDidUpdate === 'function') { try { inst.componentDidUpdate(); } catch (e) { console.error(e); } }
    cbs.forEach(function (cb) { try { cb.call(inst); } catch (e) { console.error(e); } });
  };
  function run(list) { for (var i = 0; i < list.length; i++) list[i](); }

  // Bind every hole inside `root` (a node already detached from the template), pushing updaters.
  function bind(node, scope, ups, host) {
    if (node.nodeType === 3) {
      var t = node.nodeValue;
      if (t.indexOf('{{') < 0) return;
      var last;
      var u = function () { var v = interp(t, scope); if (v !== last) { node.nodeValue = v; last = v; } };
      u(); ups.push(u);
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.tagName.toLowerCase();
    if (tag === 'sc-if' || tag === 'sc-for') { block(node, tag, scope, ups, host); return; }
    if (tag === 'template') return;
    var attrs = Array.prototype.slice.call(node.attributes);
    attrs.forEach(function (a) {
      var name = a.name, val = a.value;
      if (name.indexOf('data-dc-') === 0) { node.removeAttribute(name); name = name.slice(8); }
      if (name.indexOf('hint-') === 0) { node.removeAttribute(name); return; }
      if (val.indexOf('{{') < 0) {
        if (name === 'ref') node.removeAttribute(name);
        return;
      }
      var whole = val.match(WHOLE);
      if (name === 'ref') {
        node.removeAttribute(name);
        var r = whole ? lookup(whole[1], scope) : null;
        host.refs.push(function () { if (typeof r === 'function') r(node); else if (r && typeof r === 'object') r.current = node; });
        return;
      }
      if (/^on[a-z]/.test(name)) { // events: onClick -> click
        node.removeAttribute(name);
        var ev = name.slice(2).toLowerCase();
        var path = whole ? whole[1] : '';
        node.addEventListener(ev, function (e) { var fn = lookup(path, scope); if (typeof fn === 'function') return fn(e); });
        return;
      }
      if (name === 'style') {
        var decls = splitDecls(val);
        var stat = [], dyn = [];
        decls.forEach(function (d) {
          var k = d.indexOf(':'); if (k < 0) return;
          var prop = d.slice(0, k).trim(), v = d.slice(k + 1).trim();
          var imp = /!important\s*$/.test(v); if (imp) v = v.replace(/!important\s*$/, '').trim();
          if (v.indexOf('{{') < 0) stat.push(d.trim()); else dyn.push({ prop: prop, tpl: v, imp: imp, last: null });
        });
        node.setAttribute('style', stat.join('; '));
        var su = function () {
          dyn.forEach(function (d) {
            var w = d.tpl.match(WHOLE);
            var v = w ? lookup(w[1], scope) : interp(d.tpl, scope);
            v = v == null || v === false ? '' : String(v);
            if (v === d.last) return;
            d.last = v;
            if (v === '') node.style.removeProperty(d.prop); else node.style.setProperty(d.prop, v, d.imp ? 'important' : '');
          });
        };
        su(); ups.push(su);
        return;
      }
      var lastA;
      var au = function () {
        var v = whole ? lookup(whole[1], scope) : interp(val, scope);
        if (v === lastA) return;
        lastA = v;
        if (v == null || (v === false && !/^(data|aria)-/.test(name))) node.removeAttribute(name);
        else node.setAttribute(name, String(v));
      };
      au(); ups.push(au);
    });
    Array.prototype.slice.call(node.childNodes).forEach(function (c) { bind(c, scope, ups, host); });
  }

  function block(el, tag, scope, ups, host) {
    var parent = el.parentNode;
    var start = document.createComment(tag), end = document.createComment('/' + tag);
    parent.insertBefore(start, el);
    parent.insertBefore(end, el);
    parent.removeChild(el);
    var tpl = document.createDocumentFragment();
    while (el.firstChild) tpl.appendChild(el.firstChild);
    var valTpl = (el.getAttribute(tag === 'sc-if' ? 'value' : 'list') || '').match(WHOLE);
    var asName = el.getAttribute('as') || 'item';
    function clear() { while (start.nextSibling && start.nextSibling !== end) start.parentNode.removeChild(start.nextSibling); }
    if (tag === 'sc-if') {
      var on = null, inner = [];
      ups.push(function () {
        var v = !!(valTpl && lookup(valTpl[1], scope));
        if (v !== on) {
          on = v; clear(); inner = [];
          if (v) {
            var frag = tpl.cloneNode(true);
            Array.prototype.slice.call(frag.childNodes).forEach(function (c) { bind(c, scope, inner, host); });
            end.parentNode.insertBefore(frag, end);
            host.flushRefs();
          }
        } else run(inner);
      });
    } else {
      var items = [], curList = [];
      ups.push(function () {
        var list = (valTpl && lookup(valTpl[1], scope)) || [];
        curList = list;
        if (list.length !== items.length) {
          clear(); items = [];
          list.forEach(function (_, i) {
            var inner = [];
            var sc = function (n) { return n === asName ? curList[i] : n === '$index' ? i : scope(n); };
            var frag = tpl.cloneNode(true);
            Array.prototype.slice.call(frag.childNodes).forEach(function (c) { bind(c, sc, inner, host); });
            end.parentNode.insertBefore(frag, end);
            items.push(inner);
          });
          host.flushRefs();
        } else items.forEach(run);
      });
    }
  }

  function boot() {
    var tpl = document.getElementById('dc');
    var code = document.querySelector('script[type="text/x-dc"]');
    if (!tpl || !code) return;
    var props = {};
    try {
      var dp = JSON.parse(code.getAttribute('data-props') || '{}');
      Object.keys(dp).forEach(function (k) { if (k[0] !== '$' && dp[k] && 'default' in dp[k]) props[k] = dp[k].default; });
    } catch (e) {}
    var Component = new Function('DCLogic', code.textContent + '\n;return Component;')(DCLogic);
    var inst = new Component(props);
    var host = new Host(inst);
    host.refs = [];
    host.flushRefs = function () { var r = host.refs; host.refs = []; r.forEach(function (f) { f(); }); };
    host.vals = inst.renderVals() || {};
    var frag = tpl.content.cloneNode(true);
    var holder = document.createElement('div');
    holder.appendChild(frag);
    var helmet = holder.querySelector('helmet');
    if (helmet) helmet.parentNode.removeChild(helmet);
    Array.prototype.slice.call(holder.childNodes).forEach(function (c) { bind(c, host.scope, host.updaters, host); });
    var mount = document.createDocumentFragment();
    while (holder.firstChild) mount.appendChild(holder.firstChild);
    tpl.parentNode.insertBefore(mount, tpl);
    host.flushRefs();
    inst.__host = host;
    if (typeof inst.componentDidMount === 'function') inst.componentDidMount();
    window.addEventListener('pagehide', function () { if (typeof inst.componentWillUnmount === 'function') { try { inst.componentWillUnmount(); } catch (e) {} } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
