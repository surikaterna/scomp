"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
exports.__esModule = true;
var ClientSocketWire_1 = __importDefault(require("./socket/ClientSocketWire"));
var scomp_1 = require("./scomp");
var slf_1 = require("slf");
slf_1.LoggerFactory.setFactory(function (e) { return console.log(e.name, e.params.join(' ')); });
var clientWire = new ClientSocketWire_1["default"]({ address: 'http://127.0.0.1/3001', bidirectional: false });
var scomp = new scomp_1.Scomp(clientWire);
clientWire.on('connect', function () {
    // proxy
    scomp.client().timeService.tick(1000).then(function (observable) {
        observable.onNext(function (time) {
            console.log('onNext ' + time);
        }).onError(function (err) {
            console.log(err);
        });
    });
});
clientWire.on('disconnect', function () {
    console.log('disconnect');
});
//# sourceMappingURL=testClient.js.map