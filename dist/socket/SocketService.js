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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
exports.__esModule = true;
exports.SocketService = void 0;
var events_1 = __importDefault(require("events"));
var SocketService = /** @class */ (function (_super) {
    __extends(SocketService, _super);
    function SocketService(io) {
        var _this = _super.call(this) || this;
        _this.io = io;
        return _this;
    }
    SocketService.prototype.register = function (socket) {
        this.emit('connected', socket);
    };
    return SocketService;
}(events_1["default"]));
exports.SocketService = SocketService;
//# sourceMappingURL=SocketService.js.map