import { Logger } from 'slf';
const LOG = Logger.getLogger('scomp:core')

const PathProxyFactory = (path) =>
  new Proxy(function () {
    console.log('calling', path, arguments);
  }, {

      get: (target, name) => PathProxyFactory(path + '/' + name)
    });

export class Scomp {
  constructor(wire) {
    this._wire = wire;
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
    return PathProxyFactory('');
  }
}
