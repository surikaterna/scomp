import { Logger } from 'slf';
import sprintf from 'sprintf-js';
const LOG = Logger.getLogger('scomp:server');

const reflectionHandler = (obj, path) => obj[path];
const isLastIndex = (array, index) => array.length - 1 === index;

export class ScompServer {
  constructor(scomp) {
    this._paths = {};
    this._scomp = scomp;
    this._scomp._wire.on('req', this._onPacket.bind(this));

    this.use('controller', this._controllerProxy());
    this.use('_server', this._serverHandler());
  }

  _controllerProxy() {
    return new Proxy(function ( ...params) {
    }, {
      get: (target, name) => {
        const o = this._scomp._getObservable(name);
        if (o) {
          return o.getController();
        }
        return undefined;
      }
    });
  }

  _serverHandler() {
    return {
      unsubscribe: (packet) => {
        this._scomp.unsubscribe(packet.id);
      }
    };
  }


  /**
   * [
   *  {path: '/a/b', params: [ param1 ]}
   *  , {path: '/c/d' params: [ param2 ]
   * ]
   */
  async _onPacket(packet) {
    LOG.info('Incoming request %d %j', packet.id, JSON.stringify(packet));
    let target;
    let commands = packet.paths;
    if (!packet.paths) {
      commands = [{ path: packet.path, params: packet.params }];
    }
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      const paths = command.path.split('/').filter(x => x);
      if (paths.length === 0) {
        this._handleError(packet, 'Path is empty!');
      }
      let index = 0;
      if (target || this._paths[paths[0]]) {
        target = target || this._paths[paths[index++]].obj;
        if (target === undefined || target === null) {
          this._handleError(packet, 'No target found for path %s.', command.path);
        }
        for (let j = index; j < paths.length; j++) {
          if (isLastIndex(paths, j)) {
            if (isLastIndex(commands, i)) {
              try {
                this._scomp.response(packet.id, await target[paths[j]](...command.params));
                break;
              } catch (err) {
                this._scomp.response(packet.id, null, err);
                break;
              }
            } else {
              target = await target[paths[j]](...command.params);
            }
          } else {
            target = target[paths[j]];
          }
          if (!target) {
            this._handleError(packet, 'Target is undefined for %s on %s.', paths[j], command.path);
          }
        }
      } else {
        this._handleError(packet, 'No binding for %s.', command.path);
      }
    }
  }

  _handleError(packet, message, ...params) {
    let m;
    try {
      m = sprintf.sprintf(message, ...params);
    } catch (e) {
      m = message;
    }
    const error = new Error(m);
    LOG.error(message, ...params);
    this._scomp.response(packet.id, null, error);
    throw error;
  }

  _observableUnsubscribe(packet) {
    this._scomp.unsubscribe(packet.sub.id);
  }

  use(path, obj, handler = reflectionHandler) {
    this._paths[path] = { obj, handler };
  }
}
