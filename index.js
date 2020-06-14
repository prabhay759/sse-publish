'use strict';

const url = require('url');
const EventEmitter = require('events');
const preambleData = new Array(2057).join('-') + '\n';

class SSEChannel extends EventEmitter {
  constructor(options) {
    super();
    let opts = options || {};

    let jsonEncode = (
      typeof opts.jsonEncode === 'undefined' ?
        false :
        Boolean(opts.jsonEncode)
    );

    this.jsonEncode = jsonEncode;
    this.retryTimeout = opts.retryTimeout || null;
    this.connections = [];
    this.connectionCount = 0;
  }

  /**
   * Add a new client to the channel
   *
   * @param {Request}  req        Request of the client
   * @param {Response} res        Response of the client
   * @param {string}   id         unique id of the request/response
   * @return {void}
   */
  addConnection(req, res, id = 'connectionId') {
    // Dont add the same connection for the same user Id.
    if (this.connections[id]) {
      return;
    }
    var query = url.parse(req.url, true).query || {};
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream;charset=UTF-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    res.write(':ok\n\n');
    var retry = this.retryTimeout || 0;
    if (retry) {
      res.write('retry: ' + retry + '\n');
    }

    // see https://github.com/amvtek/EventSource/wiki/UserGuide for more information.
    if (query.evs_preamble) {
      res.write(':' + preambleData);
    }

    flush(res);

    this.connections[id] = res;
    this.connectionCount = Object.values(this.connections).length;
    req.on('end', this.removeConnection.bind(this, id));
    req.on('close', this.removeConnection.bind(this, id));
    res.on('finish', this.removeConnection.bind(this, id));
    this.emit('connect', null, req, res);
  }

  /**
   * Remove the client from the channel
   *
   * @param {id} id    Connection ID
   */
  removeConnection(id) {
    this.connectionCount -= 1;
    this.emit('disconnect', this, this.connections[id]);
    delete this.connections[id];
  }

  /**
   * Tell the clients how long they should wait before reconnecting.
   * 
   * @param {Number} retryTimeout Milliseconds clients should wait before reconnecting.
   */
  retry(retryTimeout) {
    this.retryTimeout = retryTimeout;
    broadcast(Object.values(this.connections), 'retry: ' + retryTimeout + '\n');
  };

  /**
   * Publish a message to requested or all clients on the channel
   *
   * @param {Object|String} msg      Message to send to the client
   * @param {String} msg.data        Data to send to the client (will be JSON-encoded if `jsonEncode` is enabled)
   * @param {Number} msg.id          ID of the event (used by clients when reconnecting to ensure all messages are received)
   * @param {String} msg.event       Event name (used on client side to trigger on specific event names)
   * @param {String} msg.retry       Retry timeout (same as `retry()`)
   * @param {Array}  [clients]       Array of connection Id's to publish messages. Default publish to all connected clients to this server.
   */
  publish(msg, clients = []) {
    const message = parseMessage(msg, this.jsonEncode);
    let activeConnections = clients.length ?
      clients.map(clientId => this.connections[clientId]) :
      Object.values(this.connections);

    broadcast(activeConnections, message);

    this.emit('message', this, msg, activeConnections);
  };

  /**
   * Close all connections on this channel
   *
   */
  close() {
    let connectionLength = this.connections.length;
    while (connectionLength--) {
      this.connections[connectionLength].end();
    }
  };

  getConnectionCount() {
    return this.connectionCount;
  }

  getConnectionIds() {
    return Object.keys(this.connections);
  }
};

/**
 * Broadcast a packet to all requested clients
 *
 * @param  {Array}  connections Array of connections (response instances) to write to
 * @param  {String} packet      The chunk of data to broadcast
 */
function broadcast(connections, packet) {
  let connectionLength = connections.length;
  while (connectionLength--) {
    if (connections[connectionLength]) {
      connections[connectionLength].write(packet);
      flush(connections[connectionLength]);
    }
  }
}

function flush(res) {
  // Forces all currently buffered output to be sent to the client. 
  // The Flush method can be called multiple times during request processing.
  if (res.flush && res.flush.name !== 'deprecated') {
    res.flush();
  }
}

/**
 * Parse a message object (or string) into a writable data chunk
 *
 * @param  {String|Object} msg        Object or string to parse into sendable message
 * @param  {Boolean}       jsonEncode Whether to JSON-encode data parameter
 * @return {String}
 */
function parseMessage(msg, jsonEncode) {
  if (typeof msg === 'string') {
    msg = { data: msg };
  }

  let output = '';
  if (msg.event) {
    output += 'event: ' + msg.event + '\n';
  }

  if (msg.retry) {
    output += 'retry: ' + msg.retry + '\n';
  }

  if (msg.id) {
    output += 'id: ' + msg.id + '\n';
  }

  let data = msg.data || '';
  if (jsonEncode) {
    data = JSON.stringify(data);
  }

  output += parseText(data);

  return output;
}

/**
 * Parse text
 *
 * @param  {String} text
 * @return {String}
 */
function parseText(text) {
  let data = String(text).replace(/(\r\n|\r|\n)/g, '\n');
  let lines = data.split(/\n/), line;

  let output = '';
  for (let i = 0, l = lines.length; i < l; ++i) {
    line = lines[i];

    output += 'data: ' + line;
    output += (i + 1) === l ? '\n\n' : '\n';
  }

  return output;
}

module.exports = SSEChannel;
