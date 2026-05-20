/*
 * Postmonger local compatibility bridge for Salesforce Marketing Cloud Journey Builder.
 *
 * Why this file exists:
 * - Some SFMC tenants accept the classic Postmonger envelope { key, type, args }.
 * - Some shells accept the newer method/args envelope.
 * - The modal can sit behind the Journey Builder loading overlay if "ready" is
 *   sent in only one unsupported shape.
 *
 * This bridge sends a small compatibility burst for outbound events and parses
 * all common inbound shapes. It stops being noisy because main.js stops sending
 * ready as soon as initActivity is received.
 */
(function (window) {
  'use strict';

  function safeParse(data) {
    if (typeof data !== 'string') return data;
    try {
      return JSON.parse(data);
    } catch (_err) {
      return null;
    }
  }

  function getTargets() {
    var targets = [];

    function add(target) {
      if (!target || target === window) return;
      if (targets.indexOf(target) === -1) targets.push(target);
    }

    try { add(window.parent); } catch (_err) {}
    try { add(window.top); } catch (_err2) {}
    try { add(window.opener); } catch (_err3) {}

    return targets;
  }

  function normalizeInbound(raw) {
    var data = safeParse(raw);
    if (!data || typeof data !== 'object') return null;

    var name = null;
    var args = [];

    // Shape: { method: "trigger", args: ["initActivity", activity] }
    if (data.method === 'trigger' && Array.isArray(data.args) && data.args.length) {
      name = data.args[0];
      args = data.args.slice(1);
    }

    // Shape: { type: "trigger", key: "initActivity", args: [activity] }
    if (!name && data.type === 'trigger') {
      name = data.key || data.name || data.event;
      if (Array.isArray(data.args)) {
        args = data.args;
      } else if (Array.isArray(data.data)) {
        args = data.data;
      } else if (Object.prototype.hasOwnProperty.call(data, 'data')) {
        args = [data.data];
      } else if (Object.prototype.hasOwnProperty.call(data, 'payload')) {
        args = [data.payload];
      }
    }

    // Shape: { event: "initActivity", data: activity } or { key: "initActivity", data: activity }
    if (!name) {
      name = data.event || data.key || data.name;

      if (Array.isArray(data.args)) {
        args = data.args;
      } else if (Array.isArray(data.data)) {
        args = data.data;
      } else if (Object.prototype.hasOwnProperty.call(data, 'data')) {
        args = [data.data];
      } else if (Object.prototype.hasOwnProperty.call(data, 'payload')) {
        args = [data.payload];
      } else if (Object.prototype.hasOwnProperty.call(data, 'value')) {
        args = [data.value];
      }
    }

    // Very defensive fallback: { type: "initActivity", data: activity }
    if (!name && data.type && data.type !== 'trigger') {
      name = data.type;
      if (Array.isArray(data.args)) {
        args = data.args;
      } else if (Object.prototype.hasOwnProperty.call(data, 'data')) {
        args = [data.data];
      } else if (Object.prototype.hasOwnProperty.call(data, 'payload')) {
        args = [data.payload];
      }
    }

    if (!name) return null;

    return {
      name: String(name),
      args: args,
      raw: data
    };
  }

  function Session() {
    this.handlers = {};
    this.targets = getTargets();

    var self = this;

    this.listener = function (event) {
      var message = normalizeInbound(event.data);
      if (!message) return;

      var handlers = self.handlers[message.name] || [];
      handlers.forEach(function (handler) {
        try {
          handler.apply(null, message.args);
        } catch (err) {
          window.setTimeout(function () {
            throw err;
          }, 0);
        }
      });
    };

    window.addEventListener('message', this.listener, false);
  }

  Session.prototype.on = function (eventName, handler) {
    this.handlers[eventName] = this.handlers[eventName] || [];
    this.handlers[eventName].push(handler);
    return this;
  };

  Session.prototype.off = function (eventName, handler) {
    if (!this.handlers[eventName]) return this;

    if (!handler) {
      delete this.handlers[eventName];
      return this;
    }

    this.handlers[eventName] = this.handlers[eventName].filter(function (item) {
      return item !== handler;
    });

    return this;
  };

  Session.prototype._post = function (message) {
    var targets = this.targets && this.targets.length ? this.targets : getTargets();

    targets.forEach(function (target) {
      try {
        target.postMessage(JSON.stringify(message), '*');
      } catch (_err) {}

      // A few SFMC shells and test harnesses use raw object listeners.
      try {
        target.postMessage(message, '*');
      } catch (_err2) {}
    });
  };

  Session.prototype.trigger = function (eventName) {
    var args = Array.prototype.slice.call(arguments, 1);

    /*
     * Compatibility set. This is intentional: the Journey Builder parent ignores
     * unknown envelopes, but accepts one of these depending on shell version.
     */
    this._post({
      method: 'trigger',
      args: [eventName].concat(args)
    });

    this._post({
      type: 'trigger',
      key: eventName,
      args: args
    });

    this._post({
      event: eventName,
      data: args.length <= 1 ? args[0] : args
    });

    this._post({
      key: eventName,
      data: args.length <= 1 ? args[0] : args
    });

    return this;
  };

  Session.prototype.destroy = function () {
    window.removeEventListener('message', this.listener, false);
    this.handlers = {};
  };

  window.Postmonger = window.Postmonger || {};
  window.Postmonger.Session = Session;
})(window);
