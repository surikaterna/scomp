import { Scomp, ScompHeader } from '../scomp';
export interface Path {
    path: string;
    params: Array<any>;
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
declare const pathProxyFactory: (path: string, scomp: Scomp, paths: Path[], headers?: ScompHeader) => any;
export default pathProxyFactory;
