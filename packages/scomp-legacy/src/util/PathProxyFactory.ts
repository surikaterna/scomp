import { LoggerFactory } from 'slf';
import { Scomp, ScompHeader } from '../scomp';

const LOG = LoggerFactory.getLogger('scomp:proxy');

/**
 * One method call segment represented as path plus argument list.
 */
export interface Path {
  path: string;
  params: Array<any>
}

/**
 * Creates a promise-like proxy that records chained property access and calls.
 *
 * @remarks
 * Calling .then triggers a remote request using all accumulated path segments.
 */
const pathProxyFactory = (path: string, scomp: Scomp, paths: Path[], headers: ScompHeader = {}): any =>
  new Proxy(() => {}, {
    get: (target, name) => {
      // LOG.info('get::', path, name);
      return pathProxyFactory(`${path}/${String(name)}`, scomp, paths, headers);
    },
    apply: (target, thisArg, argumentsList) => {
      if (path === '/then') {
        return new Promise((resolve, reject) => {
          LOG.info('calling', paths);
          scomp.request(paths, null, headers).then((res) => {
            LOG.info('Proxy response', res);
            if (argumentsList && argumentsList.length > 0) {
              argumentsList[0](res);
            }
            resolve(res);
          }).catch(err => {
            reject(err);
          });
        });
      } else {
        // LOG.info('else calling', argumentsList, path);
        paths.push({ path, params: argumentsList });
        return pathProxyFactory('', scomp, paths, headers);
      }
    }
  });

export default pathProxyFactory;
