"use strict";
exports.__esModule = true;
var slf_1 = require("slf");
var LOG = slf_1.LoggerFactory.getLogger('scomp:proxy');
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
var pathProxyFactory = function (path, scomp, paths, headers) {
    if (headers === void 0) { headers = {}; }
    return new Proxy(function () { }, {
        get: function (target, name) {
            LOG.info('get::', path, name);
            return pathProxyFactory(path + "/" + String(name), scomp, paths, headers);
        },
        apply: function (target, thisArg, argumentsList) {
            if (path === '/then') {
                return new Promise(function (resolve, reject) {
                    LOG.info('calling', JSON.stringify(paths));
                    scomp.request(paths, null, headers).then(function (res) {
                        LOG.info('Proxy response', res);
                        if (argumentsList && argumentsList.length > 0) {
                            argumentsList[0](res);
                        }
                        resolve(res);
                    })["catch"](function (err) {
                        reject(err);
                    });
                });
            }
            else {
                LOG.info('else calling', argumentsList, path);
                paths.push({ path: path, params: argumentsList });
                return pathProxyFactory('', scomp, paths, headers);
            }
        }
    });
};
exports["default"] = pathProxyFactory;
//# sourceMappingURL=PathProxyFactory.js.map