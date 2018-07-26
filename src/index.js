import { Logger } from 'slf';
import NullWire from './null';
import { EventEmitter } from 'events';
import Promise from 'bluebird';
import Observable from './Observable';
import pathProxyFactory from './util/pathProxyFactory.js';

export { ScompServer } from './server';
const LOG = Logger.getLogger('scomp:core');

export class Scomp extends EventEmitter {
  constructor(wire) {
    super();
    this._requestId = 0;
    this._responseId = 0;
    this._requests = {};
    this._responses = {};
    this._wire = wire || new NullWire();
    this._wire.on('res', (packet) => this._onPacket(packet));
  }

  _onPacket(packet) {
    const packetId = `${packet.id}`;
    LOG.info('onPacket %d', packetId);
    if (this._requests[packetId]) {
      if (packet.sub && packet.sub.type === 'observable') {
        this._handleObservablePacket(packet);
      } else {
        if (packet.err) {
          this._requests[packetId].reject(packet.err);
        } else {
          this._requests[packetId].resolve(packet.res);
        }
        delete this._requests[packetId];
      }
    } else {
      throw new Error(`No request handler found for ${packet.id}`);
    }
  }

  /**
   * Creates a new observable if not exists for packet.id
   */
  _handleObservablePacket(packet) {
    const packetId = `${packet.id}`;
    if (this._requests[packetId].observable) {
      if (packet.err) {
        this._requests[packetId].observable._onError(packet.err);
      } else {
        this._requests[packetId].observable._onNext(packet.res);
      }
    } else {
      this._requests[packetId].observable = new Observable(() => {
      });
      this._requests[packetId].observable.controller = pathProxyFactory(`/controller/${packet.sub.id}`, this, []);
      
      this._requests[packetId].observable.onUnsubscribe(() => {
        this._unsubscribe(packet);
      });
      this._requests[packetId].resolve(this._requests[packetId].observable);
    }
  }

  _parseError(error) {
    return (error instanceof Error) ? JSON.stringify({ message: error.message }) : error;
  }

  _unsubscribe(packet) {
    this.client()._server.unsubscribe({ id: packet.sub.id }).then(() => {
      delete this._requests[`${packet.id}`];
    });
  }


  unsubscribe(id) {
    LOG.info('Unsubscribe ', id);
    if (this._responses[id]) {
      this._responses[id].unsubscribe();
      delete this._responses[id];
    } else {
      throw new Error(`No subscription found for response ${id}`);
    }
  }

  response(id, res, err) {
    LOG.info('Response ', id, res);
    if (res && res.onNext) {
      //TODO remake response id, make safe
      const responseId = `${this._responseId++}`;
      this._responses[responseId] = res;
      res.onNext((next) => {
        this._wire.send('res', {
          id,
          res: next,
          sub: { id: responseId, type: 'observable' }
        });
      });
      res.onError(error => {
        this._wire.send('res', {
          id,
          err: this._parseError(error),
          sub: { id: responseId, type: 'observable' }
        });
      });
    } else {
      this._wire.send('res', {
        id,
        res,
        err: this._parseError(err)
      });
    }
  }

  request(path, params) {
    const requestId = `${this._requestId++}`;
    return new Promise((resolve, reject) => {
      LOG.info('Request ', path, params);
      this._waitForResponse(requestId, resolve, reject);
      if (path instanceof Array) {
        this._wire.send('req', {
          id: requestId,
          paths: path
        });
      } else {
        this._wire.send('req', {
          id: requestId,
          path,
          params
        });
      }
    });
  }

  _waitForResponse(id, resolve, reject) {
    LOG.info('Waiting for response %d.', id);
    this._requests[`${id}`] = { resolve, reject };
  }

  _getObservable(id) {
    return this._responses[id];
  }

  // on req
  // on sub
  // on res
  // on connect
  // on disconnect
  // on reconnect
  // on error

  client() {
    LOG.info('client builder');
    return pathProxyFactory('', this, []);
  }
}

