import { Logger } from 'slf';

const LOG = Logger.getLogger('scomp:proxy');

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
const pathProxyFactory = (path, scomp, paths) =>
  new Proxy(function ( ...params) {
  }, {
    get: (target, name) => pathProxyFactory(`${path}/${name}`, scomp, paths),
    apply: (target, thisArg, argumentsList) => {
      if (path === '/then') {
        return new Promise((resolve, reject) => {
          LOG.info('calling', paths);
          scomp.request(paths).then((res) => {
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
        paths.push({ path, params: argumentsList });
        return pathProxyFactory('', scomp, paths);
      }
    }
  });

export default pathProxyFactory;
