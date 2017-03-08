import {Logger} from 'slf';
const LOG = Logger.getLogger('scomp:core')

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
  }
}
