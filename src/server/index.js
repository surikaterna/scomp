import { Logger } from 'slf';
import Observable from '../Observable';
const LOG = Logger.getLogger('scomp:server');

const reflectionHandler = (obj, path) => obj[path];
const isLastIndex = (array, index) => array.length - 1 === index;

export class ScompServer {
  constructor(scomp) {
    this._paths = {};
    this._scomp = scomp;
    this._scomp._wire.on('req', (packet) => {
      LOG.info('Request ', packet);

      let commands = packet.paths;
      if (!packet.paths) {
        commands = [{ path: packet.path, params: packet.params }];
      }
      let target;
      for (let i = 0; i < commands.length; i++) {
        const command = commands[i];
        const paths = command.path.split('/').filter(x => x);
        LOG.info('Paths ', paths);
        LOG.info('Params ', command.params);
        LOG.info('Target ', target);

        let index = 0;
        if (target || this._paths[paths[0]]) {
          target = target || this._paths[paths[index++]].obj;
          LOG.info('Found handler ', target);
          for (let j = index; j < paths.length; j++) {
            if (isLastIndex(paths, j)) {
              if (isLastIndex(commands, i)) {
                this._scomp.response(packet.id, target[paths[j]](...command.params));
              } else {
                target = target[paths[j]](...command.params);
              }
            } else {
              target = target[paths[j]];
            }
          }
        }
      }
    });
  }

  use(path, obj, handler = reflectionHandler) {
    this._paths[path] = { obj, handler };
  }
}
