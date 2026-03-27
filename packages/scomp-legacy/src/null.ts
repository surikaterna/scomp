import { EventEmitter2 } from 'eventemitter2';
import { LoggerFactory } from 'slf';
import WireInterface from './WireInterface';
const LOG = LoggerFactory.getLogger('scomp:wire:null')

/*
class Observable {
  constructor(fn) {
    fn({
      onNext: this._onNext.bind(this),
      onError: this._onNext.bind(this),
      onComplete: this._onNext.bind(this)
    });
  }

  unsubscribe() {

  }

  isUnsubscribed() {

  }
}
*/

/**
 * In-memory wire used mainly for local testing and debugging.
 */
export default class NullWire extends EventEmitter2 implements WireInterface {
  /** Emits packets locally instead of sending them over a network transport. */
  send<T = any>(event: string, packet: T) {
    LOG.info('send %j', packet);
    console.log('send %j', packet);
    this._fromClient(event, packet);
  }
  /** Internal client-side packet bridge used by {@link send}. */
  _fromClient(event: string, packet: any) {
    this.emit(event, packet);
  }
}

/*
const req = {
  id: 123123121,
  svc: '$scomp',
  meth: 'authenticate',
  params: []
};

const res = {
  id: 213123,
  res: {}, // user data
  sub: {}, // subscription control data
  err: {} // error
};

const ev = {
  id: 123123123, // corresponds to
  seq: 0, // sequence of events, start at 0
  res: {}, // user data
  sub: {}, // subscription control data
  err: {} // error
};


const viewdb = Scomp.asProxy('viewdb');
viewdb.toArray('collection', )

const server = new ScompServer(scomp);
//server.install(Module);

server.service('viewdb').on('query', (collection, query, options) => {

});

server.service('viewdb').on('query', (collection, query, options) => {

});

*/