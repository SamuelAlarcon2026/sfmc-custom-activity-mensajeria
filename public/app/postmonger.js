/*
 * Postmonger-compatible client for Salesforce Marketing Cloud Journey Builder.
 *
 * This file is intentionally defensive because different SFMC tenants/frames can
 * accept slightly different postMessage envelopes. The important call remains:
 *
 *   const connection = new Postmonger.Session();
 *   connection.trigger('ready');
 *
 * It sends the official Postmonger envelope and a legacy key/data envelope.
 */
(function (window) {
  'use strict';

  function safeJsonParse(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (_err) {
      return null;
    }
  }

  function parseMessage(event) {
    var data = safeJsonParse(event.data);
    if (!data || typeof data !== 'object') return null;

    var name = null;
    var payload;

    // Official Postmonger shape:
    // { method: 'trigger', args: ['initActivity', activity] }
    if (data.method === 'trigger' && Array.isArray(data.args) && data.args.length) {
      name = data.args[0];
      payload = data.args.length > 2 ? data.args.slice(1) : data.args[1];
    }

    // Legacy / lightweight shapes:
    if (!name) {
      name = data.event || data.key || data.name || data.type;
      if (Object.prototype.hasOwnProperty.call(data, 'data')) {
        payload = data.data;
      } else if (Object.prototype.hasOwnProperty.call(data, 'payload')) {
        payload = data.payload;
      } else if (Object.prototype.hasOwnProperty.call(data, 'value')) {
        payload = data.value;
      }
    }

    if (!name) return null;
    return { name: name, payload: payload, raw: data };
  }

  function Session() {
    this._handlers = {};
    this._target = window.parent && window.parent !== window ? window.parent : window.opener;
    this._targetOrigin = '*';

    var self = this;
    this._listener = function (event) {
      var message = parseMessage(event);
      if (!message) return;

      var handlers = self._handlers[message.name] || [];
      handlers.forEach(function (handler) {
        try {
          handler(message.payload, message.raw);
        } catch (err) {
          window.console && window.console.error && window.console.error('[Postmonger handler error]', err);
        }
      });
    };

    window.addEventListener('message', this._listener, false);
  }

  Session.prototype.on = function (eventName, callback) {
    if (!this._handlers[eventName]) this._handlers[eventName] = [];
    this._handlers[eventName].push(callback);
    return this;
  };

  Session.prototype.off = function (eventName, callback) {
    if (!this._handlers[eventName]) return this;
    if (!callback) {
      delete this._handlers[eventName];
      return this;
    }
    this._handlers[eventName] = this._handlers[eventName].filter(function (handler) {
      return handler !== callback;
    });
    return this;
  };

  Session.prototype._post = function (message) {
    if (!this._target || !this._target.postMessage) return;

    // Official Postmonger implementations generally listen to JSON strings.
    try {
      this._target.postMessage(JSON.stringify(message), this._targetOrigin);
    } catch (_err) {}

    /*
     * Some wrappers listen to raw objects. Send this as an additional fallback.
     * Journey Builder ignores duplicate/unknown messages, and duplicate "ready"
     * events are safe.
     */
    try {
      this._target.postMessage(message, this._targetOrigin);
    } catch (_err2) {}
  };

  Session.prototype.trigger = function (eventName) {
    var args = Array.prototype.slice.call(arguments);
    var payload = args.length > 1 ? args[1] : undefined;

    // Official Postmonger envelope.
    this._post({
      method: 'trigger',
      args: args
    });

    // Legacy envelope used by some examples/harnesses.
    this._post({
      key: eventName,
      data: payload
    });

    return this;
  };

  Session.prototype.destroy = function () {
    window.removeEventListener('message', this._listener, false);
    this._handlers = {};
  };

  window.Postmonger = window.Postmonger || {};
  window.Postmonger.Session = Session;
})(window);
