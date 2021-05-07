"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
exports.__esModule = true;
var eventemitter2_1 = require("eventemitter2");
var slf_1 = require("slf");
var LOG = slf_1.LoggerFactory.getLogger('scomp:wire:null');
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
var NullWire = /** @class */ (function (_super) {
    __extends(NullWire, _super);
    function NullWire() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    NullWire.prototype.send = function (event, packet) {
        LOG.info('send %j', packet);
        console.log('send %j', packet);
        this._fromClient(event, packet);
    };
    NullWire.prototype._fromClient = function (event, packet) {
        this.emit(event, packet);
    };
    return NullWire;
}(eventemitter2_1.EventEmitter2));
exports["default"] = NullWire;
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
//# sourceMappingURL=null.js.map