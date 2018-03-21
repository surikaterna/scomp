import { Logger } from 'slf';
const LOG = Logger.getLogger('scomp:server');

const reflectionHandler = (obj, path) => obj[path];

export class ScompServer {
  constructor(scomp) {
    this._paths = {};
    this._scomp = scomp;
    this._scomp.on('req', (packet) => {
      LOG.info('server req %j', packet);
    });
  }

  use(path, obj, handler = reflectionHandler) {
    this._paths[path] = { obj, handler };
  }
}
