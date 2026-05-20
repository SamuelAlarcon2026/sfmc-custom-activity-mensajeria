/* Fallback mínimo. En producción debe servirse el paquete oficial npm "postmonger". */
(function (window) {
  'use strict';
  function Session() {
    this.handlers = {};
    var self = this;
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_err) { return; }
      }
      if (!data || typeof data !== 'object') return;
      var name = data.event || data.key || data.name || data.type;
      var payload = data.data || data.payload;
      if (data.method === 'trigger' && data.args && data.args.length) {
        name = data.args[0];
        payload = data.args[1];
      }
      (self.handlers[name] || []).forEach(function (handler) { handler(payload); });
    }, false);
  }
  Session.prototype.on = function (name, handler) {
    this.handlers[name] = this.handlers[name] || [];
    this.handlers[name].push(handler);
    return this;
  };
  Session.prototype.trigger = function () {
    var args = Array.prototype.slice.call(arguments);
    var message = { method: 'trigger', args: args };
    window.parent.postMessage(JSON.stringify(message), '*');
    return this;
  };
  window.Postmonger = window.Postmonger || { Session: Session };
})(window);
