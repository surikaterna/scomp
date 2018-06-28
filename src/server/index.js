import { Logger } from 'slf';
const LOG = Logger.getLogger('scomp:server');

const reflectionHandler = (obj, path) => obj[path];

export class ScompServer {
  constructor(scomp) {
    this._paths = {};
    this._scomp = scomp;
    this._scomp._wire.on('req', (packet) => {
      LOG.info('Request ', packet);
      const paths = packet.path.split('/').filter(x => x);
      LOG.info('Paths ', paths);
      LOG.info('Params ', packet.params);
      if (this._paths[paths[0]]) {
        LOG.info('Found handler ', this._paths[paths[0]]);
        this._paths[paths[0]].obj[paths[1]](...packet.params, {
          response: (res) => {
            LOG.info('Prepare response ', packet.id, res);
            this._scomp.response(packet.id, res);
          }
        });
      }
    });
  }

  use(path, obj, handler = reflectionHandler) {
    this._paths[path] = { obj, handler };
  }
}
