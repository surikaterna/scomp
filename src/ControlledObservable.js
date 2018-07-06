import Observable from './Observable';

/**
 * new ControlledObservable(function(), function(function onNext, function onError, function onComplete) observable) -> Observable
 */
export default class ControlledObservable extends Observable {
  constructor(controller, fn) {
    super(fn);
    this.setController(controller);
  }

  getController() {
    return this._onController;
  }

  setController(controller) {
    this._onController = controller;
    return this;
  }
}
