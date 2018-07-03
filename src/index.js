import { Logger } from 'slf';
import NullWire from './null';
import { EventEmitter } from 'events';
import Promise from 'bluebird';
import Observable from './Observable';

export { ScompServer } from './server';


const LOG = Logger.getLogger('scomp:core')

const PathProxyFactory = (path, scomp, paths) =>
  new Proxy(function (...params) {
  }, {
    get: (target, name) => PathProxyFactory(path + '/' + name, scomp, paths),
    apply: (target, thisArg, argumentsList) => {
      if (path === '/then') {
        return new Promise((resolve, reject) => {
          LOG.info('calling', paths);
          scomp.request(paths).then((res) => {
            LOG.info('Proxy response', res);
            argumentsList[0](res);
            resolve(res);
          });
        });
      } else {
        paths.push({ path, params: argumentsList });
        return PathProxyFactory('', scomp, paths);
      }
    }
  });

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
    LOG.info('onPacket ', packet.id, packet.res, packet.err);
    if (this._requests[packet.id]) {
      if (packet.err) {
        this._requests[packet.id].reject(packet.err);
      } else {
        if (packet.sub && packet.sub.type === 'observable') {
          if (this._requests[packet.id].observable) {
            this._requests[packet.id].observable._onNext(packet.res);
          } else {
            this._requests[packet.id].observable = new Observable(() => {
            });
            this._requests[packet.id].resolve(this._requests[packet.id].observable);
          }
        } else {
          this._requests[packet.id].resolve(packet.res);
          delete this._requests[packet.id];
        }
      }
      
    }
  }

  response(id, res) {
    LOG.info('Response ', id, res);
    if (res instanceof Observable) {
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
      res.onError(err => {
        this._wire.emit('res', {
          id,
          err,
          sub: { id: responseId, type: 'observable' }
        });
      });
    } else {
      this._wire.emit('res', {
        id,
        res
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
        this._wire.emit('req', {
          id: requestId,
          paths: path
        });
      } else {
        this._wire.emit('req', {
          id: requestId,
          path,
          params
        });
      }
    });
  }

  _waitForResponse(id, resolve, reject) {
    LOG.info('Waiting for response ', id);
    this._requests[id] = { resolve, reject };
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
    return PathProxyFactory('', this, []);
  }
}

