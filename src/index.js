import {Logger} from 'slf';
const LOG = Logger.getLogger('scomp:core')

export class Scomp {
  constructor(wire) {
    this._wire = wire;
  }

  request(req) {
    this._wire(req);
  }

  client() {
    LOG.info('client builder');
  }
}
