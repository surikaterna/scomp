"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
exports.__esModule = true;
var ServerSocketWire_1 = __importDefault(require("./socket/ServerSocketWire"));
var Observable_1 = __importDefault(require("./Observable"));
var slf_1 = require("slf");
var ScompServer_1 = require("./server/ScompServer");
var scomp_1 = require("./scomp");
slf_1.LoggerFactory.setFactory(function (e) { return console.log(e.name, e.params.join(' ')); });
var serverWire = new ServerSocketWire_1["default"]({ bidirectional: false });
var server = new ScompServer_1.ScompServer(new scomp_1.Scomp(serverWire));
var port = 3001;
server.use('timeService', {
    tick: function (ms) {
        var state = {};
        return new Observable_1["default"](function (next) {
            var run = function () {
                try {
                    next(new Date().getTime());
                }
                catch (e) {
                    console.log(e);
                }
            };
            state._interval = setInterval(run, ms);
        }).onUnsubscribe(function () {
            clearInterval(state._interval);
        });
    }
});
console.log('Server listening on port ', port);
serverWire.listen();
//# sourceMappingURL=testServer.js.map