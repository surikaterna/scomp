import { Logger } from 'slf';
import NullWire from './null';
import { EventEmitter } from 'events';
import Promise from 'bluebird';
import Observable from './Observable';

export { ScompServer } from './server';


const LOG = Logger.getLogger('scomp:core')

const PathProxyFactory = (path, scomp) =>
  new Proxy(function (...params) {
    return new Promise((resolve, reject) => {
      LOG.info('calling', path, params);
      scomp.request(path, params).then((res) => {
        resolve(res);
      });
    });
  }, {
    get: (target, name) => PathProxyFactory(path + '/' + name, scomp)
  });


class ValueObservable extends Observable {
  constructor(value) {
    super();
    this._pendingValues = [];
    this._pendingValues.push(value);
  }

  onNext(fn) {
    super.onNext(fn);
    return this;
  }

  set(value) {
    this._pendingValues.push(value);
    this._pushValues();
  }

  _pushValues() {
    if (this._onNext) {
      this._pendingValues.forEach((value, index) => {
        this._onNext(value);
        this._pendingValues.splice(index, 1);
      });
    }
  }

}

export class Scomp extends EventEmitter {
  constructor(wire) {
    super();
    this._id = 0;
    this._requests = {};
    this._wire = wire || new NullWire();
    this._wire.on('res', (packet) => this._onPacket(packet));
  }

  _onPacket(packet) {
    // TODO need to check response for observable
    if (this._requests[packet.id]) {
      if (packet.err) {
        this._requests[packet.id].reject(packet.err);
      } else {
        if (this._requests[packet.id].observable) {
          this._requests[packet.id].observable.set(packet.res);
        } else {
          this._requests[packet.id].observable = new ValueObservable(packet.res);
          this._requests[packet.id].resolve(this._requests[packet.id].observable);
        }
      }
      //delete this._requests[packet.id];
    }
  }

  response(id, res) {
    this._wire.emit('res', {
      id,
      res
    });
  }

  request(path, params) {
    const requestId = this._id++;
    return new Promise((resolve, reject) => {
      LOG.info('Request ', path, params);
      this._wire.emit('req', {
        id: requestId,
        path,
        params
      });
      this._waitForResponse(requestId, resolve, reject);
    });
  }

  _waitForResponse(id, resolve, reject) {
    this._requests[id] = { resolve, reject };
    console.log( this._requests);
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
    return PathProxyFactory('', this);
  }
}

