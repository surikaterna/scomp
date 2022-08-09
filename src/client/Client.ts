import Wire from '../wire/Wire';

const recursiveProxy = (path, paths) => {
  return new Proxy(function (...params) {}, {
    get: (target, name) => recursiveProxy(`${path}/${name.toString()}`, paths),
    apply: (target, thisArg, argumentsList) => {
      if (path === '/then') {
        const promise = new Promise((resolve, reject) => {
            console.log('*** scomp request', JSON.stringify(paths, null, 4), path, argumentsList);
          resolve(12);
        });
        return promise.then.apply(promise, argumentsList);
      } else {
        paths.push({ path, params: argumentsList });
        return recursiveProxy('', paths);
      }
    }
  });
};
export default class Client {
  constructor(private wire: Wire) {}
  link<T extends Object>(namespace: string): T {
    return recursiveProxy(namespace, []);
  }
}

// class ScompLink<T> extends Proxy<T> {

// }
