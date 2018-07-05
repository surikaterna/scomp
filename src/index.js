import { Logger } from 'slf';
import NullWire from './null';
import { EventEmitter } from 'events';
import Promise from 'bluebird';
import Observable from './Observable';
import pathProxyFactory from './util/PathProxyFactory.js';

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
    // TODO need to check response for observable
    LOG.info('onPacket %d', packet.id);
    if (this._requests[packet.id]) {
      if (packet.sub && packet.sub.type === 'observable') {
        this._handleObservablePacket(packet);
      } else {
        if (packet.err) {
          this._requests[packet.id].reject(packet.err);
        } else {
          this._requests[packet.id].resolve(packet.res);
        }
        delete this._requests[packet.id];
      }
    } else {
      throw new Error('No request handler found for id %s', packet.id);
    }
  }

  /**
   * Creates a new observable if not exists for packet.id
   */
  _handleObservablePacket(packet) {
    if (this._requests[packet.id].observable) {
      if (packet.err) {
        this._requests[packet.id].observable._onError(packet.err);
      } else {
        this._requests[packet.id].observable._onNext(packet.res);
      }
    } else {
      this._requests[packet.id].observable = new Observable(() => {
      });
      this._requests[packet.id].observable.controller = pathProxyFactory(`/controller/${packet.sub.id}`, this, []);
      /*
        this._requests[packet.id].observable.onUnsubscribe(() => {
        this._unsubscribe(packet);
      });*/
      this._requests[packet.id].resolve(this._requests[packet.id].observable);
    }
  }

  _parseError(error) {
    return (error instanceof Error) ? JSON.stringify({ message: error.message }) : error;
  }

  _unsubscribe(packet) {
    this.client()._core.unsubscribe({ id: packet.sub.id }).then(() => {
      delete this._requests[packet.id];
    });
  }


  unsubscribe(id) {
    LOG.info('Unsubscribe ', id);
    if (this._responses[id]) {
      this._responses[id].unsubscribe();
    } else {
      throw new Error('No subscription found for response id %s', id);
    }
  }

  response(id, res, err) {
    LOG.info('Response ', id, res);
    if (res && res.onNext) {
      //TODO remake response id, make safe
      const responseId = this._responseId++;
      this._responses[responseId] = res;
      res.onNext((next) => {
        this._wire.emit('res', {
          id,
          res: next,
          sub: { id: responseId, type: 'observable' }
        });
      });
      res.onError(error => {
        this._wire.emit('res', {
          id,
          err: this._parseError(error),
          sub: { id: responseId, type: 'observable' }
        });
      });
    } else {
      this._wire.emit('res', {
        id,
        res,
        err: this._parseError(err)
      });
    }
  }

  request(path, params) {
    //TODO remake request id, make safe
    const requestId = this._requestId++;
    return new Promise((resolve, reject) => {
      LOG.info('Request ', path, params);
      this._waitForResponse(requestId, resolve, reject);
      if (path instanceof Array) {
        this._wire.send({
          id: requestId,
          paths: path
        });
      } else {
        this._wire.send({
          id: requestId,
          path,
          params
        });
      }
    });
  }

  _waitForResponse(id, resolve, reject) {
    LOG.info('Waiting for response %d.', id);
    this._requests[id] = { resolve, reject };
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

