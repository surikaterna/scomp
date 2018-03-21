import { Logger } from 'slf';
import NullWire from './null';
import { EventEmitter } from 'events';
export { ScompServer } from './server';
const LOG = Logger.getLogger('scomp:core')

const PathProxyFactory = (path, wire) =>
  new Proxy(function (...params) {
    LOG.info('calling', path, params);
    wire.send({
      id: 123,
      svc: path,
      params
    });
  }, {
      get: (target, name) => PathProxyFactory(path + '/' + name, wire)
    });

export class Scomp extends EventEmitter {
  constructor(wire) {
    super();
    this._wire = wire || new NullWire();
    this._wire.on('data', packet => console.log('PP', packet));
  }

  request(req) {
    this._wire(req);
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
    return PathProxyFactory('', this._wire);
  }
}

