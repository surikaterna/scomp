import { EventEmitter } from 'events';
import { Logger } from 'slf';
const LOG = Logger.getLogger('scomp:wire:null')

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
 * Wire responsible for transferring data，should keep connection alive or reconnect if necessary
 */
export default class NullWire extends EventEmitter {
  send(event, packet) {
    LOG.info('send %j', packet);
    console.log('send %j', packet);
    this._fromClient(event, packet);
  }
  _fromClient(event, packet) {
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