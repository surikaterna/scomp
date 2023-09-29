import { LoggerFactory } from 'slf';
import { Scomp, ScompHeader } from '../Scomp';

const LOG = LoggerFactory.getLogger('scomp:proxy');

export interface Path {
  path: string;
  params: Array<any>
}

/**
 * Uses proxy class to create paths
 *
 * Example
 * a.b(param1).c.d(param2).then(...)
 *
 * Paths used for request:
 * [
 *  {path: '/a/b', params: [ param1 ]}
 *  , {path: '/c/d' params: [ param2 ]
 * ]
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
