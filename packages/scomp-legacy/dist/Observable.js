"use strict";
/**
 * new Observable(function(function onNext, function onError, function onComplete) observable) -> Observable
 */
exports.__esModule = true;
var Observable = /** @class */ (function () {
    function Observable(fn) {
        this.controller = null;
        fn(this.next.bind(this), this.error.bind(this), this.complete.bind(this));
    }
    Observable.prototype.unsubscribe = function () {
        if (this._onUnsubscribe) {
            this._onUnsubscribe();
        }
    };
    Observable.prototype.isUnsubscribed = function () {
        return true;
    };
    Observable.prototype.next = function (nextResponse) {
        if (this._onNextListener) {
            this._onNextListener(nextResponse);
        }
    };
    Observable.prototype.error = function (errorResponse) {
        if (this._onErrorListener) {
            this._onErrorListener(errorResponse);
        }
    };
    Observable.prototype.complete = function (completeResponse) {
        if (this._onCompleteListener) {
            this._onCompleteListener(completeResponse);
        }
    };
    Observable.prototype.onNext = function (fn) {
        this._onNextListener = fn;
        return this;
    };
    Observable.prototype.onError = function (fn) {
        this._onErrorListener = fn;
        return this;
    };
    Observable.prototype.onComplete = function (fn) {
        this._onCompleteListener = fn;
        return this;
    };
    Observable.prototype.onUnsubscribe = function (fn) {
        this._onUnsubscribe = fn;
        return this;
    };
    return Observable;
}());
exports["default"] = Observable;
//# sourceMappingURL=Observable.js.map