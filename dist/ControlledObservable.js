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
var Observable_1 = require("./Observable");
/**
 * new ControlledObservable(function(), function(function onNext, function onError, function onComplete) observable) -> Observable
 */
var ControlledObservable = /** @class */ (function (_super) {
    __extends(ControlledObservable, _super);
    function ControlledObservable(controller, fn) {
        var _this = _super.call(this, fn) || this;
        _this.setController(controller);
        return _this;
    }
    ControlledObservable.prototype.getController = function () {
        return this._onController;
    };
    ControlledObservable.prototype.setController = function (controller) {
        this._onController = controller;
        return this;
    };
    return ControlledObservable;
}(Observable_1["default"]));
exports["default"] = ControlledObservable;
//# sourceMappingURL=ControlledObservable.js.map